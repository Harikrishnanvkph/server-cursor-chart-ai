import { supabaseAdminClient } from '../supabase/client.js';
import { resolveLocationContext } from './geoService.js';

export const PAYMENT_PLANS = {
  pro: {
    name: 'Pro',
    description: 'Higher AI credits limit, expanded cloud saves, and vector SVG exports.',
    pricing: {
      INR: {
        currency: 'INR',
        symbol: '₹',
        monthly: 399, // ₹399 / mo
        yearly: 3990, // ₹3,990 / yr (~₹332 / mo, save ~17%)
      },
      USD: {
        currency: 'USD',
        symbol: '$',
        monthly: 5,   // $5 / mo
        yearly: 48,  // $48 / yr ($4 / mo, save 20%)
      }
    }
  }
};

/**
 * Determine pricing and gateway details based on selected region & plan
 */
export function getPlanPricingAndGateway({ planTier = 'pro', billingCycle = 'monthly', region = 'GLOBAL' }) {
  const plan = PAYMENT_PLANS[planTier] || PAYMENT_PLANS.pro;
  const location = resolveLocationContext(region);
  const currency = location.currency;
  const priceConfig = plan.pricing[currency] || plan.pricing.USD;
  const rawAmount = billingCycle === 'yearly' ? priceConfig.yearly : priceConfig.monthly;

  return {
    planTier,
    planName: plan.name,
    billingCycle,
    region: location.countryCode,
    isIndia: location.isIndia,
    gateway: location.recommendedGateway, // 'razorpay' | 'dodo'
    currency,
    currencySymbol: priceConfig.symbol,
    amount: rawAmount,
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
  currency,
  planTier = 'pro',
  billingCycle = 'monthly',
  status = 'pending',
  customerEmail = null,
  customerCountry = null,
  metadata = {}
}) {
  try {
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
        plan_tier: planTier,
        billing_cycle: billingCycle,
        status,
        customer_email: customerEmail,
        customer_country: customerCountry,
        metadata
      })
      .select()
      .single();

    if (error) {
      console.warn('Could not record payment transaction to Supabase (check migration):', error.message);
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
      updated_at: new Date().toISOString()
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
 * Sync user profile subscription upon successful payment
 */
export async function fulfillSubscriptionUpgrade({
  userId,
  tier = 'pro',
  gateway,
  gatewayCustomerId = null,
  gatewaySubscriptionId = null,
  countryCode = 'GLOBAL',
  currency = 'USD',
  billingCycle = 'monthly'
}) {
  const periodDurationDays = billingCycle === 'yearly' ? 365 : 30;
  
  // Calculate period end: if the user already has an active period in the future, extend from that date
  let baseTime = Date.now();
  try {
    const { data: existingProfile } = await supabaseAdminClient
      .from('profiles')
      .select('current_period_end')
      .eq('id', userId)
      .single();

    if (existingProfile?.current_period_end) {
      const existingEnd = new Date(existingProfile.current_period_end).getTime();
      if (existingEnd > baseTime) {
        baseTime = existingEnd; // Clean extension of paid duration
      }
    }
  } catch (profileErr) {
    console.warn('Could not check existing current_period_end:', profileErr?.message);
  }

  const currentPeriodEnd = new Date(baseTime + periodDurationDays * 24 * 60 * 60 * 1000).toISOString();

  // 1. Upgrade subscription tier and reset AI credits in profiles
  const profileUpdates = {
    subscription_tier: tier,
    payment_gateway: gateway,
    country_code: countryCode,
    billing_currency: currency,
    gateway_customer_id: gatewayCustomerId,
    gateway_subscription_id: gatewaySubscriptionId,
    subscription_status: 'active',
    current_period_end: currentPeriodEnd,
    ai_credits_used: 0,
    credits_reset_at: currentPeriodEnd,
  };

  const { error } = await supabaseAdminClient
    .from('profiles')
    .update(profileUpdates)
    .eq('id', userId);

  if (error) {
    console.error('Failed to update profile subscription details:', error.message);
    throw new Error(`Profile subscription update failed: ${error.message}`);
  }

  return { success: true, tier, currentPeriodEnd };
}
