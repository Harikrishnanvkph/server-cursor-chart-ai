import crypto from 'crypto';
import Razorpay from 'razorpay';

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

export const isRazorpayConfigured = Boolean(KEY_ID && KEY_SECRET);

let razorpayInstance = null;
if (isRazorpayConfigured) {
  try {
    razorpayInstance = new Razorpay({
      key_id: KEY_ID,
      key_secret: KEY_SECRET,
    });
  } catch (err) {
    console.error('Failed to initialize Razorpay client:', err.message);
  }
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

  if (isRazorpayConfigured && razorpayInstance) {
    try {
      const order = await razorpayInstance.orders.create({
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

  // Developer Simulation Mode when keys are not configured yet
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
  if (!orderId || !paymentId) {
    return { verified: false, error: 'Missing order ID or payment ID' };
  }

  // Allow simulation mode when keys are not provided
  if (!isRazorpayConfigured || orderId.startsWith('order_sim_')) {
    console.log('Verifying payment signature in Simulation Mode.');
    return { verified: true, isSimulation: true };
  }

  try {
    const text = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(text)
      .digest('hex');

    const verified = expectedSignature === signature;
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
    console.warn('RAZORPAY_WEBHOOK_SECRET not set. Webhook verification skipped in dev.');
    return true;
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
      .digest('hex');

    return expectedSignature === signature;
  } catch (error) {
    console.error('Webhook verification error:', error);
    return false;
  }
}
