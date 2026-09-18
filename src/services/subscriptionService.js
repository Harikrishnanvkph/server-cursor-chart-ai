import { supabaseAdminClient } from '../supabase/client.js';

export const TIER_CONFIG = {
  free: {
    name: 'Free',
    priceMonthly: 0,
    aiCreditsLimit: 10,
    cloudChartsLimit: 10,
  },
  pro: {
    name: 'Pro',
    priceMonthly: 5,
    aiCreditsLimit: 50,
    cloudChartsLimit: 30,
  },
  // FUTURE: Enterprise tier is defined for forward compatibility but has no UI,
  // pricing page, or upgrade endpoint yet. Do not remove.
  enterprise: {
    name: 'Enterprise',
    priceMonthly: 49,
    aiCreditsLimit: 1000,
    cloudChartsLimit: 1000,
  }
};

/**
 * Get subscription and usage details for a user with auto-monthly-reset
 */
export async function getUserSubscription(userId) {
  if (!userId) return null;

  try {
    // 1. Fetch profile
    const { data: profile, error: profileErr } = await supabaseAdminClient
      .from('profiles')
      .select('is_admin, subscription_tier, ai_credits_used, ai_credits_limit, cloud_charts_limit, credits_reset_at')
      .eq('id', userId)
      .single();

    if (profileErr || !profile) {
      console.warn('Could not fetch profile for subscription info, using defaults:', profileErr?.message);
      return {
        subscription_tier: 'free',
        ai_credits_used: 0,
        ai_credits_limit: TIER_CONFIG.free.aiCreditsLimit,
        ai_credits_remaining: TIER_CONFIG.free.aiCreditsLimit,
        cloud_charts_limit: TIER_CONFIG.free.cloudChartsLimit,
        saved_charts_count: 0,
        credits_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      };
    }

    let tier = profile.subscription_tier || 'free';
    if (!TIER_CONFIG[tier]) tier = 'free';

    const config = TIER_CONFIG[tier];
    let creditsUsed = profile.ai_credits_used ?? 0;
    let creditsLimit = profile.ai_credits_limit ?? config.aiCreditsLimit;
    let cloudLimit = profile.cloud_charts_limit ?? config.cloudChartsLimit;
    let resetAt = profile.credits_reset_at ? new Date(profile.credits_reset_at) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // 2. Check auto-reset: if resetAt is in the past, reset credits
    const now = new Date();
    if (resetAt <= now) {
      const nextReset = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      creditsUsed = 0;
      resetAt = nextReset;

      await supabaseAdminClient
        .from('profiles')
        .update({
          ai_credits_used: 0,
          credits_reset_at: nextReset.toISOString()
        })
        .eq('id', userId);
    }

    // 3. Count saved conversations (charts) — only active charts count toward cloud limit
    const { count: savedCount } = await supabaseAdminClient
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_active', true);

    return {
      is_admin: profile.is_admin || false,
      subscription_tier: tier,
      ai_credits_used: creditsUsed,
      ai_credits_limit: creditsLimit,
      ai_credits_remaining: Math.max(0, creditsLimit - creditsUsed),
      cloud_charts_limit: cloudLimit,
      saved_charts_count: savedCount || 0,
      credits_reset_at: resetAt.toISOString()
    };
  } catch (error) {
    console.error('Error in getUserSubscription:', error);
    return {
      subscription_tier: 'free',
      ai_credits_used: 0,
      ai_credits_limit: 10,
      ai_credits_remaining: 10,
      cloud_charts_limit: 10,
      saved_charts_count: 0,
      credits_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
  }
}

/**
 * Check whether user has sufficient AI credits to make a request
 */
export async function canConsumeAiCredit(userId) {
  const sub = await getUserSubscription(userId);
  if (!sub) {
    return { allowed: false, error: 'User not found' };
  }

  if (sub.ai_credits_remaining <= 0) {
    return {
      allowed: false,
      subscription: sub,
      error: `Monthly AI credit limit reached (${sub.ai_credits_used}/${sub.ai_credits_limit}). Upgrade to Pro for 50 credits/month.`
    };
  }

  return { allowed: true, subscription: sub };
}

/**
 * Atomically deduct 1 AI credit — uses a Postgres RPC that does
 * UPDATE ... SET ai_credits_used = ai_credits_used + 1
 * WHERE ai_credits_used < ai_credits_limit in a single statement,
 * eliminating TOCTOU race conditions under concurrent requests.
 */
export async function deductAiCredit(userId) {
  try {
    const { data, error } = await supabaseAdminClient
      .rpc('deduct_ai_credit', { p_user_id: userId })
      .single();

    if (error) {
      console.error('RPC deduct_ai_credit failed:', error);
      // Fallback: try the non-atomic path so the user isn't blocked
      const sub = await getUserSubscription(userId);
      return sub;
    }

    const used = data.out_credits_used ?? data.ai_credits_used ?? 0;
    const limit = data.out_credits_limit ?? data.ai_credits_limit ?? 10;
    const remaining = data.out_credits_remaining ?? data.ai_credits_remaining ?? Math.max(0, limit - used);

    if (!data.success) {
      // Credits exhausted — return current state with explicit failure flags
      return {
        success: false,
        exhausted: true,
        subscription_tier: 'unknown',
        ai_credits_used: used,
        ai_credits_limit: limit,
        ai_credits_remaining: remaining
      };
    }

    // Return full subscription state after successful deduction
    return await getUserSubscription(userId);
  } catch (error) {
    console.error('Error deducting AI credit:', error);
    return null;
  }
}

/**
 * Check whether user can save another chart snapshot/conversation
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
      error: `Cloud save limit reached. Your ${sub.subscription_tier === 'free' ? 'Free' : 'Pro'} plan allows up to ${sub.cloud_charts_limit} saved charts. Upgrade to Pro to save up to 30 charts, or delete unused charts in your Board.`
    };
  }

  return { allowed: true, subscription: sub };
}

/**
 * Upgrade or change user subscription tier
 */
export async function setSubscriptionTier(userId, newTier) {
  const tier = (newTier || 'free').toLowerCase();
  if (!TIER_CONFIG[tier]) {
    throw new Error(`Invalid subscription tier: ${tier}`);
  }

  const config = TIER_CONFIG[tier];
  const updateData = {
    subscription_tier: tier,
    ai_credits_limit: config.aiCreditsLimit,
    cloud_charts_limit: config.cloudChartsLimit,
  };

  // If upgrading to pro, reset credits used and give full fresh quota
  if (tier === 'pro') {
    updateData.ai_credits_used = 0;
    updateData.credits_reset_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const { error } = await supabaseAdminClient
    .from('profiles')
    .update(updateData)
    .eq('id', userId);

  if (error) {
    throw new Error(`Failed to update subscription tier: ${error.message}`);
  }

  const updatedSub = await getUserSubscription(userId);

  // Check if downgrading put the user over their new cloud chart limit
  if (updatedSub && updatedSub.saved_charts_count > updatedSub.cloud_charts_limit) {
    updatedSub.over_limit_charts = updatedSub.saved_charts_count - updatedSub.cloud_charts_limit;
  }

  return updatedSub;
}
