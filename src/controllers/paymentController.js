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
  retrieveDodoPayment,
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
      isIndia: locationContext.isIndia,
      recommendedGateway: locationContext.recommendedGateway,
      defaultCurrency: locationContext.currency,
      currencySymbol: locationContext.currencySymbol,
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
 * Routes India to Razorpay (INR) and Global to Dodo Payments (USD)
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

    // ─── GATEWAY 1: RAZORPAY (INDIA / INR) ───
    if (routingInfo.gateway === 'razorpay') {
      const rzpOrder = await createRazorpayOrder({
        amountInInr: routingInfo.amount,
        receipt: `rcpt_${userId}_${resolvedPackId}_${Date.now()}`.slice(0, 40),
        notes: {
          packId: resolvedPackId,
          userId,
          planTier: routingInfo.planTier,
        },
      });

      await recordPaymentTransaction({
        userId,
        gateway: 'razorpay',
        gatewayOrderId: rzpOrder.id,
        amount: routingInfo.amount,
        currency: 'INR',
        packId: resolvedPackId,
        planTier: routingInfo.planTier,
        billingCycle: 'one_time',
        status: 'pending',
        customerEmail: userEmail,
        customerCountry: 'IN',
        metadata: { rzpOrder, packId: resolvedPackId },
      });

      return res.json({
        success: true,
        gateway: 'razorpay',
        orderId: rzpOrder.id,
        keyId: rzpOrder.keyId,
        amount: rzpOrder.amount, // in paise for Razorpay modal
        amountDisplay: routingInfo.amount, // in INR for UI
        currency: 'INR',
        currencySymbol: '₹',
        isSimulation: rzpOrder.isSimulation,
        packId: resolvedPackId,
        planTier: routingInfo.planTier,
        billingCycle: 'one_time',
      });
    }

    // ─── GATEWAY 2: DODO PAYMENTS (GLOBAL / USD) ───
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
      currency: 'INR'
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
          currency: 'INR',
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
 * POST /payments/dodo/verify
 * Verifies Dodo Payment completion upon customer return to /payment/success
 * Enables instant fulfillment without waiting for webhook delivery
 */
export async function verifyDodoPayment(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { paymentId, packId, planTier = 'pro' } = req.body;
    if (!paymentId) {
      return res.status(400).json({ error: 'Missing paymentId' });
    }

    const resolvedPackId = resolvePackId(packId, planTier);

    // If running simulated checkout in development
    if (paymentId.startsWith('dodo_sim_')) {
      const fulfillment = await fulfillSubscriptionUpgrade({
        userId,
        packId: resolvedPackId,
        tier: planTier,
        gateway: 'dodo_simulated',
        orderId: paymentId,
        paymentId,
        currency: 'USD',
      });
      return res.json({
        success: true,
        message: 'Simulated payment verified!',
        subscription: fulfillment,
      });
    }

    // Retrieve payment directly from Dodo Payments API
    const payment = await retrieveDodoPayment(paymentId);
    if (!payment) {
      return res.status(400).json({ error: 'Payment record could not be retrieved from Dodo' });
    }

    if (payment.status !== 'succeeded') {
      return res.status(400).json({
        error: `Payment is not completed. Current status: ${payment.status}`,
        status: payment.status,
      });
    }

    // Ensure metadata matches current user
    if (payment.metadata?.user_id && payment.metadata.user_id !== userId) {
      return res.status(403).json({ error: 'Payment was initiated by a different account' });
    }

    const finalPackId = resolvePackId(payment.metadata?.pack_id || resolvedPackId, planTier);
    const checkoutSessionId = payment.checkout_session_id;

    // Update transaction record in DB
    let txRows = null;
    if (checkoutSessionId) {
      txRows = await updatePaymentTransaction(
        { gatewayOrderId: checkoutSessionId },
        { gateway_payment_id: paymentId, status: 'completed' }
      );
    }
    if (!txRows || txRows.length === 0) {
      txRows = await updatePaymentTransaction(
        { gatewayOrderId: paymentId },
        { gateway_payment_id: paymentId, status: 'completed' }
      );
    }

    const txId = Array.isArray(txRows) && txRows[0] ? txRows[0].id : null;

    const fulfillment = await fulfillSubscriptionUpgrade({
      userId,
      packId: finalPackId,
      tier: planTier,
      gateway: 'dodo',
      gatewayCustomerId: payment.customer?.customer_id,
      orderId: checkoutSessionId || paymentId,
      paymentId,
      transactionId: txId,
      countryCode: payment.billing?.country || 'GLOBAL',
      currency: payment.currency || 'USD',
    });

    res.json({
      success: true,
      message: 'Payment verified and credits added to your account!',
      subscription: fulfillment,
    });
  } catch (error) {
    console.error('verifyDodoPayment error:', error);
    res.status(500).json({ error: error.message || 'Payment verification failed' });
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
      const checkoutSessionId = data?.checkout_session_id;
      const paymentId = data?.payment_id || data?.id;
      const orderId = checkoutSessionId || paymentId;

      if (userId) {
        let txRows = null;
        if (checkoutSessionId) {
          txRows = await updatePaymentTransaction(
            { gatewayOrderId: checkoutSessionId },
            { gateway_payment_id: paymentId, status: 'completed' }
          );
        }
        if (!txRows || txRows.length === 0) {
          txRows = await updatePaymentTransaction(
            { gatewayOrderId: paymentId },
            { gateway_payment_id: paymentId, status: 'completed' }
          );
        }
        const txId = Array.isArray(txRows) && txRows[0] ? txRows[0].id : null;

        await fulfillSubscriptionUpgrade({
          userId,
          packId: resolvedPackId,
          gateway: 'dodo',
          gatewayCustomerId: data?.customer?.customer_id,
          orderId,
          paymentId,
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
