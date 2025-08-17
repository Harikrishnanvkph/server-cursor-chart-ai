import { Router } from 'express'
import { signUp, signIn, me, signOut, googleStart, googleCallback, passwordForgot, passwordReset, resendVerification } from '../controllers/authController.js'
import { requireAuth, rateLimitMiddleware, requireAuthEnhanced } from '../middleware/authMiddleware.js'

const router = Router()

// Apply rate limiting to all auth routes
router.use(rateLimitMiddleware)

// Public routes (with rate limiting)
router.post('/signup', signUp)
router.post('/signin', signIn)
router.get('/google', googleStart)
router.get('/google/callback', googleCallback)

// Password reset routes (with rate limiting)
router.post('/password/forgot', passwordForgot)
router.post('/password/reset', passwordReset)
router.post('/resend-verification', resendVerification)

// Protected routes (require authentication)
router.get('/me', requireAuthEnhanced, me)
router.post('/signout', requireAuthEnhanced, signOut)

// Example protected route template
router.get('/protected/ping', requireAuthEnhanced, (req, res) => {
  res.json({ ok: true, userId: req.user?.id })
})

export default router


