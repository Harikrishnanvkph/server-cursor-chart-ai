import { supabaseAdminClient } from '../supabase/client.js';
import crypto from 'crypto';

export const FREE_BASELINE = {
  monthlyFreeAiCredits: 10,
  permanentCloudCredits: 5,
  firstAiPurchaseCloudBonus: 5,
};

export const CREDIT_PACKS = {
  ai_lite: {
    id: 'ai_lite',
    category: 'ai',
    name: 'AI Lite',
    displayName: 'Lite User',
    badge: 'lite',
    priceUsd: 2,
    priceInr: 99,
    aiCredits: 30,
    cloudCredits: 0,
    firstPaymentCloudBonus: 5,
    validityMonths: null, // Never expires
    description: '+30 AI credits (Never Expire) + 5 Cloud Save credits on first AI purchase',
  },
  ai_pro: {
    id: 'ai_pro',
    category: 'ai',
    name: 'AI Pro',
    displayName: 'Pro User',
    badge: 'pro',
    priceUsd: 5,
    priceInr: 249,
    aiCredits: 100,
    cloudCredits: 0,
    firstPaymentCloudBonus: 5,
    validityMonths: null, // Never expires
    description: '+100 AI credits (Never Expire) + 5 Cloud Save credits on first AI purchase',
  },
  cloud_lite: {
    id: 'cloud_lite',
    category: 'cloud',
    name: 'Cloud Lite',
    displayName: 'Lite User',
    badge: 'lite',
    priceUsd: 2,
    priceInr: 99,
    aiCredits: 0,
    cloudCredits: 10,
    firstPaymentCloudBonus: 0,
    validityMonths: 2, // Valid for 2 months
    description: '+10 Cloud Save credits for 2 months',
  },
  cloud_pro: {
    id: 'cloud_pro',
    category: 'cloud',
    name: 'Cloud Pro',
    displayName: 'Pro User',
    badge: 'pro',
    priceUsd: 5,
    priceInr: 249,
    aiCredits: 0,
    cloudCredits: 15,
    firstPaymentCloudBonus: 0,
    validityMonths: 6, // Valid for 6 months
    description: '+15 Cloud Save credits for 6 months',
  },
};

// Retained for backward compatibility with any legacy imports
export const TIER_CONFIG = {
  free: {
    name: 'Free',
    priceMonthly: 0,
    aiCreditsLimit: FREE_BASELINE.monthlyFreeAiCredits,
    cloudChartsLimit: FREE_BASELINE.permanentCloudCredits,
  },
  lite: {
    name: 'Lite',
    priceMonthly: 2,
    aiCreditsLimit: 40,
    cloudChartsLimit: 10,
  },
  pro: {
    name: 'Pro',
    priceMonthly: 5,
    aiCreditsLimit: 110,
    cloudChartsLimit: 10,
  },
  enterprise: {
    name: 'Enterprise',
    priceMonthly: 49,
    aiCreditsLimit: 1000,
    cloudChartsLimit: 1000,
  },
};

/**
 * Helper to add calendar months to a Date
 */
function addMonths(date, months) {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * Tracks whether the extended columns on `profiles` (`purchased_ai_credits`,
 * `permanent_cloud_credits`, `first_ai_bonus_claimed`) and `cloud_credit_grants`
 * table have been migrated in Supabase yet. If not, we transparently persist
 * the user's pack wallet state in `payment_transactions` (`gateway = 'wallet_state'`)
 * so all credit features work before and after running the SQL migration.
 */
let hasExtendedProfileColumns = null;

async function readUserWalletState(userId, profile) {
  // 1. Try native columns if not known to be missing
  if (hasExtendedProfileColumns !== false) {
    const { data: extProfile, error: extErr } = await supabaseAdminClient
      .from('profiles')
      .select('purchased_ai_credits, permanent_cloud_credits, first_ai_bonus_claimed')
      .eq('id', userId)
      .maybeSingle();

    if (!extErr && extProfile) {
      hasExtendedProfileColumns = true;
      const { data: grants } = await supabaseAdminClient
        .from('cloud_credit_grants')
        .select('id, pack_id, credits_amount, purchased_at, expires_at, transaction_id')
        .eq('user_id', userId)
        .gt('expires_at', new Date().toISOString())
        .order('expires_at', { ascending: true });

      return {
        mode: 'native',
        purchased_ai_credits: Math.max(0, extProfile.purchased_ai_credits ?? 0),
        total_purchased_ai_credits: 0,
        permanent_cloud_credits: Math.max(
          FREE_BASELINE.permanentCloudCredits,
          extProfile.permanent_cloud_credits ?? FREE_BASELINE.permanentCloudCredits
        ),
        first_ai_bonus_claimed: Boolean(extProfile.first_ai_bonus_claimed),
        cloud_grants: Array.isArray(grants) ? grants : [],
        fulfilled_orders: [],
      };
    }

    if (extErr && (extErr.code === '42703' || String(extErr.message).includes('does not exist'))) {
      hasExtendedProfileColumns = false;
    }
  }

  // 2. Fallback: read per-user wallet_state row in payment_transactions
  const { data: walletRows } = await supabaseAdminClient
    .from('payment_transactions')
    .select('id, metadata')
    .eq('user_id', userId)
    .eq('gateway', 'wallet_state')
    .order('created_at', { ascending: false })
    .limit(1);

  const walletRow = walletRows && walletRows[0] ? walletRows[0] : null;
  const meta = walletRow?.metadata || {};
  const nowIso = new Date().toISOString();
  const activeGrants = Array.isArray(meta.cloud_grants)
    ? meta.cloud_grants.filter((g) => g && g.expires_at && g.expires_at > nowIso)
    : [];

  return {
    mode: 'fallback',
    walletRowId: walletRow?.id || null,
    purchased_ai_credits: Math.max(0, Number(meta.purchased_ai_credits) || 0),
    total_purchased_ai_credits: Math.max(0, Number(meta.total_purchased_ai_credits) || 0),
    permanent_cloud_credits: Math.max(
      FREE_BASELINE.permanentCloudCredits,
      Number(meta.permanent_cloud_credits) || FREE_BASELINE.permanentCloudCredits
    ),
    first_ai_bonus_claimed: Boolean(meta.first_ai_bonus_claimed),
    cloud_grants: activeGrants,
    fulfilled_orders: Array.isArray(meta.fulfilled_orders) ? meta.fulfilled_orders : [],
  };
}

async function writeUserWalletState(userId, walletState) {
  const nowIso = new Date().toISOString();
  const activeGrants = (walletState.cloud_grants || []).filter(
    (g) => g && g.expires_at && g.expires_at > nowIso
  );
  const bonusCloudSum = activeGrants.reduce((sum, g) => sum + (Number(g.credits_amount) || 0), 0);
  const effectiveCloudLimit = walletState.permanent_cloud_credits + bonusCloudSum;

  if (walletState.mode === 'native') {
    await supabaseAdminClient
      .from('profiles')
      .update({
        purchased_ai_credits: walletState.purchased_ai_credits,
        permanent_cloud_credits: walletState.permanent_cloud_credits,
        first_ai_bonus_claimed: walletState.first_ai_bonus_claimed,
        cloud_charts_limit: effectiveCloudLimit,
      })
      .eq('id', userId);
    return;
  }

  // Fallback mode: persist in payment_transactions (gateway = 'wallet_state') + sync cloud_charts_limit on profiles
  const metadataPayload = {
    purchased_ai_credits: walletState.purchased_ai_credits,
    total_purchased_ai_credits: walletState.total_purchased_ai_credits || 0,
    permanent_cloud_credits: walletState.permanent_cloud_credits,
    first_ai_bonus_claimed: walletState.first_ai_bonus_claimed,
    cloud_grants: activeGrants,
    fulfilled_orders: walletState.fulfilled_orders || [],
    updated_at: nowIso,
  };

  if (walletState.walletRowId) {
    await supabaseAdminClient
      .from('payment_transactions')
      .update({
        metadata: metadataPayload,
        updated_at: nowIso,
      })
      .eq('id', walletState.walletRowId);
  } else {
    await supabaseAdminClient.from('payment_transactions').insert({
      user_id: userId,
      gateway: 'wallet_state',
      amount: 0,
      currency: 'USD',
      plan_tier: 'free',
      billing_cycle: 'one_time',
      status: 'active',
      metadata: metadataPayload,
    });
  }

  await supabaseAdminClient
    .from('profiles')
    .update({
      cloud_charts_limit: effectiveCloudLimit,
    })
    .eq('id', userId);
}

/**
 * Get subscription and credit breakdown for a user with auto-monthly-reset for free AI credits
 */
export async function getUserSubscription(userId) {
  if (!userId) return null;

  try {
    // Run profile query, saved-chart count, wallet state lookup, and completed orders concurrently
    const [
      { data: profile, error: profileErr },
      { count: savedCount },
      walletState,
      { data: completedTx }
    ] = await Promise.all([
      supabaseAdminClient
        .from('profiles')
        .select('is_admin, subscription_tier, ai_credits_used, ai_credits_limit, cloud_charts_limit, credits_reset_at')
        .eq('id', userId)
        .single(),
      supabaseAdminClient
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_active', true),
      readUserWalletState(userId),
      supabaseAdminClient
        .from('payment_transactions')
        .select('pack_id, metadata, created_at')
        .eq('user_id', userId)
        .eq('status', 'completed')
    ]);

    if (profileErr || !profile) {
      console.warn('Could not fetch profile for subscription info, using defaults:', profileErr?.message);
      return {
        subscription_tier: 'free',
        free_ai_credits_used: 0,
        free_ai_credits_limit: FREE_BASELINE.monthlyFreeAiCredits,
        free_ai_credits_remaining: FREE_BASELINE.monthlyFreeAiCredits,
        purchased_ai_credits: 0,
        ai_credits_used: 0,
        ai_credits_limit: FREE_BASELINE.monthlyFreeAiCredits,
        ai_credits_remaining: FREE_BASELINE.monthlyFreeAiCredits,
        permanent_cloud_credits: FREE_BASELINE.permanentCloudCredits,
        bonus_cloud_credits: 0,
        active_cloud_grants: [],
        cloud_charts_limit: FREE_BASELINE.permanentCloudCredits,
        saved_charts_count: 0,
        cloud_charts_remaining: FREE_BASELINE.permanentCloudCredits,
        first_ai_bonus_claimed: false,
        credits_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    const freeAiLimit = FREE_BASELINE.monthlyFreeAiCredits; // Always 10/month
    let freeAiUsed = Math.min(freeAiLimit, Math.max(0, profile.ai_credits_used ?? 0));
    let resetAt = profile.credits_reset_at
      ? new Date(profile.credits_reset_at)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Check 30-day auto-reset for Monthly Free AI Credits
    const now = new Date();
    if (resetAt <= now) {
      const nextReset = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      freeAiUsed = 0;
      resetAt = nextReset;

      await supabaseAdminClient
        .from('profiles')
        .update({
          ai_credits_used: 0,
          ai_credits_limit: freeAiLimit,
          credits_reset_at: nextReset.toISOString(),
        })
        .eq('id', userId);
    }

    const freeAiRemaining = Math.max(0, freeAiLimit - freeAiUsed);
    const purchasedAiCredits = walletState.purchased_ai_credits;
    const totalAiRemaining = freeAiRemaining + purchasedAiCredits;

    // Calculate total purchased AI credits ever granted across all completed orders
    let totalPurchasedAiGranted = walletState.total_purchased_ai_credits || 0;
    if (Array.isArray(completedTx) && completedTx.length > 0) {
      let txPurchasedSum = 0;
      for (const tx of completedTx) {
        const pId = tx.pack_id || tx.metadata?.packId;
        if (pId === 'ai_lite') {
          const isLegacy15 = tx.metadata?.aiCredits === 15 || (new Date(tx.created_at || 0) < new Date('2026-11-09T15:00:00Z') && tx.metadata?.aiCredits !== 30);
          txPurchasedSum += isLegacy15 ? 15 : CREDIT_PACKS.ai_lite.aiCredits;
        } else if (pId === 'ai_pro') {
          const isLegacy60 = tx.metadata?.aiCredits === 60 || (new Date(tx.created_at || 0) < new Date('2026-11-09T15:00:00Z') && tx.metadata?.aiCredits !== 100);
          txPurchasedSum += isLegacy60 ? 60 : CREDIT_PACKS.ai_pro.aiCredits;
        }
      }
      totalPurchasedAiGranted = Math.max(totalPurchasedAiGranted, txPurchasedSum);
    }

    const tier = profile.subscription_tier || 'free';
    const tierConfigLimit = TIER_CONFIG[tier]?.aiCreditsLimit || freeAiLimit;

    // Total AI limit is Free Monthly Allowance (10) + Total Purchased Credits Ever Granted
    // It NEVER shrinks as credits are consumed!
    const totalAiLimit = Math.max(
      totalPurchasedAiGranted > 0 ? (freeAiLimit + totalPurchasedAiGranted) : tierConfigLimit,
      totalAiRemaining
    );

    const permanentCloudCredits = walletState.permanent_cloud_credits;
    const activeCloudGrants = walletState.cloud_grants || [];
    const bonusCloudCredits = activeCloudGrants.reduce(
      (sum, g) => sum + (Number(g.credits_amount) || 0),
      0
    );
    const totalCloudLimit = permanentCloudCredits + bonusCloudCredits;
    const activeSavedCount = savedCount || 0;

    // Sync profile's limits if drifted
    if (profile.cloud_charts_limit !== totalCloudLimit || profile.ai_credits_limit !== totalAiLimit) {
      supabaseAdminClient
        .from('profiles')
        .update({
          cloud_charts_limit: totalCloudLimit,
          ai_credits_limit: totalAiLimit,
        })
        .eq('id', userId)
        .then(() => {})
        .catch(() => {});
    }

    return {
      is_admin: profile.is_admin || false,
      subscription_tier: tier,
      // Monthly Free AI Credits (10/month)
      free_ai_credits_used: freeAiUsed,
      free_ai_credits_limit: freeAiLimit,
      free_ai_credits_remaining: freeAiRemaining,
      // Never-Expiring Purchased AI Credits
      purchased_ai_credits: purchasedAiCredits,
      // Combined AI totals for backward compatibility
      ai_credits_used: freeAiUsed,
      ai_credits_limit: totalAiLimit,
      ai_credits_remaining: totalAiRemaining,
      // Cloud Save Credits (Permanent + Expiring)
      permanent_cloud_credits: permanentCloudCredits,
      bonus_cloud_credits: bonusCloudCredits,
      active_cloud_grants: activeCloudGrants,
      cloud_charts_limit: totalCloudLimit,
      saved_charts_count: activeSavedCount,
      cloud_charts_remaining: Math.max(0, totalCloudLimit - activeSavedCount),
      first_ai_bonus_claimed: walletState.first_ai_bonus_claimed,
      credits_reset_at: resetAt.toISOString(),
    };
  } catch (error) {
    console.error('Error in getUserSubscription:', error);
    return {
      subscription_tier: 'free',
      free_ai_credits_used: 0,
      free_ai_credits_limit: FREE_BASELINE.monthlyFreeAiCredits,
      free_ai_credits_remaining: FREE_BASELINE.monthlyFreeAiCredits,
      purchased_ai_credits: 0,
      ai_credits_used: 0,
      ai_credits_limit: FREE_BASELINE.monthlyFreeAiCredits,
      ai_credits_remaining: FREE_BASELINE.monthlyFreeAiCredits,
      permanent_cloud_credits: FREE_BASELINE.permanentCloudCredits,
      bonus_cloud_credits: 0,
      active_cloud_grants: [],
      cloud_charts_limit: FREE_BASELINE.permanentCloudCredits,
      saved_charts_count: 0,
      cloud_charts_remaining: FREE_BASELINE.permanentCloudCredits,
      first_ai_bonus_claimed: false,
      credits_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }
}

/**
 * Check whether user has sufficient AI credits to make a request
 * @param {string} userId
 * @param {number} requiredCredits - 1 for chart mode, 2 for template mode
 */
export async function canConsumeAiCredit(userId, requiredCredits = 1) {
  const sub = await getUserSubscription(userId);
  if (!sub) {
    return { allowed: false, error: 'User not found' };
  }

  if (sub.ai_credits_remaining < requiredCredits) {
    return {
      allowed: false,
      subscription: sub,
      requiredCredits,
      error: requiredCredits > 1
        ? `Template mode requires ${requiredCredits} AI credits, but you have ${sub.ai_credits_remaining} remaining. Top up your AI credits to continue.`
        : 'You have used all your AI credits. Purchase an AI Credits pack ($2 Lite or $5 Pro) to continue generating charts.',
    };
  }

  return { allowed: true, subscription: sub };
}

/**
 * Deduct AI credits (1 for chart mode, 2 for template mode):
 * Priority 1: Monthly Free AI Credits (10/month)
 * Priority 2: Purchased AI Credits (Never Expire)
 * Supports multi-credit deductions across free and purchased pools.
 * Returns the updated subscription state along with `deducted_amount`, `deducted_free`, `deducted_purchased`, and `deducted_bucket`.
 * @param {string} userId
 * @param {number} amount - Credits to deduct (default 1)
 */
export async function deductAiCredit(userId, amount = 1) {
  try {
    const sub = await getUserSubscription(userId);
    if (!sub) return null;

    if (sub.ai_credits_remaining < amount) {
      return {
        ...sub,
        success: false,
        exhausted: true,
        requiredCredits: amount,
        deducted_bucket: 'none',
      };
    }

    const freeAvailable = sub.free_ai_credits_remaining || 0;
    const freeToDeduct = Math.min(amount, freeAvailable);
    const purchasedToDeduct = amount - freeToDeduct;

    // Deduct free credits from profile if any
    if (freeToDeduct > 0) {
      const nextUsed = sub.free_ai_credits_used + freeToDeduct;
      const { error } = await supabaseAdminClient
        .from('profiles')
        .update({ ai_credits_used: nextUsed })
        .eq('id', userId);

      if (error) {
        console.error('Failed to deduct free AI credit:', error.message);
        return null;
      }
    }

    // Deduct purchased credits from wallet state if any
    if (purchasedToDeduct > 0) {
      const walletState = await readUserWalletState(userId);
      walletState.purchased_ai_credits = Math.max(0, (walletState.purchased_ai_credits || 0) - purchasedToDeduct);
      await writeUserWalletState(userId, walletState);
    }

    const updated = await getUserSubscription(userId);
    const bucket =
      freeToDeduct > 0 && purchasedToDeduct > 0
        ? 'split'
        : freeToDeduct > 0
        ? 'free'
        : 'purchased';

    return {
      ...updated,
      success: true,
      deducted_amount: amount,
      deducted_free: freeToDeduct,
      deducted_purchased: purchasedToDeduct,
      deducted_bucket: bucket,
    };
  } catch (error) {
    console.error('Error deducting AI credit:', error);
    return null;
  }
}

/**
 * Refund AI credits when an upstream AI generation fails or is aborted.
 * Refunds back to the exact bucket ('free' or 'purchased') that was deducted.
 * Supports refunding breakdown object { free, purchased } or legacy bucket string.
 * @param {string} userId
 * @param {string | { free?: number, purchased?: number, amount?: number, bucket?: string }} details
 */
export async function refundAiCredit(userId, details = 'free') {
  if (!userId) return null;
  try {
    let freeToRefund = 0;
    let purchasedToRefund = 0;

    if (typeof details === 'string') {
      if (details === 'purchased') {
        purchasedToRefund = 1;
      } else {
        freeToRefund = 1;
      }
    } else if (typeof details === 'object' && details !== null) {
      freeToRefund = Number(details.free) || 0;
      purchasedToRefund = Number(details.purchased) || 0;
      if (freeToRefund === 0 && purchasedToRefund === 0) {
        if (details.bucket === 'purchased') {
          purchasedToRefund = Number(details.amount) || 1;
        } else {
          freeToRefund = Number(details.amount) || 1;
        }
      }
    }

    if (purchasedToRefund > 0) {
      const walletState = await readUserWalletState(userId);
      walletState.purchased_ai_credits = (walletState.purchased_ai_credits || 0) + purchasedToRefund;
      await writeUserWalletState(userId, walletState);
    }

    if (freeToRefund > 0) {
      const { data: profile, error } = await supabaseAdminClient
        .from('profiles')
        .select('ai_credits_used')
        .eq('id', userId)
        .single();

      if (!error && profile) {
        const currentUsed = profile.ai_credits_used ?? 0;
        await supabaseAdminClient
          .from('profiles')
          .update({ ai_credits_used: Math.max(0, currentUsed - freeToRefund) })
          .eq('id', userId);
      }
    }

    return await getUserSubscription(userId);
  } catch (err) {
    console.error('Error in refundAiCredit:', err);
    return null;
  }
}

/**
 * Check whether user can save another cloud chart conversation
 */
export async function canSaveCloudChart(userId) {
  const sub = await getUserSubscription(userId);
  if (!sub) {
    return { allowed: false, error: 'User not found' };
  }

  if (sub.saved_charts_count >= sub.cloud_charts_limit) {
    return {
      allowed: false,
      subscription: sub,
      error: `Cloud save limit reached (${sub.saved_charts_count}/${sub.cloud_charts_limit} saved charts). Purchase a Cloud Credits pack ($2 for +10 saves or $5 for +15 saves) or delete unused charts in your Board.`,
    };
  }

  return { allowed: true, subscription: sub };
}

/**
 * Fulfill a one-time Credit Pack purchase ('ai_lite' | 'ai_pro' | 'cloud_lite' | 'cloud_pro')
 * Idempotent by orderId / paymentId so webhook + client verification never double-grant.
 */
export async function fulfillCreditPackPurchase({
  userId,
  packId = 'ai_pro',
  orderId = null,
  paymentId = null,
  transactionId = null,
  gateway = 'dodo',
  countryCode = 'GLOBAL',
  currency = 'USD',
}) {
  const normalizedPackId = CREDIT_PACKS[packId] ? packId : 'ai_pro';
  const pack = CREDIT_PACKS[normalizedPackId];
  const idempotencyKey = orderId || paymentId || transactionId || `tx_${Date.now()}`;

  const walletState = await readUserWalletState(userId);

  // Idempotency guard: if this order was already fulfilled, return current subscription without double-adding
  if (idempotencyKey && walletState.fulfilled_orders?.includes(idempotencyKey)) {
    const existingSub = await getUserSubscription(userId);
    return {
      ...existingSub,
      alreadyFulfilled: true,
      packId: normalizedPackId,
    };
  }

  let aiCreditsAdded = 0;
  let permanentCloudBonusAdded = 0;
  let temporaryCloudCreditsAdded = 0;
  let expiresAtIso = null;

  if (pack.category === 'ai') {
    // 1. Add never-expiring AI credits (+30 for Lite, +100 for Pro)
    aiCreditsAdded = pack.aiCredits;
    walletState.purchased_ai_credits = (walletState.purchased_ai_credits || 0) + aiCreditsAdded;
    walletState.total_purchased_ai_credits = (walletState.total_purchased_ai_credits || 0) + aiCreditsAdded;

    // 2. Grant +5 permanent cloud save credits ONLY on the user's very first AI pack purchase
    if (!walletState.first_ai_bonus_claimed) {
      permanentCloudBonusAdded = FREE_BASELINE.firstAiPurchaseCloudBonus; // +5
      walletState.permanent_cloud_credits =
        FREE_BASELINE.permanentCloudCredits + permanentCloudBonusAdded; // 5 + 5 = 10
      walletState.first_ai_bonus_claimed = true;
    }
  } else if (pack.category === 'cloud') {
    // Time-limited cloud save credits (+10 for 2 months, +15 for 6 months)
    temporaryCloudCreditsAdded = pack.cloudCredits;
    const now = new Date();
    const expiresAt = addMonths(now, pack.validityMonths || 2);
    expiresAtIso = expiresAt.toISOString();

    const newGrant = {
      id: crypto.randomUUID(),
      pack_id: normalizedPackId,
      credits_amount: temporaryCloudCreditsAdded,
      purchased_at: now.toISOString(),
      expires_at: expiresAtIso,
      transaction_id: transactionId || null,
    };

    if (walletState.mode === 'native') {
      const { error: grantErr } = await supabaseAdminClient
        .from('cloud_credit_grants')
        .insert({
          user_id: userId,
          pack_id: normalizedPackId,
          credits_amount: temporaryCloudCreditsAdded,
          purchased_at: newGrant.purchased_at,
          expires_at: newGrant.expires_at,
          transaction_id: transactionId || null,
        });
      if (grantErr) {
        console.warn('Could not insert into cloud_credit_grants, falling back:', grantErr.message);
      }
    }

    walletState.cloud_grants = [...(walletState.cloud_grants || []), newGrant];
  }

  // Record idempotency key (keep last 50 order IDs)
  walletState.fulfilled_orders = [
    ...(walletState.fulfilled_orders || []).slice(-49),
    idempotencyKey,
  ];

  await writeUserWalletState(userId, walletState);

  // Update profile tier badge ('pro' stays 'pro' if they already bought a Pro pack)
  const { data: currentProfile } = await supabaseAdminClient
    .from('profiles')
    .select('subscription_tier')
    .eq('id', userId)
    .maybeSingle();

  const nextBadge =
    currentProfile?.subscription_tier === 'pro' || pack.badge === 'pro' ? 'pro' : 'lite';

  await supabaseAdminClient
    .from('profiles')
    .update({
      subscription_tier: nextBadge,
      payment_gateway: gateway,
      country_code: countryCode,
      billing_currency: currency,
      subscription_status: 'active',
    })
    .eq('id', userId);

  const updatedSub = await getUserSubscription(userId);
  return {
    ...updatedSub,
    packId: normalizedPackId,
    packName: pack.name,
    grantSummary: {
      packId: normalizedPackId,
      aiCreditsAdded,
      permanentCloudBonusAdded,
      temporaryCloudCreditsAdded,
      expiresAt: expiresAtIso,
    },
  };
}

/**
 * Reset or set user subscription tier (used by dev/admin endpoints)
 */
export async function setSubscriptionTier(userId, newTierOrPack) {
  const target = (newTierOrPack || 'free').toLowerCase();

  // If a specific pack ID is passed, fulfill that pack
  if (CREDIT_PACKS[target]) {
    return await fulfillCreditPackPurchase({
      userId,
      packId: target,
      gateway: 'admin_manual',
    });
  }

  if (target === 'pro') {
    return await fulfillCreditPackPurchase({
      userId,
      packId: 'ai_pro',
      gateway: 'admin_manual',
    });
  }

  // Reset user to Free baseline (10 monthly AI credits, 5 permanent cloud credits, 0 purchased)
  const walletState = await readUserWalletState(userId);
  walletState.purchased_ai_credits = 0;
  walletState.permanent_cloud_credits = FREE_BASELINE.permanentCloudCredits;
  walletState.first_ai_bonus_claimed = false;
  walletState.cloud_grants = [];
  walletState.fulfilled_orders = [];
  await writeUserWalletState(userId, walletState);

  if (walletState.mode === 'native') {
    await supabaseAdminClient.from('cloud_credit_grants').delete().eq('user_id', userId);
  }

  const nextReset = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabaseAdminClient
    .from('profiles')
    .update({
      subscription_tier: 'free',
      ai_credits_used: 0,
      ai_credits_limit: FREE_BASELINE.monthlyFreeAiCredits,
      cloud_charts_limit: FREE_BASELINE.permanentCloudCredits,
      credits_reset_at: nextReset,
    })
    .eq('id', userId);

  const updatedSub = await getUserSubscription(userId);
  if (updatedSub && updatedSub.saved_charts_count > updatedSub.cloud_charts_limit) {
    updatedSub.over_limit_charts = updatedSub.saved_charts_count - updatedSub.cloud_charts_limit;
  }

  return updatedSub;
}
