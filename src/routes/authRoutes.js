import { Router } from 'express'
import { signUp, signIn, sendOtp, verifyOtp, me, signOut, googleStart, googleCallback, githubStart, githubCallback, passwordForgot, passwordReset, resendVerification, exchangeSession, upgradeSubscription, downgradeSubscription } from '../controllers/authController.js'
import { requireAuth, rateLimitMiddleware, requireAuthEnhanced } from '../middleware/authMiddleware.js'

const router = Router()

// Sensitive public routes subject to brute-force rate limiting
router.post('/signup', rateLimitMiddleware, signUp)
router.post('/signin', rateLimitMiddleware, signIn)
router.post('/otp/send', rateLimitMiddleware, sendOtp)
router.post('/otp/verify', rateLimitMiddleware, verifyOtp)
router.get('/google', googleStart)
router.get('/google/callback', googleCallback)
router.get('/github', githubStart)
router.get('/github/callback', githubCallback)

// Password reset & email verification routes (with rate limiting)
router.post('/password/forgot', rateLimitMiddleware, passwordForgot)
router.post('/password/reset', rateLimitMiddleware, passwordReset)
router.post('/resend-verification', rateLimitMiddleware, resendVerification)
router.post('/session', rateLimitMiddleware, exchangeSession)

// Protected routes (require authentication - not subject to brute-force IP rate limiting)
router.get('/me', requireAuthEnhanced, me)
// Sign-out must NOT require a valid session: with an expired/revoked token the old requireAuth gate
// answered 401 before the handler ran, so the browser kept its (dead) httpOnly cookies forever.
// The handler is idempotent and only ever clears the caller's own cookies/session.
router.post('/signout', signOut)

// Subscription management endpoints
router.post('/subscription/upgrade', requireAuthEnhanced, upgradeSubscription)
router.post('/subscription/downgrade', requireAuthEnhanced, downgradeSubscription)

// Example protected route template
router.get('/protected/ping', requireAuthEnhanced, (req, res) => {
  res.json({ ok: true, userId: req.user?.id })
})

export default router


