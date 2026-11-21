import crypto from 'crypto';

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

export const isRazorpayConfigured = Boolean(KEY_ID && KEY_SECRET);

// Lazy-load Razorpay SDK only when creating an order (avoids cold-start overhead on auth/data endpoints)
let razorpayInstance = null;
async function getRazorpayClient() {
  if (!isRazorpayConfigured) return null;
  if (!razorpayInstance) {
    try {
      const { default: Razorpay } = await import('razorpay');
      razorpayInstance = new Razorpay({
        key_id: KEY_ID,
        key_secret: KEY_SECRET,
      });
    } catch (err) {
      console.error('Failed to initialize Razorpay client:', err.message);
      return null;
    }
  }
  return razorpayInstance;
}

/**
 * Get public key ID for client checkout script
 */
export function getRazorpayPublicKey() {
  return KEY_ID || 'rzp_test_simulated_key';
}

/**
 * Create a Razorpay Order
 * @param {Object} params
 * @param {number} params.amountInInr - Amount in INR (e.g., 399)
 * @param {string} params.receipt - Internal receipt ID
 * @param {Object} params.notes - Metadata
 */
export async function createRazorpayOrder({ amountInInr, receipt, notes = {} }) {
  // Amount for Razorpay must be in the smallest currency sub-unit (paise for INR, 1 INR = 100 paise)
  const amountInPaise = Math.round(amountInInr * 100);
  if (amountInPaise < 100) {
    throw new Error('Order amount must be at least 100 paise (₹1.00)');
  }

  const client = await getRazorpayClient();
  if (isRazorpayConfigured && client) {
    try {
      const order = await client.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: receipt || `rcpt_${Date.now()}`,
        notes,
      });

      return {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
        status: order.status,
        keyId: KEY_ID,
        isSimulation: false,
      };
    } catch (error) {
      console.error('Razorpay order creation error:', error);
      throw new Error(`Razorpay order failed: ${error.message}`);
    }
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Razorpay payment gateway is not configured in production');
  }

  // Developer Simulation Mode when keys are not configured yet (non-production only)
  console.log('Razorpay API keys not configured. Running in Developer Simulation Mode.');
  const simulatedOrderId = `order_sim_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  return {
    id: simulatedOrderId,
    amount: amountInPaise,
    currency: 'INR',
    receipt: receipt || `sim_rcpt_${Date.now()}`,
    status: 'created',
    keyId: 'rzp_test_simulation',
    isSimulation: true,
  };
}

/**
 * Verify Razorpay payment signature
 */
export function verifyRazorpaySignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) {
    return { verified: false, error: 'Missing order ID, payment ID, or signature' };
  }

  // Allow simulation mode only in non-production environments
  if (process.env.NODE_ENV !== 'production' && (!isRazorpayConfigured || String(orderId).startsWith('order_sim_'))) {
    console.log('Verifying payment signature in Simulation Mode.');
    return { verified: true, isSimulation: true };
  }

  if (!KEY_SECRET) {
    return { verified: false, error: 'Razorpay key secret not configured' };
  }

  try {
    const text = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(text)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const actualBuf = Buffer.from(String(signature), 'utf8');
    const verified =
      expectedBuf.byteLength === actualBuf.byteLength &&
      crypto.timingSafeEqual(expectedBuf, actualBuf);
    return {
      verified,
      error: verified ? null : 'Invalid payment signature',
      isSimulation: false,
    };
  } catch (error) {
    console.error('Signature verification error:', error);
    return { verified: false, error: error.message };
  }
}

/**
 * Verify Razorpay Webhook signature
 */
export function verifyRazorpayWebhook({ rawBody, signature }) {
  if (!WEBHOOK_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      console.error('RAZORPAY_WEBHOOK_SECRET not set in production. Rejecting webhook.');
      return false;
    }
    console.warn('RAZORPAY_WEBHOOK_SECRET not set. Webhook verification skipped in dev.');
    return true;
  }

  if (!signature) {
    return false;
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const actualBuf = Buffer.from(String(signature), 'utf8');
    return (
      expectedBuf.byteLength === actualBuf.byteLength &&
      crypto.timingSafeEqual(expectedBuf, actualBuf)
    );
  } catch (error) {
    console.error('Webhook verification error:', error);
    return false;
  }
}
