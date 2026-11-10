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
        cancel_url: `${FRONTEND_URL}/payment/cancel?gateway=dodo&pack=${encodeURIComponent(packId)}`,
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
 * Retrieve payment status directly from Dodo Payments API
 */
export async function retrieveDodoPayment(paymentId) {
  if (!paymentId) return null;
  if (!isDodoConfigured) {
    if (paymentId.startsWith('dodo_sim_')) {
      return {
        payment_id: paymentId,
        status: 'succeeded',
        isSimulation: true,
      };
    }
    return null;
  }

  try {
    const response = await fetch(`${BASE_URL}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${DODO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Failed to retrieve Dodo payment ${paymentId}: ${response.status}`, err);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(`Error retrieving Dodo payment ${paymentId}:`, error);
    return null;
  }
}

/**
 * Verify Dodo Payments webhook signature (Standard Webhooks / Svix compliant)
 */
export function verifyDodoWebhook({ rawBody, signature, webhookId, timestamp }) {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY || process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('DODO_PAYMENTS_WEBHOOK_KEY / SECRET not set. Webhook verification skipped in dev.');
    return true;
  }

  if (!signature || !webhookId || !timestamp) {
    return false;
  }

  // Prevent replay attacks (5-minute tolerance)
  const now = Math.floor(Date.now() / 1000);
  const eventTime = parseInt(timestamp, 10);
  if (isNaN(eventTime) || Math.abs(now - eventTime) > 300) {
    console.warn('Dodo webhook timestamp is outside 5-minute tolerance window');
    return false;
  }

  try {
    const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    const textToSign = `${webhookId}.${timestamp}.${payload}`;

    // Standard Webhooks / Svix secret format: if starts with whsec_, decode the base64 part
    let secretKey = secret.trim();
    let secretBuffer;
    if (secretKey.startsWith('whsec_')) {
      secretBuffer = Buffer.from(secretKey.slice(6), 'base64');
    } else {
      try {
        secretBuffer = Buffer.from(secretKey, 'base64');
      } catch {
        secretBuffer = Buffer.from(secretKey, 'utf8');
      }
    }

    const expectedSignature = crypto
      .createHmac('sha256', secretBuffer)
      .update(textToSign)
      .digest('base64');

    // webhook-signature header can contain multiple space-separated signatures: "v1,abc v1,xyz"
    const passedSignatures = signature.split(' ');
    for (const sig of passedSignatures) {
      const parts = sig.split(',');
      const candidate = parts.length > 1 ? parts[1] : parts[0];
      if (candidate.length === expectedSignature.length) {
        if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedSignature))) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.error('Dodo Webhook verification error:', error);
    return false;
  }
}
