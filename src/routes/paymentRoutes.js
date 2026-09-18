import { Router } from 'express';
import {
  getPaymentConfig,
  createCheckout,
  verifyRazorpayPayment,
  confirmSimulationPayment,
  handleRazorpayWebhook,
  handleDodoWebhook
} from '../controllers/paymentController.js';
import { requireAuthEnhanced } from '../middleware/authMiddleware.js';

const router = Router();

// Public: Fetch detected location, pricing, and gateway configuration
router.get('/config', getPaymentConfig);

// Protected: Initialize checkout for Razorpay (India) or Dodo Payments (Global)
router.post('/create-checkout', requireAuthEnhanced, createCheckout);

// Protected: Verify Razorpay signature upon modal success
router.post('/razorpay/verify', requireAuthEnhanced, verifyRazorpayPayment);

// Protected: Developer simulation checkout confirmation (when running without real API keys)
router.post('/confirm-simulation', requireAuthEnhanced, confirmSimulationPayment);

// Webhook listeners (public, signature-verified)
router.post('/razorpay/webhook', handleRazorpayWebhook);
router.post('/dodo/webhook', handleDodoWebhook);

export default router;
