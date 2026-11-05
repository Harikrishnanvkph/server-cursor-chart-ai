import { supabaseAdminClient } from '../supabase/client.js';
import { resolveLocationContext } from './geoService.js';
import { CREDIT_PACKS, fulfillCreditPackPurchase } from './subscriptionService.js';

export const PAYMENT_PLANS = {
  ai_lite: {
    id: 'ai_lite',
    category: 'ai',
    name: 'AI Lite',
    displayName: 'Lite User',
    description: '+15 AI credits (Never Expire) + 5 Cloud Save credits on first AI payment.',
    pricing: {
      USD: {
        currency: 'USD',
        symbol: '$',
        oneTime: 2,
      },
      INR: {
        currency: 'INR',
        symbol: '₹',
        oneTime: 99,
      },
    },
  },
  ai_pro: {
    id: 'ai_pro',
    category: 'ai',
    name: 'AI Pro',
    displayName: 'Pro User',
    description: '+60 AI credits (Never Expire) + 5 Cloud Save credits on first AI payment.',
    pricing: {
      USD: {
        currency: 'USD',
        symbol: '$',
        oneTime: 5,
      },
      INR: {
        currency: 'INR',
        symbol: '₹',
        oneTime: 249,
      },
    },
  },
  cloud_lite: {
    id: 'cloud_lite',
    category: 'cloud',
    name: 'Cloud Lite',
    displayName: 'Lite User',
    description: '+10 Cloud Save credits valid for 2 months.',
    pricing: {
      USD: {
        currency: 'USD',
        symbol: '$',
        oneTime: 2,
      },
      INR: {
        currency: 'INR',
        symbol: '₹',
        oneTime: 99,
      },
    },
  },
  cloud_pro: {
    id: 'cloud_pro',
    category: 'cloud',
    name: 'Cloud Pro',
    displayName: 'Pro User',
    description: '+15 Cloud Save credits valid for 6 months.',
    pricing: {
      USD: {
        currency: 'USD',
        symbol: '$',
        oneTime: 5,
      },
      INR: {
        currency: 'INR',
        symbol: '₹',
        oneTime: 249,
      },
    },
  },
};

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
 * Determine pricing and gateway details for a credit pack (USD globally, INR 99/249 for India via Dodo)
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
    gateway: 'dodo',
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
