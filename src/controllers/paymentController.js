import { detectCountryFromRequest, resolveLocationContext } from '../services/geoService.js';
import {
  PAYMENT_PLANS,
  resolvePackId,
  getPlanPricingAndGateway,
  recordPaymentTransaction,
  updatePaymentTransaction,
  fulfillSubscriptionUpgrade
} from '../services/paymentRoutingService.js';
import { CREDIT_PACKS } from '../services/subscriptionService.js';
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  verifyRazorpayWebhook,
  getRazorpayPublicKey,
  isRazorpayConfigured
} from '../services/razorpayService.js';
import {
  createDodoCheckoutSession,
  verifyDodoWebhook,
  isDodoConfigured
} from '../services/dodoPaymentsService.js';

/**
 * GET /payments/config
 * Returns location context, available gateways, and credit pack pricing definitions
 */
export async function getPaymentConfig(req, res) {
  try {
    const detectedCountry = detectCountryFromRequest(req);
    const locationContext = resolveLocationContext(detectedCountry);

    res.json({
      success: true,
      detectedCountry: locationContext.countryCode,
      isIndia: false,
      recommendedGateway: 'dodo',
      defaultCurrency: 'USD',
      currencySymbol: '$',
      razorpayKeyId: getRazorpayPublicKey(),
      isRazorpayConfigured,
      isDodoConfigured,
      plans: PAYMENT_PLANS,
      packs: CREDIT_PACKS,
    });
  } catch (error) {
    console.error('getPaymentConfig error:', error);
    res.status(500).json({ error: 'Failed to retrieve payment configuration' });
  }
}

/**
 * POST /payments/create-checkout
 * Initiates checkout for the selected credit pack ('ai_lite' | 'ai_pro' | 'cloud_lite' | 'cloud_pro')
 */
export async function createCheckout(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id;
    const userEmail = req.user?.email;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const {
      packId,
      planTier = 'pro',
      billingCycle = 'one_time',
      regionOverride
    } = req.body;

    const resolvedPackId = resolvePackId(packId, planTier);
    const effectiveRegion = regionOverride || detectCountryFromRequest(req);
    const routingInfo = getPlanPricingAndGateway({
      packId: resolvedPackId,
      planTier,
      billingCycle,
      region: effectiveRegion
    });

    // Dodo Payments (USD pricing for all packs)
    const dodoSession = await createDodoCheckoutSession({
      userId,
      customerEmail: userEmail,
      customerName: req.user?.full_name || 'Subscriber',
      customerCountry: effectiveRegion,
      packId: resolvedPackId,
      billingCycle: 'one_time',
      amountInUsd: routingInfo.amount,
    });

    await recordPaymentTransaction({
      userId,
      gateway: 'dodo',
      gatewayOrderId: dodoSession.id,
      amount: routingInfo.amount,
      currency: 'USD',
      packId: resolvedPackId,
      planTier: routingInfo.planTier,
      billingCycle: 'one_time',
      status: 'pending',
      customerEmail: userEmail,
      customerCountry: routingInfo.region,
      metadata: { dodoSession, packId: resolvedPackId }
    });

    return res.json({
      success: true,
      gateway: 'dodo',
      checkoutUrl: dodoSession.checkoutUrl,
      sessionId: dodoSession.id,
      amount: routingInfo.amount,
      amountDisplay: routingInfo.amount,
      currency: 'USD',
      currencySymbol: '$',
      isSimulation: dodoSession.isSimulation,
      packId: resolvedPackId,
      planTier: routingInfo.planTier,
      billingCycle: 'one_time',
    });
  } catch (error) {
    console.error('createCheckout error:', error);
    res.status(500).json({ error: error.message || 'Failed to initialize checkout session' });
  }
}

/**
 * POST /payments/razorpay/verify
 * Verifies Razorpay checkout signature and fulfills credit pack
 */
export async function verifyRazorpayPayment(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { orderId, paymentId, signature, packId, planTier = 'pro' } = req.body;
    const resolvedPackId = resolvePackId(packId, planTier);

    const verification = verifyRazorpaySignature({ orderId, paymentId, signature });
    if (!verification.verified) {
      return res.status(400).json({ error: verification.error || 'Payment verification failed' });
    }

    const txRows = await updatePaymentTransaction(
      { gatewayOrderId: orderId },
      {
        gateway_payment_id: paymentId,
        gateway_signature: signature,
        status: 'completed'
      }
    );
    const txId = Array.isArray(txRows) && txRows[0] ? txRows[0].id : null;

    const fulfillment = await fulfillSubscriptionUpgrade({
      userId,
      packId: resolvedPackId,
      tier: planTier,
      gateway: 'razorpay',
      orderId,
      paymentId,
      transactionId: txId,
      countryCode: 'IN',
      currency: 'USD'
    });

    res.json({
      success: true,
      message: 'Payment verified and credits added to your account!',
      subscription: fulfillment
    });
  } catch (error) {
    console.error('verifyRazorpayPayment error:', error);
    res.status(500).json({ error: error.message || 'Payment verification failed' });
  }
}

/**
 * POST /payments/confirm-simulation
 * Allows instant fulfillment in dev/simulation mode when testing without real gateway keys
 */
export async function confirmSimulationPayment(req, res) {
  try {
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      return res.status(403).json({ error: 'Simulation payment is disabled in production environment' });
    }

    const userId = req.user?.user_id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const {
      gateway = 'simulation',
      packId,
      planTier = 'pro',
      region = 'GLOBAL',
      sessionId
    } = req.body;

    const resolvedPackId = resolvePackId(packId, planTier);
    const pack = CREDIT_PACKS[resolvedPackId] || CREDIT_PACKS.ai_pro;
    const orderKey = sessionId || `sim_order_${Date.now()}`;

    const tx = await recordPaymentTransaction({
      userId,
      gateway: `${gateway}_simulated`,
      gatewayOrderId: orderKey,
      gatewayPaymentId: `sim_pay_${Date.now()}`,
      amount: pack.priceUsd,
      currency: 'USD',
      packId: resolvedPackId,
      planTier: pack.badge,
      billingCycle: 'one_time',
      status: 'completed',
      customerCountry: region,
      metadata: { simulated: true, packId: resolvedPackId }
    });

    const fulfillment = await fulfillSubscriptionUpgrade({
      userId,
      packId: resolvedPackId,
      tier: pack.badge,
      gateway: `${gateway}_simulated`,
      orderId: orderKey,
      transactionId: tx?.id && !String(tx.id).startsWith('temp_') ? tx.id : null,
      countryCode: region,
      currency: 'USD',
    });

    res.json({
      success: true,
      message: `Simulated payment confirmed! ${pack.name} credits added.`,
      subscription: fulfillment
    });
  } catch (error) {
    console.error('confirmSimulationPayment error:', error);
    res.status(500).json({ error: error.message || 'Failed to simulate payment confirmation' });
  }
}

/**
 * POST /payments/razorpay/webhook
 * Razorpay webhook handler
 */
export async function handleRazorpayWebhook(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || req.body;

    const isValid = verifyRazorpayWebhook({ rawBody, signature });
    if (!isValid) {
      return res.status(400).send('Invalid signature');
    }

    const event = req.body?.event;
    const payload = req.body?.payload;

    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      const userId = paymentEntity?.notes?.userId;
      const resolvedPackId = resolvePackId(
        paymentEntity?.notes?.packId,
        paymentEntity?.notes?.planTier || 'pro'
      );

      if (userId) {
        const txRows = await updatePaymentTransaction(
          { gatewayOrderId: orderId },
          {
            gateway_payment_id: paymentEntity?.id,
            status: 'completed'
          }
        );
        const txId = Array.isArray(txRows) && txRows[0] ? txRows[0].id : null;

        await fulfillSubscriptionUpgrade({
          userId,
          packId: resolvedPackId,
          gateway: 'razorpay',
          orderId,
          paymentId: paymentEntity?.id,
          transactionId: txId,
          countryCode: 'IN',
          currency: 'USD',
        });
      }
    }

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('handleRazorpayWebhook error:', error);
    res.status(500).send('Webhook processing error');
  }
}

/**
 * POST /payments/dodo/webhook
 * Dodo Payments webhook handler
 */
export async function handleDodoWebhook(req, res) {
  try {
    const signature = req.headers['webhook-signature'] || req.headers['signature'];
    const webhookId = req.headers['webhook-id'];
    const timestamp = req.headers['webhook-timestamp'];
    const rawBody = req.rawBody || req.body;

    const isValid = verifyDodoWebhook({ rawBody, signature, webhookId, timestamp });
    if (!isValid) {
      return res.status(400).send('Invalid webhook signature');
    }

    const event = req.body?.type || req.body?.event;
    const data = req.body?.data;

    if (event === 'payment.succeeded' || event === 'subscription.active') {
      const userId = data?.metadata?.user_id;
      const resolvedPackId = resolvePackId(
        data?.metadata?.pack_id,
        data?.metadata?.plan_tier || 'pro'
      );
      const orderId = data?.payment_id || data?.id;

      if (userId) {
        const txRows = await updatePaymentTransaction(
          { gatewayOrderId: orderId },
          {
            gateway_payment_id: orderId,
            status: 'completed'
          }
        );
        const txId = Array.isArray(txRows) && txRows[0] ? txRows[0].id : null;

        await fulfillSubscriptionUpgrade({
          userId,
          packId: resolvedPackId,
          gateway: 'dodo',
          gatewayCustomerId: data?.customer?.customer_id,
          orderId,
          paymentId: orderId,
          transactionId: txId,
          countryCode: data?.billing?.country || 'GLOBAL',
          currency: 'USD',
        });
      }
    }

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('handleDodoWebhook error:', error);
    res.status(500).send('Webhook processing error');
  }
}
