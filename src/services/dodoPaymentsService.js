import crypto from 'crypto';
import fetch from 'node-fetch';

const DODO_API_KEY = process.env.DODO_PAYMENTS_API_KEY;
const DODO_WEBHOOK_SECRET = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
const DODO_ENVIRONMENT = process.env.DODO_PAYMENTS_ENVIRONMENT || 'test'; // 'test' | 'live'
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export const isDodoConfigured = Boolean(DODO_API_KEY && !DODO_API_KEY.includes('placeholder'));

const BASE_URL = DODO_ENVIRONMENT === 'live'
  ? 'https://api.dodopayments.com'
  : 'https://test.dodopayments.com';

/**
 * Create a Dodo Payments checkout session / payment link
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.customerEmail
 * @param {string} params.customerName
 * @param {string} params.billingCycle - 'monthly' | 'yearly'
 * @param {number} params.amountInUsd - Amount in USD (e.g. 5 or 48)
 * @param {string} params.returnUrl - URL to redirect upon completion
 */
export async function createDodoCheckoutSession({
  userId,
  customerEmail,
  customerName = 'Valued User',
  billingCycle = 'monthly',
  amountInUsd = 5,
  returnUrl = `${FRONTEND_URL}/payment/success`
}) {
  if (isDodoConfigured) {
    try {
      const response = await fetch(`${BASE_URL}/payments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DODO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          billing: {
            city: 'City',
            country: 'US',
            state: 'State',
            street: 'Street',
            zipcode: '10001'
          },
          customer: {
            email: customerEmail,
            name: customerName,
          },
          payment_link: true,
          product_cart: [
            {
              amount: Math.round(amountInUsd * 100), // cents
              currency: 'USD',
              product_id: process.env.DODO_PRO_PRODUCT_ID || 'p_pro_tier',
              quantity: 1
            }
          ],
          return_url: `${returnUrl}?gateway=dodo&cycle=${billingCycle}`,
          metadata: {
            user_id: userId,
            plan_tier: 'pro',
            billing_cycle: billingCycle,
          }
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Dodo API error: ${response.statusText}`);
      }

      return {
        id: data.payment_id || data.id,
        checkoutUrl: data.payment_link || data.checkout_url || data.url,
        amount: amountInUsd,
        currency: 'USD',
        status: 'created',
        isSimulation: false,
      };
    } catch (error) {
      console.error('Dodo Payments checkout creation error:', error);
      throw error;
    }
  }

  // Developer Simulation Mode when Dodo API key is not configured
  console.log('Dodo Payments API key not configured. Running in Developer Simulation Mode.');
  const simulatedSessionId = `dodo_sim_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const simulatedCheckoutUrl = `${FRONTEND_URL}/payment/success?gateway=dodo&session_id=${simulatedSessionId}&plan=pro&cycle=${billingCycle}&amount=${amountInUsd}`;

  return {
    id: simulatedSessionId,
    checkoutUrl: simulatedCheckoutUrl,
    amount: amountInUsd,
    currency: 'USD',
    status: 'created',
    isSimulation: true,
  };
}

/**
 * Verify Dodo Payments webhook signature
 */
export function verifyDodoWebhook({ rawBody, signature, webhookId, timestamp }) {
  if (!DODO_WEBHOOK_SECRET) {
    console.warn('DODO_PAYMENTS_WEBHOOK_SECRET not set. Webhook verification skipped in dev.');
    return true;
  }

  try {
    const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    const textToSign = `${webhookId}.${timestamp}.${payload}`;
    
    // Svix / Standard HMAC SHA-256
    const expectedSignature = crypto
      .createHmac('sha256', DODO_WEBHOOK_SECRET)
      .update(textToSign)
      .digest('base64');

    return signature.includes(expectedSignature);
  } catch (error) {
    console.error('Dodo Webhook verification error:', error);
    return false;
  }
}
