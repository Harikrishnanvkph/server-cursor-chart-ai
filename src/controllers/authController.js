import { supabaseUserClient, supabaseAdminClient, getSupabaseAuthUrls } from '../supabase/client.js'
import { signInSchema, signUpSchema, sendOtpSchema, verifyOtpSchema, emailSchema, passwordSchema } from '../utils/validators.js'
import googleOAuthService from '../services/googleOAuthService.js'
import githubOAuthService from '../services/githubOAuthService.js'
import secureSessionStore from '../services/sessionStore.js'
import { getUserSubscription, setSubscriptionTier } from '../services/subscriptionService.js'
import { invalidateCachedUser, isJwtFormat } from '../middleware/authMiddleware.js'
import crypto from 'crypto'

const isProd = process.env.NODE_ENV === 'production'

function setSessionCookies(res, session) {
  if (!session) return
  const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  }
  // Use 15-day cookie lifetime matching session validity so the browser does not prematurely
  // delete the cookie after 1 hour. JWT token validation inside middleware still respects cryptographic exp.
  const sessionLifetimeMs = 15 * 24 * 60 * 60 * 1000
  res.cookie('access_token', session.access_token, { ...cookieOptions, maxAge: sessionLifetimeMs })
  if (session.refresh_token) {
    res.cookie('refresh_token', session.refresh_token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 })
  }
}

function clearSessionCookies(res) {
  // Attributes must mirror setSessionCookies. A deletion sent without `secure` / `sameSite: 'none'`
  // is treated as SameSite=Lax, which browsers ignore on cross-site API responses - leaving the user
  // "signed out" in the UI but still holding a live cookie.
  const clearOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  }
  res.clearCookie('access_token', clearOptions)
  res.clearCookie('refresh_token', clearOptions)
}

// Sign up with email/password
export async function signUp(req, res) {
  try {
    const { email, password, fullName } = signUpSchema.parse(req.body)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    const { data, error } = await supabaseUserClient.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${frontendUrl}/auth/confirm`,
      }
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    // When email confirmation is enabled, Supabase returns 200 with identities: []
    // for already-registered emails instead of an error.
    const isExistingUser = Boolean(
      data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0
    )

    if (isExistingUser) {
      return res.status(409).json({
        error: 'An account with this email already exists. Try signing in instead.',
        code: 'EMAIL_ALREADY_REGISTERED',
        wasNewUser: false,
        requiresEmailConfirmation: false,
      })
    }

    if (data.session) {
      setSessionCookies(res, data.session)
    }

    res.status(201).json({
      message: data.session
        ? 'User signed up successfully.'
        : 'User created successfully. Please check your email for verification.',
      user: data.user,
      wasNewUser: true,
      requiresEmailConfirmation: !data.session
    })
  } catch (error) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({ error: error.errors?.[0]?.message || 'Invalid input data' })
    }
    console.error('Sign up error:', error)
    res.status(400).json({ error: 'Invalid input data' })
  }
}

// Sign in with email/password
export async function signIn(req, res) {
  try {
    const { email, password } = signInSchema.parse(req.body)
    const normalizedEmail = email.toLowerCase().trim()

    // Per-account rate limiting / lockout check
    if (!secureSessionStore.checkRateLimit(`login:${normalizedEmail}`)) {
      return res.status(429).json({
        error: 'Too many failed login attempts for this account. Please wait 15 minutes before trying again.'
      })
    }

    const { data, error } = await supabaseUserClient.auth.signInWithPassword({
      email,
      password
    })

    if (error) {
      const msg = String(error.message || '')
      if (msg.toLowerCase().includes('email not confirmed')) {
        return res.status(403).json({
          error: 'Email not confirmed. Please verify your email address before signing in.',
          code: 'EMAIL_NOT_CONFIRMED',
        })
      }
      secureSessionStore.recordFailedAttempt(`login:${normalizedEmail}`)
      return res.status(401).json({ error: msg })
    }

    // Reset rate limit counter on successful login
    secureSessionStore.resetRateLimit(`login:${normalizedEmail}`)

    let user = data.user

    // Look up admin status and subscription details (single query via getUserSubscription)
    try {
      const sub = await getUserSubscription(user.id)
      if (sub) {
        user = { ...user, ...sub }
      } else {
        user = { ...user, is_admin: false }
      }
    } catch (profileError) {
      console.warn('Failed to fetch admin/subscription status for user:', user.id, profileError?.message)
      user = { ...user, is_admin: false }
    }

    setSessionCookies(res, data.session)
    res.json({
      message: 'Signed in successfully',
      user: user
    })
  } catch (error) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({ error: error.errors?.[0]?.message || 'Invalid input data' })
    }
    console.error('Sign in error:', error)
    res.status(400).json({ error: 'Invalid input data' })
  }
}

// Send passwordless verification code (OTP) + magic link
export async function sendOtp(req, res) {
  try {
    const { email, mode, fullName } = sendOtpSchema.parse(req.body)
    const normalizedEmail = email.toLowerCase().trim()
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    if (!secureSessionStore.checkRateLimit(`otp_send:${normalizedEmail}`)) {
      return res.status(429).json({
        error: 'Too many code requests for this email. Please wait 15 minutes before trying again.'
      })
    }

    if (mode === 'signup') {
      if (!fullName) {
        return res.status(400).json({ error: 'Full name is required' })
      }
      const { data: existingProfile } = await supabaseAdminClient
        .from('profiles')
        .select('id')
        .eq('email', normalizedEmail)
        .maybeSingle()

      if (existingProfile) {
        const { data: authData } = await supabaseAdminClient.auth.admin.getUserById(existingProfile.id)
        if (authData?.user?.email_confirmed_at) {
          return res.status(409).json({
            error: 'An account with this email already exists. Please sign in instead.',
            code: 'EMAIL_ALREADY_REGISTERED',
          })
        }

        // Unconfirmed user re-signing up: update their pending name and let signInWithOtp send a fresh code
        await Promise.allSettled([
          supabaseAdminClient.auth.admin.updateUserById(existingProfile.id, {
            user_metadata: { ...(authData?.user?.user_metadata || {}), full_name: fullName },
          }),
          supabaseAdminClient
            .from('profiles')
            .update({ full_name: fullName })
            .eq('id', existingProfile.id),
        ])
      }
    }

    secureSessionStore.recordFailedAttempt(`otp_send:${normalizedEmail}`)

    const { error } = await supabaseUserClient.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        shouldCreateUser: mode === 'signup',
        data: mode === 'signup' && fullName ? { full_name: fullName } : undefined,
        emailRedirectTo: `${frontendUrl}/auth/confirm`,
      }
    })

    if (error) {
      const msg = String(error.message || '')
      if (mode === 'signin' && (msg.toLowerCase().includes('signups not allowed') || msg.toLowerCase().includes('user not found'))) {
        return res.status(404).json({
          error: 'No account found with this email. Please sign up first.',
          code: 'USER_NOT_FOUND',
        })
      }
      return res.status(400).json({ error: msg })
    }

    res.json({
      success: true,
      message: 'Verification code sent to your email.'
    })
  } catch (error) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({ error: error.errors?.[0]?.message || 'Invalid input data' })
    }
    console.error('Send OTP error:', error)
    res.status(500).json({ error: 'Failed to send verification code' })
  }
}

// Verify 6-digit email OTP and issue httpOnly session cookies
export async function verifyOtp(req, res) {
  try {
    const { email, token } = verifyOtpSchema.parse(req.body)
    const normalizedEmail = email.toLowerCase().trim()

    if (!secureSessionStore.checkRateLimit(`otp_verify:${normalizedEmail}`)) {
      return res.status(429).json({
        error: 'Too many failed verification attempts. Please wait 15 minutes before trying again.'
      })
    }

    let { data, error } = await supabaseUserClient.auth.verifyOtp({
      email: normalizedEmail,
      token,
      type: 'email'
    })

    // Fallback for first-time unconfirmed signup tokens in GoTrue
    if (error || !data?.session) {
      const signupVerify = await supabaseUserClient.auth.verifyOtp({
        email: normalizedEmail,
        token,
        type: 'signup'
      })
      if (!signupVerify.error && signupVerify.data?.session) {
        data = signupVerify.data
        error = null
      }
    }

    if (error || !data?.session || !data?.user) {
      secureSessionStore.recordFailedAttempt(`otp_verify:${normalizedEmail}`)
      return res.status(401).json({
        error: 'Invalid or expired verification code. Please try again.'
      })
    }

    secureSessionStore.resetRateLimit(`otp_verify:${normalizedEmail}`)
    secureSessionStore.resetRateLimit(`otp_send:${normalizedEmail}`)

    let user = data.user
    try {
      const sub = await getUserSubscription(user.id)
      user = sub ? { ...user, ...sub } : { ...user, is_admin: false }
    } catch (profileError) {
      console.warn('Failed to fetch admin/subscription status for user:', user.id, profileError?.message)
      user = { ...user, is_admin: false }
    }

    setSessionCookies(res, data.session)
    res.json({
      success: true,
      message: 'Verified successfully',
      user
    })
  } catch (error) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({ error: error.errors?.[0]?.message || 'Invalid verification code' })
    }
    console.error('Verify OTP error:', error)
    res.status(500).json({ error: 'Verification failed' })
  }
}

// Get current user
export async function me(req, res) {
  try {
    let user = req.user

    if (!user) {
      const accessToken = req.cookies.access_token || req.headers.authorization?.replace('Bearer ', '')

      if (!accessToken) {
        return res.status(401).json({ error: 'No access token provided' })
      }

      // Try to validate as OAuth session first
      user = await secureSessionStore.validateSession(accessToken)

      if (!user) {
        // Try Supabase auth as fallback
        const { data: { user: supabaseUser }, error } = await supabaseUserClient.auth.getUser(accessToken)
        if (error || !supabaseUser) {
          return res.status(401).json({ error: 'Invalid or expired token' })
        }
        user = supabaseUser
      }

      // getUserSubscription now returns is_admin alongside subscription fields
      const userId = user.user_id || user.id
      try {
        const sub = await getUserSubscription(userId)
        if (sub) {
          user = { ...user, ...sub }
        } else {
          user = { ...user, is_admin: false }
        }
      } catch (profileError) {
        console.warn('Failed to fetch admin/subscription status for user:', userId, profileError?.message)
        user = { ...user, is_admin: false }
      }
    }

    const userId = user.user_id || user.id
    if (userId && !user.subscription_tier) {
      // Only fetch if not already enriched above
      try {
        const sub = await getUserSubscription(userId)
        if (sub) {
          user = { ...user, ...sub }
        }
      } catch (subErr) {
        console.warn('Error fetching subscription for user:', userId, subErr?.message)
      }
    }

    res.json({ user })
  } catch (error) {
    console.error('Me endpoint error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Upgrade user subscription to Pro
// In production, direct upgrade is strictly disabled for non-admins to prevent payment bypass.
// Upgrades must occur via verified webhook fulfillment after checkout.
export async function upgradeSubscription(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    if (isProd && !req.user?.is_admin) {
      return res.status(403).json({
        error: 'Direct subscription upgrade is disabled. Please upgrade via the checkout page.'
      })
    }

    const packOrTier = req.body?.packId || req.body?.tier || 'ai_pro'
    const updatedSub = await setSubscriptionTier(userId, packOrTier)
    res.json({ success: true, message: 'Credit pack applied successfully', subscription: updatedSub })
  } catch (error) {
    console.error('Upgrade subscription error:', error)
    res.status(500).json({ error: error.message || 'Failed to upgrade subscription' })
  }
}

// Downgrade user subscription to Free
export async function downgradeSubscription(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    if (isProd && !req.user?.is_admin) {
      return res.status(403).json({
        error: 'Direct subscription reset is restricted to administrators.'
      })
    }

    const updatedSub = await setSubscriptionTier(userId, 'free')
    res.json({ success: true, message: 'Downgraded to Free', subscription: updatedSub })
  } catch (error) {
    console.error('Downgrade subscription error:', error)
    res.status(500).json({ error: error.message || 'Failed to downgrade subscription' })
  }
}

// Sign out
export async function signOut(req, res) {
  try {
    const accessToken = req.cookies.access_token || req.headers.authorization?.replace('Bearer ', '')

    if (accessToken) {
      // Invalidate in-memory auth cache immediately
      invalidateCachedUser(accessToken)

      // Revoke the DB-backed OAuth session and the Supabase session concurrently (they are
      // independent network calls, so awaiting them one after another just slowed logout down).
      // allSettled: a failure in either must never stop the cookies from being cleared below.
      await Promise.allSettled([
        secureSessionStore.deleteSession(accessToken),
        isJwtFormat(accessToken)
          ? supabaseAdminClient.auth.admin.signOut(accessToken)
          : Promise.resolve()
      ])
    }

    clearSessionCookies(res)
    res.json({ message: 'Signed out successfully' })
  } catch (error) {
    console.error('Sign out error:', error)
    clearSessionCookies(res)
    res.json({ message: 'Signed out successfully' })
  }
}

// Start Google OAuth flow
export async function googleStart(req, res) {
  try {
    // Generate CSRF state token for security
    const state = crypto.randomBytes(32).toString('hex')

    // Store state in a short-lived httpOnly cookie for verification on callback
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000 // 10 minutes
    })

    const authUrl = await googleOAuthService.getAuthorizationUrl(state)
    res.json({ authUrl })
  } catch (error) {
    console.error('Google OAuth start error:', error)
    res.status(500).json({ error: 'Failed to start OAuth flow' })
  }
}

// Google OAuth callback
export async function googleCallback(req, res) {
  try {
    const { code, state } = req.query

    if (!code) {
      return res.status(400).json({ error: 'Authorization code required' })
    }

    // Verify CSRF state token
    const storedState = req.cookies?.oauth_state
    if (!state || !storedState || state !== storedState) {
      console.warn('OAuth state mismatch - possible CSRF attack')
      await secureSessionStore.logSecurityEvent('suspicious_activity', req.ip, req.get('User-Agent'), {
        reason: 'OAuth state mismatch',
        provider: 'google'
      })
      const errorUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/signin?error=${encodeURIComponent('Authentication failed: invalid state')}`
      return res.redirect(errorUrl)
    }

    // Clear the state cookie
    res.clearCookie('oauth_state', { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', path: '/' })

    // Exchange code for tokens
    const tokens = await googleOAuthService.exchangeCodeForToken(code)

    // Get user info from Google via verified API call
    // (always uses the access_token validated by Google's servers)
    const userInfo = await googleOAuthService.getUserInfo(tokens.access_token)

    // Generate our own secure opaque session token (decouples session lifetime from Google's 1-hour access token)
    const sessionToken = `oauth_${crypto.randomBytes(32).toString('hex')}`

    // Create or get user session
    const session = await secureSessionStore.createSession(
      sessionToken,
      userInfo,
      'google'
    )

    // Set secure cookies
    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: 15 * 24 * 60 * 60 * 1000 // 15 days
    }

    res.cookie('access_token', sessionToken, cookieOptions)

    // Redirect to frontend with success
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/success?provider=google`
    res.redirect(redirectUrl)

  } catch (error) {
    console.error('Google OAuth callback error:', error)

    // Log security event (only critical failures)
    await secureSessionStore.logSecurityEvent('oauth_callback_failed', req.ip, req.get('User-Agent'), {
      provider: 'google',
      error: error.message
    })

    const errorUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/signin?error=${encodeURIComponent('OAuth authentication failed')}`
    res.redirect(errorUrl)
  }
}

// Start GitHub OAuth flow
export async function githubStart(req, res) {
  try {
    const state = crypto.randomBytes(32).toString('hex')

    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000
    })

    const authUrl = githubOAuthService.getAuthorizationUrl(state)
    res.json({ authUrl })
  } catch (error) {
    console.error('GitHub OAuth start error:', error)
    res.status(500).json({ error: 'Failed to start GitHub OAuth flow' })
  }
}

// GitHub OAuth callback
export async function githubCallback(req, res) {
  try {
    const { code, state } = req.query

    if (!code) {
      return res.status(400).json({ error: 'Authorization code required' })
    }

    const storedState = req.cookies?.oauth_state
    if (!state || !storedState || state !== storedState) {
      console.warn('GitHub OAuth state mismatch - possible CSRF attack')
      await secureSessionStore.logSecurityEvent('suspicious_activity', req.ip, req.get('User-Agent'), {
        reason: 'OAuth state mismatch',
        provider: 'github'
      })
      const errorUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/signin?error=${encodeURIComponent('Authentication failed: invalid state')}`
      return res.redirect(errorUrl)
    }

    res.clearCookie('oauth_state', { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', path: '/' })

    const tokens = await githubOAuthService.exchangeCodeForToken(code)
    const userInfo = await githubOAuthService.getUserInfo(tokens.access_token)

    const sessionToken = `oauth_${crypto.randomBytes(32).toString('hex')}`
    await secureSessionStore.createSession(sessionToken, userInfo, 'github')

    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: 15 * 24 * 60 * 60 * 1000
    }

    res.cookie('access_token', sessionToken, cookieOptions)
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/success?provider=github`
    res.redirect(redirectUrl)
  } catch (error) {
    console.error('GitHub OAuth callback error:', error)
    await secureSessionStore.logSecurityEvent('oauth_callback_failed', req.ip, req.get('User-Agent'), {
      provider: 'github',
      error: error.message
    })
    const errorUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/signin?error=${encodeURIComponent('GitHub authentication failed')}`
    res.redirect(errorUrl)
  }
}

// Password forgot
export async function passwordForgot(req, res) {
  try {
    const email = emailSchema.parse(req.body?.email)

    const { error } = await supabaseUserClient.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/reset`
    })

    if (error) {
      console.warn('Password forgot notice:', error.message)
    }

    // Generic response prevents email enumeration
    res.json({ success: true, message: 'If an account exists with this email, a password reset link has been sent.' })
  } catch (error) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({ error: error.errors?.[0]?.message || 'Valid email is required' })
    }
    console.error('Password forgot error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Password reset
export async function passwordReset(req, res) {
  try {
    const password = passwordSchema.parse(req.body?.password)

    // The access_token should come from the reset email link (via cookie or Authorization header)
    // Never accept tokens from request body — they may appear in proxy/server access logs
    const tokenToUse = req.cookies?.access_token || req.headers.authorization?.replace('Bearer ', '')

    if (!tokenToUse) {
      return res.status(401).json({ error: 'Authentication token required for password reset' })
    }

    // Verify the user via the token before updating password
    const { data: { user }, error: verifyError } = await supabaseAdminClient.auth.getUser(tokenToUse)

    if (verifyError || !user) {
      return res.status(401).json({ error: 'Invalid or expired reset token' })
    }

    // Update password using admin client with the verified user ID
    const { error } = await supabaseAdminClient.auth.admin.updateUserById(user.id, {
      password: password
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    res.json({ success: true, message: 'Password updated successfully' })
  } catch (error) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({ error: error.errors?.[0]?.message || 'Invalid password' })
    }
    console.error('Password reset error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Resend verification email
export async function resendVerification(req, res) {
  try {
    const email = emailSchema.parse(req.body?.email)
    const normalizedEmail = email.toLowerCase().trim()

    if (!secureSessionStore.checkRateLimit(`resend:${normalizedEmail}`)) {
      return res.status(429).json({
        error: 'Too many verification email requests. Please wait 15 minutes before trying again.'
      })
    }
    secureSessionStore.recordFailedAttempt(`resend:${normalizedEmail}`)

    const { error } = await supabaseUserClient.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/confirm`,
      }
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    res.json({ success: true, message: 'Verification email resent' })
  } catch (error) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({ error: error.errors?.[0]?.message || 'Valid email is required' })
    }
    console.error('Resend verification error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Exchange a Supabase confirmation/recovery access token for httpOnly session cookies
export async function exchangeSession(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '')
    const refreshToken = req.body?.refresh_token

    if (!accessToken) {
      return res.status(401).json({ error: 'Access token required' })
    }

    const { data: { user: supabaseUser }, error } = await supabaseUserClient.auth.getUser(accessToken)
    if (error || !supabaseUser) {
      return res.status(401).json({ error: 'Invalid or expired verification token' })
    }

    let user = supabaseUser
    try {
      const sub = await getUserSubscription(user.id)
      user = sub ? { ...user, ...sub } : { ...user, is_admin: false }
    } catch {
      user = { ...user, is_admin: false }
    }

    setSessionCookies(res, { access_token: accessToken, refresh_token: refreshToken })
    res.json({ success: true, user })
  } catch (error) {
    console.error('Exchange session error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}


