import { Router } from 'express'
import { signUp, signIn, me, signOut, googleStart, googleCallback, passwordForgot, passwordReset, resendVerification } from '../controllers/authController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = Router()

router.post('/signup', signUp)
router.post('/signin', signIn)
router.post('/signout', signOut)
router.post('/resend-verification', resendVerification)
router.get('/me', me)

router.get('/google', googleStart)
router.get('/google/callback', googleCallback)

// Password reset
router.post('/password/forgot', passwordForgot)
router.post('/password/reset', passwordReset)

// Example protected route template
router.get('/protected/ping', requireAuth, (req, res) => {
  res.json({ ok: true, userId: req.user?.id })
})

export default router


