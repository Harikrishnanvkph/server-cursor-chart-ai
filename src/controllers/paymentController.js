import { detectCountryFromRequest, resolveLocationContext } from '../services/geoService.js';
import {
  PAYMENT_PLANS,
  getPlanPricingAndGateway,
  recordPaymentTransaction,
  updatePaymentTransaction,
  fulfillSubscriptionUpgrade
} from '../services/paymentRoutingService.js';
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
 * Returns location context, available gateways, and pricing definitions
 */
export async function getPaymentConfig(req, res) {
  try {
    const detectedCountry = detectCountryFromRequest(req);
    const locationContext = resolveLocationContext(detectedCountry);

    res.json({
      success: true,
      detectedCountry: locationContext.countryCode,
      isIndia: locationContext.isIndia,
      recommendedGateway: locationContext.recommendedGateway,
      defaultCurrency: locationContext.currency,
      currencySymbol: locationContext.currencySymbol,
      razorpayKeyId: getRazorpayPublicKey(),
      isRazorpayConfigured,
      isDodoConfigured,
      plans: PAYMENT_PLANS,
    });
  } catch (error) {
    console.error('getPaymentConfig error:', error);
    res.status(500).json({ error: 'Failed to retrieve payment configuration' });
  }
}

/**
 * POST /payments/create-checkout
 * Resolves gateway by location or manual user override and initiates checkout
 */
export async function createCheckout(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id;
    const userEmail = req.user?.email;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const {
      planTier = 'pro',
      billingCycle = 'monthly',
      regionOverride // 'IN' or 'GLOBAL' or 2-letter country code
    } = req.body;

    // Resolve location (user selection overrides auto-detection)
    const effectiveRegion = regionOverride || detectCountryFromRequest(req);
    const routingInfo = getPlanPricingAndGateway({
      planTier,
      billingCycle,
      region: effectiveRegion
    });

    // 1. Indian Users -> Razorpay (INR)
    if (routingInfo.isIndia || routingInfo.gateway === 'razorpay') {
      const receiptId = `rcpt_${userId.substring(0, 8)}_${Date.now()}`;
      const razorpayOrder = await createRazorpayOrder({
        amountInInr: routingInfo.amount,
        receipt: receiptId,
        notes: {
          userId,
          userEmail,
          planTier,
          billingCycle,
        }
      });

      // Save pending transaction
      await recordPaymentTransaction({
        userId,
        gateway: 'razorpay',
        gatewayOrderId: razorpayOrder.id,
        amount: routingInfo.amount,
        currency: 'INR',
        planTier,
        billingCycle,
        status: 'pending',
        customerEmail: userEmail,
        customerCountry: 'IN',
        metadata: { razorpayOrder }
      });

      return res.json({
        success: true,
        gateway: 'razorpay',
        orderId: razorpayOrder.id,
        amount: razorpayOrder.amount, // in paise
        amountDisplay: routingInfo.amount, // in INR
        currency: 'INR',
        currencySymbol: '₹',
        keyId: getRazorpayPublicKey(),
        isSimulation: razorpayOrder.isSimulation,
        planTier,
        billingCycle,
      });
    }

    // 2. International / Rest of the World -> Dodo Payments (USD)
    const dodoSession = await createDodoCheckoutSession({
      userId,
      customerEmail: userEmail,
      customerName: req.user?.full_name || 'Subscriber',
      billingCycle,
      amountInUsd: routingInfo.amount,
    });

    // Save pending transaction
    await recordPaymentTransaction({
      userId,
      gateway: 'dodo',
      gatewayOrderId: dodoSession.id,
      amount: routingInfo.amount,
      currency: 'USD',
      planTier,
      billingCycle,
      status: 'pending',
      customerEmail: userEmail,
      customerCountry: routingInfo.region,
      metadata: { dodoSession }
    });

    return res.json({
      success: true,
      gateway: 'dodo',
      checkoutUrl: dodoSession.checkoutUrl,
      sessionId: dodoSession.id,
      amount: routingInfo.amount,
      currency: 'USD',
      currencySymbol: '$',
      isSimulation: dodoSession.isSimulation,
      planTier,
      billingCycle,
    });
  } catch (error) {
    console.error('createCheckout error:', error);
    res.status(500).json({ error: error.message || 'Failed to initialize checkout session' });
  }
}

/**
 * POST /payments/razorpay/verify
 * Verifies Razorpay checkout signature and fulfills subscription
 */
export async function verifyRazorpayPayment(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { orderId, paymentId, signature, planTier = 'pro', billingCycle = 'monthly' } = req.body;

    const verification = verifyRazorpaySignature({ orderId, paymentId, signature });
    if (!verification.verified) {
      return res.status(400).json({ error: verification.error || 'Payment verification failed' });
    }

    // Update transaction record
    await updatePaymentTransaction(
      { gatewayOrderId: orderId },
      {
        gateway_payment_id: paymentId,
        gateway_signature: signature,
        status: 'completed'
      }
    );

    // Fulfill subscription upgrade in profiles
    const fulfillment = await fulfillSubscriptionUpgrade({
      userId,
      tier: planTier,
      gateway: 'razorpay',
      gatewayCustomerId: null,
      gatewaySubscriptionId: orderId,
      countryCode: 'IN',
      currency: 'INR',
      billingCycle
    });

    res.json({
      success: true,
      message: 'Payment verified and Pro subscription activated!',
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
    const userId = req.user?.user_id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { gateway = 'simulation', planTier = 'pro', billingCycle = 'monthly', region = 'GLOBAL' } = req.body;

    const isIndia = region === 'IN';
    const currency = isIndia ? 'INR' : 'USD';

    await recordPaymentTransaction({
      userId,
      gateway: `${gateway}_simulated`,
      gatewayOrderId: `sim_order_${Date.now()}`,
      gatewayPaymentId: `sim_pay_${Date.now()}`,
      amount: isIndia ? 399 : 5,
      currency,
      planTier,
      billingCycle,
      status: 'completed',
      customerCountry: region,
      metadata: { simulated: true }
    });

    const fulfillment = await fulfillSubscriptionUpgrade({
      userId,
      tier: planTier,
      gateway: `${gateway}_simulated`,
      countryCode: region,
      currency,
      billingCycle
    });

    res.json({
      success: true,
      message: 'Simulated payment confirmed! Pro tier active.',
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

      if (userId) {
        await fulfillSubscriptionUpgrade({
          userId,
          tier: paymentEntity?.notes?.planTier || 'pro',
          gateway: 'razorpay',
          gatewaySubscriptionId: orderId,
          countryCode: 'IN',
          currency: 'INR',
          billingCycle: paymentEntity?.notes?.billingCycle || 'monthly'
        });

        await updatePaymentTransaction(
          { gatewayOrderId: orderId },
          {
            gateway_payment_id: paymentEntity?.id,
            status: 'completed'
          }
        );
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
      const planTier = data?.metadata?.plan_tier || 'pro';
      const billingCycle = data?.metadata?.billing_cycle || 'monthly';

      if (userId) {
        await fulfillSubscriptionUpgrade({
          userId,
          tier: planTier,
          gateway: 'dodo',
          gatewayCustomerId: data?.customer?.customer_id,
          gatewaySubscriptionId: data?.subscription_id || data?.payment_id,
          countryCode: data?.billing?.country || 'GLOBAL',
          currency: 'USD',
          billingCycle
        });

        await updatePaymentTransaction(
          { gatewayOrderId: data?.payment_id || data?.id },
          {
            gateway_payment_id: data?.payment_id || data?.id,
            status: 'completed'
          }
        );
      }
    }

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('handleDodoWebhook error:', error);
    res.status(500).send('Webhook processing error');
  }
}
