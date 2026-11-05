import crypto from 'crypto';
import fetch from 'node-fetch';

const DODO_API_KEY = process.env.DODO_PAYMENTS_API_KEY;
const DODO_WEBHOOK_SECRET = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
const DODO_ENVIRONMENT = process.env.DODO_PAYMENTS_ENVIRONMENT || 'test'; // 'test' | 'live'
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export const isDodoConfigured = Boolean(DODO_API_KEY && !DODO_API_KEY.includes('placeholder'));

const BASE_URL = DODO_ENVIRONMENT === 'live'
  ? 'https://live.dodopayments.com'
  : 'https://test.dodopayments.com';

const DODO_PRODUCT_IDS = {
  ai_lite: process.env.DODO_AI_LITE_PRODUCT_ID || 'pdt_0NrDYDZ4dISLl5nV8VLTh',
  ai_pro: process.env.DODO_AI_PRO_PRODUCT_ID || 'pdt_0NrDYDegv3SDHVEFHYYIP',
  cloud_lite: process.env.DODO_CLOUD_LITE_PRODUCT_ID || 'pdt_0NrDYDilzZGawdfkvGdCT',
  cloud_pro: process.env.DODO_CLOUD_PRO_PRODUCT_ID || 'pdt_0NrDYDoSmdQ9RPl1kuLwJ',
};

/**
 * Create a Dodo Payments checkout session / payment link for a one-time credit pack
 */
export async function createDodoCheckoutSession({
  userId,
  customerEmail,
  customerName = 'Valued User',
  customerCountry,
  packId = 'ai_pro',
  billingCycle = 'one_time',
  amountInUsd = 5,
  returnUrl = `${FRONTEND_URL}/payment/success`
}) {
  if (isDodoConfigured) {
    try {
      const productId = DODO_PRODUCT_IDS[packId] || DODO_PRODUCT_IDS.ai_pro;

      const checkoutPayload = {
        product_cart: [
          {
            product_id: productId,
            quantity: 1
          }
        ],
        customer: {
          email: customerEmail || 'customer@example.com',
          name: customerName,
        },
        return_url: `${returnUrl}?gateway=dodo&pack=${encodeURIComponent(packId)}&amount=${amountInUsd}`,
        metadata: {
          user_id: userId,
          pack_id: packId,
          plan_tier: packId,
          billing_cycle: billingCycle,
        }
      };

      if (customerCountry && customerCountry !== 'GLOBAL' && customerCountry.length === 2) {
        checkoutPayload.billing_address = {
          country: customerCountry.toUpperCase(),
        };
      }

      const response = await fetch(`${BASE_URL}/checkouts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DODO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(checkoutPayload)
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Dodo API error: ${response.statusText}`);
      }

      return {
        id: data.session_id || data.payment_id || data.id,
        checkoutUrl: data.checkout_url || data.payment_link || data.url,
        amount: amountInUsd,
        currency: 'USD',
        packId,
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
  const simulatedCheckoutUrl = `${FRONTEND_URL}/payment/success?gateway=dodo&session_id=${simulatedSessionId}&pack=${encodeURIComponent(packId)}&amount=${amountInUsd}`;

  return {
    id: simulatedSessionId,
    checkoutUrl: simulatedCheckoutUrl,
    amount: amountInUsd,
    currency: 'USD',
    packId,
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
