import { supabaseAdminClient } from '../supabase/client.js';
import { resolveLocationContext } from './geoService.js';
import { CREDIT_PACKS, fulfillCreditPackPurchase } from './subscriptionService.js';

// Derived from CREDIT_PACKS single source of truth for backward compatibility
export const PAYMENT_PLANS = Object.fromEntries(
  Object.entries(CREDIT_PACKS).map(([id, pack]) => [
    id,
    {
      id: pack.id,
      category: pack.category,
      name: pack.name,
      displayName: pack.displayName,
      description: pack.description,
      pricing: {
        USD: { currency: 'USD', symbol: '$', oneTime: pack.priceUsd },
        INR: { currency: 'INR', symbol: '₹', oneTime: pack.priceInr },
      },
    },
  ])
);

/**
 * Normalize packId from either explicit packId or legacy planTier
 */
export function resolvePackId(packId, planTier = 'pro') {
  if (packId && CREDIT_PACKS[packId]) {
    return packId;
  }
  if (planTier && CREDIT_PACKS[planTier]) {
    return planTier;
  }
  if (planTier === 'lite') return 'ai_lite';
  return 'ai_pro';
}

/**
 * Determine pricing and gateway details for a credit pack (USD globally via Dodo, INR 99/249 for India via Razorpay)
 */
export function getPlanPricingAndGateway({
  packId = null,
  planTier = 'pro',
  billingCycle = 'one_time',
  region = 'GLOBAL',
}) {
  const resolvedPackId = resolvePackId(packId, planTier);
  const pack = CREDIT_PACKS[resolvedPackId] || CREDIT_PACKS.ai_pro;
  const location = resolveLocationContext(region);
  const isIndia = location.isIndia;
  const gateway = isIndia ? 'razorpay' : 'dodo';
  const currency = isIndia ? 'INR' : 'USD';
  const currencySymbol = isIndia ? '₹' : '$';
  const amount = isIndia ? (pack.priceInr || (pack.priceUsd === 2 ? 99 : 249)) : pack.priceUsd;

  return {
    packId: resolvedPackId,
    planTier: pack.badge || 'pro',
    planName: pack.name,
    billingCycle: 'one_time',
    region: location.countryCode || 'GLOBAL',
    isIndia,
    gateway,
    currency,
    currencySymbol,
    amount,
  };
}

/**
 * Record a transaction in payment_transactions table
 */
export async function recordPaymentTransaction({
  userId,
  gateway,
  gatewayOrderId = null,
  gatewayPaymentId = null,
  gatewaySubscriptionId = null,
  amount,
  currency = 'USD',
  packId = 'ai_pro',
  planTier = 'pro',
  billingCycle = 'one_time',
  status = 'pending',
  customerEmail = null,
  customerCountry = null,
  metadata = {},
}) {
  try {
    const resolvedPackId = resolvePackId(packId, planTier);
    const { data, error } = await supabaseAdminClient
      .from('payment_transactions')
      .insert({
        user_id: userId,
        gateway,
        gateway_order_id: gatewayOrderId,
        gateway_payment_id: gatewayPaymentId,
        gateway_subscription_id: gatewaySubscriptionId,
        amount,
        currency,
        pack_id: resolvedPackId,
        plan_tier: planTier || resolvedPackId,
        billing_cycle: billingCycle || 'one_time',
        status,
        customer_email: customerEmail,
        customer_country: customerCountry,
        metadata: {
          ...metadata,
          packId: resolvedPackId,
        },
      })
      .select()
      .single();

    if (error) {
      console.warn('Could not record payment transaction to Supabase:', error.message);
      return { id: 'temp_' + Date.now(), status };
    }

    return data;
  } catch (err) {
    console.error('Error recording payment transaction:', err);
    return { id: 'temp_' + Date.now(), status };
  }
}

/**
 * Update payment transaction status
 */
export async function updatePaymentTransaction(identifier, updates) {
  try {
    let query = supabaseAdminClient.from('payment_transactions').update({
      ...updates,
      updated_at: new Date().toISOString(),
    });

    if (updates.id) {
      query = query.eq('id', updates.id);
    } else if (identifier.gatewayOrderId) {
      query = query.eq('gateway_order_id', identifier.gatewayOrderId);
    } else if (identifier.gatewayPaymentId) {
      query = query.eq('gateway_payment_id', identifier.gatewayPaymentId);
    }

    if (identifier.userId) {
      query = query.eq('user_id', identifier.userId);
    }

    const { data, error } = await query.select();
    if (error) {
      console.warn('Could not update payment transaction in Supabase:', error.message);
    }
    return data;
  } catch (err) {
    console.error('Error updating payment transaction:', err);
  }
}

/**
 * Fulfill credit pack purchase upon successful payment
 */
export async function fulfillSubscriptionUpgrade({
  userId,
  packId = null,
  tier = 'pro',
  gateway = 'dodo',
  gatewayCustomerId = null,
  gatewaySubscriptionId = null,
  orderId = null,
  paymentId = null,
  transactionId = null,
  countryCode = 'GLOBAL',
  currency = 'USD',
}) {
  const resolvedPackId = resolvePackId(packId, tier);
  return await fulfillCreditPackPurchase({
    userId,
    packId: resolvedPackId,
    orderId: orderId || gatewaySubscriptionId,
    paymentId,
    transactionId,
    gateway,
    countryCode,
    currency,
  });
}
