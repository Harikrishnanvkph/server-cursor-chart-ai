import { supabaseUserClient, supabaseAdminClient, getSupabaseAuthUrls } from '../supabase/client.js'
import { signInSchema, signUpSchema } from '../utils/validators.js'
import googleOAuthService from '../services/googleOAuthService.js'
import secureSessionStore from '../services/sessionStore.js'
import crypto from 'crypto'

const isProd = process.env.NODE_ENV === 'production'

function setSessionCookies(res, session) {
  if (!session) return
  const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  }
  res.cookie('access_token', session.access_token, { ...cookieOptions, maxAge: session.expires_in * 1000 })
  if (session.refresh_token) {
    res.cookie('refresh_token', session.refresh_token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 })
  }
}

function clearSessionCookies(res) {
  res.clearCookie('access_token', { path: '/' })
  res.clearCookie('refresh_token', { path: '/' })
}

// Sign up with email/password
export async function signUp(req, res) {
  try {
    const { email, password, fullName } = signUpSchema.parse(req.body)

    const { data, error } = await supabaseUserClient.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName }
      }
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    res.status(201).json({
      message: 'User created successfully. Please check your email for verification.',
      user: data.user
    })
  } catch (error) {
    console.error('Sign up error:', error)
    res.status(400).json({ error: 'Invalid input data' })
  }
}

// Sign in with email/password
export async function signIn(req, res) {
  try {
    const { email, password } = signInSchema.parse(req.body)

    const { data, error } = await supabaseUserClient.auth.signInWithPassword({
      email,
      password
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    let user = data.user
    
    // Look up admin status from profiles table
    try {
      const { data: profile } = await supabaseAdminClient
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .single()

      user = { ...user, is_admin: profile?.is_admin || false }
    } catch (profileError) {
      console.warn('Failed to fetch admin status for user:', user.id, profileError?.message)
      user = { ...user, is_admin: false }
    }

    setSessionCookies(res, data.session)
    res.json({
      message: 'Signed in successfully',
      user: user
    })
  } catch (error) {
    console.error('Sign in error:', error)
    res.status(400).json({ error: 'Invalid input data' })
  }
}

// Get current user
export async function me(req, res) {
  try {
    const accessToken = req.cookies.access_token || req.headers.authorization?.replace('Bearer ', '')

    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' })
    }

    // Try to validate as OAuth session first
    let user = await secureSessionStore.validateSession(accessToken)

    if (!user) {
      // Try Supabase auth as fallback
      const { data: { user: supabaseUser }, error } = await supabaseUserClient.auth.getUser(accessToken)
      if (error || !supabaseUser) {
        return res.status(401).json({ error: 'Invalid or expired token' })
      }
      user = supabaseUser
    }

    // Look up admin status from profiles table
    const userId = user.user_id || user.id
    try {
      const { data: profile } = await supabaseAdminClient
        .from('profiles')
        .select('is_admin')
        .eq('id', userId)
        .single()

      user = { ...user, is_admin: profile?.is_admin || false }
    } catch (profileError) {
      // If profile lookup fails, default to non-admin
      console.warn('Failed to fetch admin status for user:', userId, profileError?.message)
      user = { ...user, is_admin: false }
    }

    res.json({ user })
  } catch (error) {
    console.error('Me endpoint error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Sign out
export async function signOut(req, res) {
  try {
    const accessToken = req.cookies.access_token || req.headers.authorization?.replace('Bearer ', '')

    if (accessToken) {
      // Try to delete OAuth session
      await secureSessionStore.deleteSession(accessToken)

      // Try Supabase sign out as well
      try {
        await supabaseUserClient.auth.signOut()
      } catch (e) {
        // Ignore Supabase errors
      }
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
      sameSite: 'lax',
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
      const errorUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/error?message=${encodeURIComponent('Authentication failed: invalid state')}`
      return res.redirect(errorUrl)
    }

    // Clear the state cookie
    res.clearCookie('oauth_state', { path: '/' })

    // Exchange code for tokens
    const tokens = await googleOAuthService.exchangeCodeForToken(code)

    // Get user info from Google
    const userInfo = await googleOAuthService.getUserInfo(tokens.access_token)

    // Create or get user session
    const session = await secureSessionStore.createSession(
      tokens.access_token,
      userInfo,
      'google'
    )

    // Set secure cookies
    const cookieOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 24 * 60 * 60 * 1000 // 15 days
    }

    res.cookie('access_token', tokens.access_token, cookieOptions)

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

    const errorUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/error?message=${encodeURIComponent('OAuth authentication failed')}`
    res.redirect(errorUrl)
  }
}

// Password forgot
export async function passwordForgot(req, res) {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email required' })
    }

    const { error } = await supabaseUserClient.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/reset-password`
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    res.json({ message: 'Password reset email sent' })
  } catch (error) {
    console.error('Password forgot error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Password reset
export async function passwordReset(req, res) {
  try {
    const { password, access_token } = req.body

    if (!password) {
      return res.status(400).json({ error: 'New password required' })
    }

    // The access_token should come from the reset email link
    // It authenticates which user is performing the reset
    const tokenToUse = access_token || req.cookies?.access_token || req.headers.authorization?.replace('Bearer ', '')

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

    res.json({ message: 'Password updated successfully' })
  } catch (error) {
    console.error('Password reset error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Resend verification email
export async function resendVerification(req, res) {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email required' })
    }

    const { error } = await supabaseUserClient.auth.resend({
      type: 'signup',
      email: email
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    res.json({ message: 'Verification email resent' })
  } catch (error) {
    console.error('Resend verification error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Guest sign-in — temporary, for testing only
const GUEST_EMAIL = 'guest@aichartor.local'
const GUEST_PASSWORD = 'GuestTester@2026!'

export async function guestSignIn(req, res) {
  try {
    // Try signing in with guest credentials first
    let { data, error } = await supabaseUserClient.auth.signInWithPassword({
      email: GUEST_EMAIL,
      password: GUEST_PASSWORD,
    })

    // If guest user doesn't exist yet, create it
    if (error && (error.message.includes('Invalid login') || error.message.includes('invalid'))) {
      const { data: newUser, error: createError } = await supabaseAdminClient.auth.admin.createUser({
        email: GUEST_EMAIL,
        password: GUEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: 'Guest User' },
      })

      if (createError) {
        console.error('Failed to create guest user:', createError.message)
        return res.status(500).json({ error: 'Failed to create guest account' })
      }

      // Now sign in with the newly created user
      const signInResult = await supabaseUserClient.auth.signInWithPassword({
        email: GUEST_EMAIL,
        password: GUEST_PASSWORD,
      })
      data = signInResult.data
      error = signInResult.error
    }

    if (error) {
      console.error('Guest sign-in error:', error.message)
      return res.status(400).json({ error: error.message })
    }

    setSessionCookies(res, data.session)
    res.json({
      message: 'Signed in as guest',
      user: { ...data.user, full_name: 'Guest User' },
    })
  } catch (error) {
    console.error('Guest sign-in error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}


