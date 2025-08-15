import { supabaseUserClient, supabaseAdminClient, getSupabaseAuthUrls } from '../supabase/client.js'
import { signInSchema, signUpSchema } from '../utils/validators.js'

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
    res.cookie('refresh_token', session.refresh_token, { ...cookieOptions, maxAge: 60 * 60 * 24 * 90 * 1000 })
  }
}

export async function signUp(req, res) {
  try {
    const { email, password, fullName } = signUpSchema.parse(req.body)
    // Check if user already exists to avoid sending a new verification email
    if (supabaseAdminClient) {
      const { data: existing, error: existingErr } = await supabaseAdminClient
        .from('auth.users')
        .select('id')
        .eq('email', email)
        .maybeSingle()
      if (!existingErr && existing) {
        return res.status(409).json({ error: 'Email already registered' })
      }
    }
    const { data, error } = await supabaseUserClient.auth.signUp({
      email,
      password,
      options: {
        data: fullName ? { full_name: fullName } : undefined,
        emailRedirectTo: process.env.APP_ORIGIN ? `${process.env.APP_ORIGIN}/auth/confirm` : undefined,
      },
    })
    if (error) {
      if (error.message?.toLowerCase().includes('user already registered')) {
        return res.status(409).json({ error: 'Email already registered' })
      }
      return res.status(400).json({ error: 'Unable to sign up' })
    }

    // If email confirmations are disabled, session may be present
    if (data.session) setSessionCookies(res, data.session)

    // Optional: ensure profile row
    if (data.user && supabaseAdminClient) {
      const { error: profileError } = await supabaseAdminClient
        .from('profiles')
        .upsert({ id: data.user.id, email: data.user.email, full_name: fullName || null }, { onConflict: 'id' })
      if (profileError) {
        console.error('Failed to upsert into public.profiles:', profileError)
      }
    }

    const identities = Array.isArray(data.user?.identities) ? data.user.identities : []
    const wasNewUser = identities.length > 0
    return res.status(200).json({ user: data.user, requiresEmailConfirmation: !data.session, wasNewUser })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
}

export async function signIn(req, res) {
  try {
    const { email, password } = signInSchema.parse(req.body)
    const { data, error } = await supabaseUserClient.auth.signInWithPassword({ email, password })
    if (error) return res.status(400).json({ error: 'Invalid email or password' })
    setSessionCookies(res, data.session)
    return res.status(200).json({ user: data.user })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
}

export async function me(req, res) {
  try {
    const access = req.cookies?.access_token
    if (!access) return res.status(200).json({ user: null })
    const url = getSupabaseAuthUrls().user
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access}`, apikey: process.env.SUPABASE_ANON_KEY || '' } })
    if (!r.ok) return res.status(200).json({ user: null })
    const user = await r.json()
    return res.status(200).json({ user })
  } catch (err) {
    return res.status(200).json({ user: null })
  }
}

export async function signOut(req, res) {
  try {
    res.clearCookie('access_token', { path: '/' })
    res.clearCookie('refresh_token', { path: '/' })
    return res.status(200).json({ success: true })
  } catch (err) {
    return res.status(200).json({ success: true })
  }
}

export async function googleStart(req, res) {
  try {
    const redirectTo = new URL(req.query.redirectTo || process.env.SERVER_PUBLIC_URL + '/auth/google/callback')
    const params = new URLSearchParams({
      provider: 'google',
      redirect_to: redirectTo.toString(),
    })
    const authUrl = `${getSupabaseAuthUrls().authorize}?${params.toString()}`
    return res.redirect(authUrl)
  } catch (err) {
    return res.status(400).json({ error: 'Failed to start Google OAuth' })
  }
}

export async function googleCallback(req, res) {
  try {
    const code = req.query.code
    if (!code) return res.status(400).send('Missing code')
    const redirectUri = `${process.env.SERVER_PUBLIC_URL}/auth/google/callback`
    const tokenUrl = `${getSupabaseAuthUrls().token}?grant_type=authorization_code`
    const tr = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_ANON_KEY || '',
      },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    })
    if (!tr.ok) {
      const text = await tr.text()
      return res.status(400).send(`OAuth exchange failed: ${text}`)
    }
    const tokens = await tr.json()
    setSessionCookies(res, tokens)
    const redirectBack = process.env.APP_ORIGIN || '/'
    return res.redirect(redirectBack)
  } catch (err) {
    return res.status(400).send('OAuth callback error')
  }
}

export async function passwordForgot(req, res) {
  try {
    const email = String(req.body?.email || '').trim()
    if (!email) return res.status(400).json({ error: 'Email is required' })
    const redirectTo = process.env.APP_ORIGIN ? `${process.env.APP_ORIGIN}/auth/reset` : undefined
    const { error } = await supabaseUserClient.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) {
      return res.status(400).json({ error: 'Unable to send reset email. Please try again.' })
    }
    return res.status(200).json({ success: true })
  } catch (err) {
    return res.status(400).json({ error: 'Unable to send reset email. Please try again.' })
  }
}

export async function passwordReset(req, res) {
  try {
    const token = String(req.body?.token || '').trim()
    const password = String(req.body?.password || '')
    if (!token || !password) return res.status(400).json({ error: 'Missing token or password' })
    const supabaseWithToken = await (await import('@supabase/supabase-js')).createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } }
    )
    const { data, error } = await supabaseWithToken.auth.updateUser({ password })
    if (error) return res.status(400).json({ error: 'Failed to reset password. The link may have expired.' })
    // Set cookies if session is returned (sometimes password recovery returns a session)
    if (data?.session) setSessionCookies(res, data.session)
    return res.status(200).json({ success: true })
  } catch (err) {
    return res.status(400).json({ error: 'Failed to reset password. Please request a new link.' })
  }
}

export async function resendVerification(req, res) {
  try {
    const email = String(req.body?.email || '').trim()
    if (!email) return res.status(400).json({ error: 'Email is required' })
    const redirectTo = process.env.APP_ORIGIN ? `${process.env.APP_ORIGIN}/auth/confirm` : undefined
    const { error } = await supabaseUserClient.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: redirectTo },
    })
    if (error) return res.status(400).json({ error: 'Unable to resend verification email. Try again later.' })
    return res.status(200).json({ success: true })
  } catch (err) {
    return res.status(400).json({ error: 'Unable to resend verification email. Try again later.' })
  }
}


