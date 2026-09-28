import { Router } from 'express'
import { signUp, signIn, me, signOut, googleStart, googleCallback, passwordForgot, passwordReset, resendVerification, guestSignIn, upgradeSubscription, downgradeSubscription } from '../controllers/authController.js'
import { requireAuth, rateLimitMiddleware, requireAuthEnhanced } from '../middleware/authMiddleware.js'

const router = Router()

// Sensitive public routes subject to brute-force rate limiting
router.post('/signup', rateLimitMiddleware, signUp)
router.post('/signin', rateLimitMiddleware, signIn)
router.post('/guest', rateLimitMiddleware, guestSignIn)
router.get('/google', googleStart)
router.get('/google/callback', googleCallback)

// Password reset routes (with rate limiting)
router.post('/password/forgot', rateLimitMiddleware, passwordForgot)
router.post('/password/reset', rateLimitMiddleware, passwordReset)
router.post('/resend-verification', rateLimitMiddleware, resendVerification)

// Protected routes (require authentication - not subject to brute-force IP rate limiting)
router.get('/me', requireAuthEnhanced, me)
router.post('/signout', requireAuthEnhanced, signOut)

// Subscription management endpoints
router.post('/subscription/upgrade', requireAuthEnhanced, upgradeSubscription)
router.post('/subscription/downgrade', requireAuthEnhanced, downgradeSubscription)

// Example protected route template
router.get('/protected/ping', requireAuthEnhanced, (req, res) => {
  res.json({ ok: true, userId: req.user?.id })
})

export default router


