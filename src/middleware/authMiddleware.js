import { supabaseAdminClient, supabaseUserClient } from '../supabase/client.js';
import secureSessionStore from '../services/sessionStore.js';
import crypto from 'crypto';

// Helper to wrap a promise with a timeout
function withTimeout(promise, ms, errorMessage = 'Request timed out') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), ms);
    promise
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// Helper function to ensure user profile exists
async function ensureUserProfile(userId, userEmail = null, userName = null, userAvatar = null) {
  try {
    // Check if profile exists with a timeout
    const { data: existingProfile, error: profileCheckError } = await withTimeout(
      supabaseAdminClient
        .from('profiles')
        .select('id, is_admin, full_name, avatar_url')
        .eq('id', userId)
        .single(),
      5000,
      'Profile check timed out'
    );

    if (existingProfile && !profileCheckError) {
      // Profile already exists, no need to create
      return existingProfile;
    }

    console.warn('⚠️ Profile not found for user:', userId, '. Attempting to create...');

    // Try to get user info from auth.users first
    let authUser = null;
    try {
      const { data, error: authError } = await withTimeout(
        supabaseAdminClient.auth.admin.getUserById(userId),
        4000,
        'GetUserById timed out'
      );
      if (!authError && data?.user) {
        authUser = data.user;
      }
    } catch (err) {
      // User might not exist in auth.users (OAuth users stored differently)
    }

    // Prepare profile data
    const profileData = {
      id: userId,
      email: userEmail || authUser?.email || 'unknown@example.com',
      full_name: userName || authUser?.user_metadata?.full_name || authUser?.user_metadata?.name || null,
      avatar_url: userAvatar || authUser?.user_metadata?.avatar_url || null,
      provider: authUser?.app_metadata?.provider || 'google',
      provider_id: authUser?.user_metadata?.provider_id || null,
    };

    // Create profile
    const { data: newProfile, error: profileError } = await withTimeout(
      supabaseAdminClient
        .from('profiles')
        .insert([profileData])
        .select('id, is_admin, full_name, avatar_url')
        .single(),
      5000,
      'Profile creation timed out'
    );

    if (profileError) {
      console.error('❌ Failed to create profile for user:', userId, profileError.message);
      return null;
    }

    console.log('✅ Profile created for user:', userId);
    return newProfile;
  } catch (error) {
    console.error('❌ Error in ensureUserProfile for user:', userId, error.message);
    return null;
  }
}

// Simple in-memory auth cache (hashed token -> { user, expiresAt })
// Tokens are SHA-256 hashed before storage so a memory dump doesn't expose raw tokens
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes ceiling, always clamped to token exp/expires_at
const MAX_AUTH_CACHE_SIZE = 500;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Safely extract JWT `exp` claim (in ms) without trusting it for auth — used only to clamp cache TTL
function getJwtExpMs(token) {
  if (!isJwtFormat(token)) return null;
  try {
    const payloadJson = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function getCachedUser(token) {
  if (!token) return null;
  const key = hashToken(token);
  const entry = authCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCache.delete(key);
    return null;
  }
  return entry.user;
}

export function setCachedUser(token, user, explicitExpiresAtMs = null) {
  if (!token || !user) return;
  const now = Date.now();
  const maxExpiry = now + AUTH_CACHE_TTL_MS;
  const tokenExpiry = explicitExpiresAtMs ?? getJwtExpMs(token);
  const effectiveExpiry = tokenExpiry ? Math.min(maxExpiry, tokenExpiry) : maxExpiry;
  // Never cache an already-expired token
  if (effectiveExpiry <= now) return;

  // Normalize top-level profile fields so cached JWT users always match OAuth user shape
  if (!user.full_name) {
    user.full_name = user.user_metadata?.full_name || user.user_metadata?.name || null;
  }
  if (!user.avatar_url) {
    user.avatar_url = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
  }
  if (!user.provider) {
    user.provider = user.app_metadata?.provider || 'email';
  }

  const key = hashToken(token);
  // Evict oldest entry if cache is full to prevent unbounded memory growth
  if (authCache.size >= MAX_AUTH_CACHE_SIZE) {
    const oldestKey = authCache.keys().next().value;
    if (oldestKey) authCache.delete(oldestKey);
  }
  authCache.set(key, { user, expiresAt: effectiveExpiry });
}

export function invalidateCachedUser(token) {
  if (!token) return;
  const key = hashToken(token);
  authCache.delete(key);
}

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 100; // Max requests per IP per window
const BLOCKED_IPS = new Set(); // IPs that are permanently blocked
const SUSPICIOUS_IPS = new Map(); // IPs with suspicious activity

// Helper function to get client IP
// Rely on Express's proxy-aware req.ip (configured with `trust proxy: 1` in index.js)
// instead of reading the leftmost client-spoofable X-Forwarded-For entry directly.
function getClientIP(req) {
  return (
    req.ip ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

// ============================================================
// Sliding-window rate limiter (O(1) per request)
// Two half-period buckets: curr (this window half) + prev (last window half)
// Estimated count = prev × (fraction of window remaining) + curr
// ============================================================
const RATE_HALF = RATE_LIMIT_WINDOW / 2; // 7.5 minutes
const rateLimitStore = new Map(); // Map<ip, { curr, prev, halfStart }>

function getSlidingCount(ip) {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);

  if (!entry) {
    entry = { curr: 0, prev: 0, halfStart: now };
    rateLimitStore.set(ip, entry);
  }

  const elapsed = now - entry.halfStart;

  if (elapsed >= RATE_HALF * 2) {
    // Both buckets expired — full reset
    entry.prev = 0;
    entry.curr = 0;
    entry.halfStart = now;
  } else if (elapsed >= RATE_HALF) {
    // Half-period rolled over — shift buckets
    entry.prev = entry.curr;
    entry.curr = 0;
    entry.halfStart = now - (elapsed - RATE_HALF);
  }

  // Weighted count: prev bucket weighted by remaining fraction
  const prevWeight = Math.max(0, 1 - (elapsed % RATE_HALF) / RATE_HALF);
  return Math.floor(entry.prev * prevWeight) + entry.curr;
}

function incrementSlidingCount(ip) {
  const entry = rateLimitStore.get(ip);
  if (entry) entry.curr++;
}

// Clean up idle entries every 15 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW * 2;
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (entry.halfStart < cutoff) rateLimitStore.delete(ip);
  }
  // Clean up expired suspicious IP blocks
  const now = Date.now();
  for (const [ip, info] of SUSPICIOUS_IPS.entries()) {
    if (now > info.blockedUntil) SUSPICIOUS_IPS.delete(ip);
  }
  // Clean up expired refresh-token grace cache entries
  for (const [token, entry] of recentRefreshes.entries()) {
    if (now > entry.expiresAt) recentRefreshes.delete(token);
  }
}, 15 * 60 * 1000).unref?.();

function rateLimitMiddleware(req, res, next) {
  const clientIP = getClientIP(req);

  const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1' || clientIP === 'localhost';
  if (process.env.NODE_ENV !== 'production' && isLocal) {
    return next();
  }

  // Check if IP is permanently blocked
  if (BLOCKED_IPS.has(clientIP)) {
    console.warn(`Blocked request from permanently blocked IP: ${clientIP}`);
    return res.status(403).json({ error: 'Access denied' });
  }

  // Check if IP is temporarily blocked due to suspicious activity
  const suspiciousInfo = SUSPICIOUS_IPS.get(clientIP);
  if (suspiciousInfo && Date.now() < suspiciousInfo.blockedUntil) {
    console.warn(`Blocked request from temporarily blocked IP: ${clientIP}`);
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((suspiciousInfo.blockedUntil - Date.now()) / 1000)
    });
  }

  // Sliding window count check
  const count = getSlidingCount(clientIP);

  if (count >= MAX_REQUESTS_PER_WINDOW) {
    SUSPICIOUS_IPS.set(clientIP, {
      blockedUntil: Date.now() + (30 * 60 * 1000),
      reason: 'Rate limit exceeded'
    });
    console.warn(`Rate limit exceeded for IP: ${clientIP}, blocking for 30 minutes`);
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: 1800
    });
  }

  incrementSlidingCount(clientIP);
  next();
}

// In-flight refresh deduplication map to prevent Supabase Refresh Token Rotation race conditions
const inFlightRefreshes = new Map();
// Short-lived grace cache (refreshToken -> { refreshResult, expiresAt }) so slightly delayed
// requests still carrying a just-rotated refresh_token (before Set-Cookie reached the browser)
// reuse the new session instead of re-submitting the consumed refresh token to Supabase.
const recentRefreshes = new Map();
const RECENT_REFRESH_GRACE_MS = 15 * 1000; // 15 seconds

// Helper to determine if a token is a standard JWT (e.g. Supabase) vs an opaque OAuth token (e.g. Google ya29.*)
export function isJwtFormat(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3;
}

// Authentication middleware
export async function requireAuth(req, res, next) {
  try {
    // Idempotency guard: if an earlier middleware in the chain already authenticated this request,
    // never re-validate or re-trigger a rotating refresh token exchange.
    if (req.user) {
      return next();
    }

    const accessToken = req.cookies?.access_token;
    const refreshToken = req.cookies?.refresh_token;
    const clientIP = getClientIP(req);

    // Set when we could not *verify* the access token (Supabase/DB outage, timeout) as opposed to
    // having verified that it is invalid. Transient failures must never look like a logout.
    let accessTokenCheckUnavailable = false;

    // If access token is present, attempt to validate it first
    if (accessToken) {
      // Cache short-circuit
      const cached = getCachedUser(accessToken);
      if (cached) {
        req.user = cached;
        return next();
      }

      // Check if IP is blocked
      if (BLOCKED_IPS.has(clientIP)) {
        console.warn(`Blocked request from blocked IP: ${clientIP}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      // Token type decides which backend can validate it, so only ONE lookup is ever made:
      //  - Supabase JWT (3 dot-separated parts)  -> Supabase /auth/v1/user
      //  - Opaque `oauth_*` session token (Google) -> oauth_sessions table
      // (Previously an expired JWT also paid for a pointless oauth_sessions query, and vice versa.)
      if (isJwtFormat(accessToken)) {
        try {
          const url = `${process.env.SUPABASE_URL}/auth/v1/user`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

          let response;
          try {
            response = await fetch(url, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'apikey': process.env.SUPABASE_ANON_KEY || ''
              },
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeoutId);
          }

          if (response.ok) {
            const user = await response.json();

            // Ensure user has a profile
            const profile = await ensureUserProfile(user.id, user.email, user.user_metadata?.name, user.user_metadata?.avatar_url);

            const enrichedUser = {
              ...user,
              full_name: profile?.full_name || user.user_metadata?.full_name || user.user_metadata?.name || null,
              avatar_url: profile?.avatar_url || user.user_metadata?.avatar_url || null,
              provider: user.app_metadata?.provider || 'email',
              is_admin: profile?.is_admin === true
            };

            // Never cache a user whose profile lookup failed: we would pin is_admin=false until TTL expiry
            if (profile) setCachedUser(accessToken, enrichedUser);
            req.user = enrichedUser;
            return next();
          }

          // 5xx / 429 from Supabase = service trouble, not a bad token.
          // 401 / 403 = expired or invalid token -> fall through to the refresh-token flow.
          if (response.status >= 500 || response.status === 429) {
            console.warn(`Supabase token validation unavailable (HTTP ${response.status})`);
            accessTokenCheckUnavailable = true;
          }
        } catch (supabaseError) {
          console.warn('Supabase token validation failed or timed out:', supabaseError.message);
          accessTokenCheckUnavailable = true;
        }
      } else {
        try {
          const oauthUser = await secureSessionStore.validateSession(accessToken);

          if (oauthUser) {
            // validateSession already joined the profile (incl. is_admin), so the extra
            // ensureUserProfile round-trip is unnecessary here.
            const normalizedUser = {
              id: oauthUser.user_id || oauthUser.id,
              email: oauthUser.email,
              full_name: oauthUser.full_name,
              avatar_url: oauthUser.avatar_url,
              provider: oauthUser.provider,
              is_admin: oauthUser.is_admin === true
            };

            const oauthExpiresAtMs = oauthUser.expires_at ? new Date(oauthUser.expires_at).getTime() : null;
            setCachedUser(accessToken, normalizedUser, Number.isFinite(oauthExpiresAtMs) ? oauthExpiresAtMs : null);
            req.user = normalizedUser;
            return next();
          }
        } catch (sessionError) {
          // validateSession only throws for infrastructure failures (DB timeout / network),
          // never for "session not found" - so this is NOT an invalid session.
          console.error('OAuth session validation unavailable:', sessionError.message);
          accessTokenCheckUnavailable = true;
        }
      }

      if (accessTokenCheckUnavailable) {
        // Do not burn a rotating refresh token or report 401 while the backing store is unreachable.
        // The client treats 503 as transient and keeps the user signed in.
        return res.status(503).json({
          error: 'Authentication service temporarily unavailable. Please retry.',
          code: 'AUTH_UNAVAILABLE'
        });
      }
    }

    // If we reach here, the access token was either missing, invalid, or expired.
    // Try to refresh the session using the refresh token if available.
    if (refreshToken) {
      console.log('Access token invalid/expired. Attempting to refresh session using refresh token...');
      try {
        // Mutex + Grace Cache: Deduplicate concurrent AND slightly-delayed refresh requests
        // for the same refresh token under Supabase Refresh Token Rotation (keyed by SHA-256 hash).
        const refreshKey = hashToken(refreshToken);
        const cachedRefresh = recentRefreshes.get(refreshKey);
        let refreshResult;
        if (cachedRefresh && Date.now() < cachedRefresh.expiresAt) {
          refreshResult = cachedRefresh.result;
        } else {
          if (cachedRefresh) recentRefreshes.delete(refreshKey);
          let refreshPromise = inFlightRefreshes.get(refreshKey);
          if (!refreshPromise) {
            refreshPromise = withTimeout(
              supabaseUserClient.auth.refreshSession({ refresh_token: refreshToken }),
              10000,
              'Supabase session refresh timed out'
            );
            inFlightRefreshes.set(refreshKey, refreshPromise);
            refreshPromise.finally(() => inFlightRefreshes.delete(refreshKey));
          }
          refreshResult = await refreshPromise;
          if (refreshResult?.data?.session && refreshResult?.data?.user && !refreshResult?.error) {
            recentRefreshes.set(refreshKey, {
              result: refreshResult,
              expiresAt: Date.now() + RECENT_REFRESH_GRACE_MS,
            });
          }
        }
        const { data: refreshData, error: refreshError } = refreshResult;

        if (refreshError || !refreshData?.session || !refreshData?.user) {
          throw refreshError || new Error('Invalid refresh response');
        }

        const user = refreshData.user;
        const newSession = refreshData.session;

        // Ensure user has a profile
        const profile = await ensureUserProfile(user.id, user.email, user.user_metadata?.name, user.user_metadata?.avatar_url);

        const enrichedUser = {
          ...user,
          full_name: profile?.full_name || user.user_metadata?.full_name || user.user_metadata?.name || null,
          avatar_url: profile?.avatar_url || user.user_metadata?.avatar_url || null,
          provider: user.app_metadata?.provider || 'email',
          is_admin: profile?.is_admin === true
        };

        // Update response cookies with the new session tokens
        const isProd = process.env.NODE_ENV === 'production';
        const cookieOptions = {
          httpOnly: true,
          secure: isProd,
          sameSite: isProd ? 'none' : 'lax',
          path: '/',
        };

        // Align access_token cookie lifetime to 15 days so browser does not discard it after 1 hour
        const sessionLifetimeMs = 15 * 24 * 60 * 60 * 1000;
        res.cookie('access_token', newSession.access_token, { 
          ...cookieOptions, 
          maxAge: sessionLifetimeMs 
        });
        
        if (newSession.refresh_token) {
          res.cookie('refresh_token', newSession.refresh_token, { 
            ...cookieOptions, 
            maxAge: 30 * 24 * 60 * 60 * 1000 
          });
        }

        // Sync req.cookies in-place so downstream middleware/handlers see the rotated tokens
        if (req.cookies) {
          req.cookies.access_token = newSession.access_token;
          if (newSession.refresh_token) {
            req.cookies.refresh_token = newSession.refresh_token;
          }
        }

        if (profile) setCachedUser(newSession.access_token, enrichedUser);
        req.user = enrichedUser;
        console.log(`Successfully refreshed session for user: ${user.email}`);
        return next();

      } catch (refreshErr) {
        console.warn('Failed to refresh Supabase session:', refreshErr.message);

        const errMsg = String(refreshErr?.message || '').toLowerCase();
        const isDefinitiveAuthFailure =
          errMsg.includes('invalid') ||
          errMsg.includes('revoked') ||
          errMsg.includes('already used') ||
          errMsg.includes('not found') ||
          errMsg.includes('invalid_grant');

        // Only clear cookies if token is proven definitively invalid or revoked.
        // DO NOT clear cookies on network timeouts or temporary server blips!
        if (isDefinitiveAuthFailure) {
          // Mirror the attributes used when the cookies were set, otherwise cross-site deletes are ignored
          const clearOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            path: '/'
          };
          res.clearCookie('access_token', clearOptions);
          res.clearCookie('refresh_token', clearOptions);
          return res.status(401).json({ error: 'Session expired, please sign in again', code: 'SESSION_REVOKED' });
        }

        return res.status(503).json({ error: 'Authentication service temporarily unavailable. Please retry.', code: 'AUTH_TIMEOUT' });
      }
    }

    // No valid authentication or refresh token found
    console.warn('No valid authentication found');
    return res.status(401).json({ error: 'Invalid or expired token' });

  } catch (error) {
    console.error('Authentication middleware error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

// Enhanced authentication middleware with additional security checks
export async function requireAuthEnhanced(req, res, next) {
  try {
    const accessToken = req.cookies?.access_token;
    const refreshToken = req.cookies?.refresh_token;
    const clientIP = getClientIP(req);

    if (!accessToken && !refreshToken) {
      console.warn('No access or refresh token provided');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Additional security checks
    const userAgent = req.headers['user-agent'];
    const referer = req.headers['referer'];

    // Check for suspicious patterns
    if (userAgent && (
      userAgent.includes('bot') ||
      userAgent.includes('crawler') ||
      userAgent.includes('spider') ||
      userAgent === 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)' // Known malicious UA
    )) {
      console.warn(`Suspicious user agent detected: ${userAgent}`);
      // Don't block immediately, but log for monitoring
    }

    // Check for missing or suspicious referer (for certain endpoints)
    if (req.method === 'POST' && !referer) {
      console.warn('Missing referer header for POST request');
      // This could be a CSRF attempt, but don't block immediately
    }

    // Proceed with normal authentication
    return requireAuth(req, res, next);

  } catch (error) {
    console.error('Enhanced authentication middleware error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

// Admin-only middleware
export async function requireAdmin(req, res, next) {
  try {
    // First check if user is authenticated
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if user has admin privileges (database flag only — no spoofable fallbacks)
    const isAdmin = req.user.is_admin === true;

    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin privileges required' });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    return res.status(500).json({ error: 'Authorization error' });
  }
}

// Block IP address (for security purposes)
export function blockIP(ipAddress, reason = 'Security violation') {
  BLOCKED_IPS.add(ipAddress);
  console.warn(`IP ${ipAddress} blocked permanently. Reason: ${reason}`);
}

// Unblock IP address
export function unblockIP(ipAddress) {
  const wasBlocked = BLOCKED_IPS.delete(ipAddress);
  if (wasBlocked) {
    console.warn(`IP ${ipAddress} unblocked`);
  }
  return wasBlocked;
}

// Get security statistics
export function getSecurityStats() {
  return {
    blockedIPs: Array.from(BLOCKED_IPS),
    suspiciousIPs: Array.from(SUSPICIOUS_IPS.entries()).map(([ip, info]) => ({
      ip,
      blockedUntil: info.blockedUntil,
      reason: info.reason
    })),
    rateLimitStats: {
      totalTrackedIPs: rateLimitStore.size,
      windowSize: RATE_LIMIT_WINDOW,
      maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW
    },
    timestamp: new Date().toISOString()
  };
}

// Export rate limiting middleware for use in routes
export { rateLimitMiddleware };


