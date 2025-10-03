import { supabaseUserClient, supabaseAdminClient, getSupabaseAuthUrls } from '../supabase/client.js'
import { signInSchema, signUpSchema } from '../utils/validators.js'
import googleOAuthService from '../services/googleOAuthService.js'
import secureSessionStore from '../services/sessionStore.js'

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

    setSessionCookies(res, data.session)
    res.json({ 
      message: 'Signed in successfully',
      user: data.user 
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
    const authUrl = await googleOAuthService.getAuthorizationUrl()
    res.json({ authUrl })
  } catch (error) {
    console.error('Google OAuth start error:', error)
    res.status(500).json({ error: 'Failed to start OAuth flow' })
  }
}

// Google OAuth callback
export async function googleCallback(req, res) {
  try {
    const { code } = req.query
    
    if (!code) {
      return res.status(400).json({ error: 'Authorization code required' })
    }

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
    const { password } = req.body
    
    if (!password) {
      return res.status(400).json({ error: 'New password required' })
    }

    const { error } = await supabaseUserClient.auth.updateUser({
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


