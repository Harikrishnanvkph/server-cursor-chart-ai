import { supabaseAdminClient } from '../supabase/client.js';
import secureSessionStore from '../services/sessionStore.js';

// Helper function to ensure user profile exists
async function ensureUserProfile(userId, userEmail = null, userName = null, userAvatar = null) {
  try {
    // Check if profile exists
    const { data: existingProfile, error: profileCheckError } = await supabaseAdminClient
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .single();

    if (existingProfile && !profileCheckError) {
      // Profile already exists, no need to create
      return existingProfile;
    }

    console.log('Profile not found for user:', userId, 'Attempting to create profile...');
    
    // Try to get user info from auth.users first
    let authUser = null;
    try {
      const { data, error: authError } = await supabaseAdminClient.auth.admin.getUserById(userId);
      if (!authError && data.user) {
        authUser = data.user;
      }
    } catch (err) {
      // User might not exist in auth.users (OAuth users stored differently)
      console.log('User not found in auth.users, will use provided user data');
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
    const { data: newProfile, error: profileError } = await supabaseAdminClient
      .from('profiles')
      .insert([profileData])
      .select()
      .single();

    if (profileError) {
      console.error('Error creating profile:', profileError);
      return null;
    } else {
      console.log('✅ Profile created for user:', userId);
      return newProfile;
    }
  } catch (error) {
    console.error('Error ensuring user profile:', error);
    return null;
  }
}

// Simple in-memory auth cache (token -> { user, expiresAt })
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedUser(token) {
  if (!token) return null;
  const entry = authCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCache.delete(token);
    return null;
  }
  return entry.user;
}

function setCachedUser(token, user) {
  if (!token || !user) return;
  authCache.set(token, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 100; // Max requests per IP per window
const BLOCKED_IPS = new Set(); // IPs that are permanently blocked
const SUSPICIOUS_IPS = new Map(); // IPs with suspicious activity

// Rate limiting storage
const rateLimitStore = new Map();

// Helper function to get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress || 
         'unknown';
}

// Rate limiting middleware
function rateLimitMiddleware(req, res, next) {
  const clientIP = getClientIP(req);
  
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
  
  // Rate limiting logic
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  if (!rateLimitStore.has(clientIP)) {
    rateLimitStore.set(clientIP, []);
  }
  
  const requests = rateLimitStore.get(clientIP);
  
  // Remove old requests outside the current window
  const validRequests = requests.filter(timestamp => timestamp > windowStart);
  rateLimitStore.set(clientIP, validRequests);
  
  // Check if current request exceeds limit
  if (validRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    // Mark IP as suspicious
    SUSPICIOUS_IPS.set(clientIP, {
      blockedUntil: now + (30 * 60 * 1000), // Block for 30 minutes
      reason: 'Rate limit exceeded'
    });
    
    console.warn(`Rate limit exceeded for IP: ${clientIP}, blocking for 30 minutes`);
    return res.status(429).json({ 
      error: 'Too many requests', 
      retryAfter: 1800 // 30 minutes in seconds
    });
  }
  
  // Add current request timestamp
  validRequests.push(now);
  
  next();
}

// Clean up old rate limit data
setInterval(() => {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  for (const [ip, requests] of rateLimitStore.entries()) {
    const validRequests = requests.filter(timestamp => timestamp > windowStart);
    if (validRequests.length === 0) {
      rateLimitStore.delete(ip);
    } else {
      rateLimitStore.set(ip, validRequests);
    }
  }
  
  // Clean up expired suspicious IP blocks
  for (const [ip, info] of SUSPICIOUS_IPS.entries()) {
    if (now > info.blockedUntil) {
      SUSPICIOUS_IPS.delete(ip);
    }
  }
}, 5 * 60 * 1000); // Clean up every 5 minutes

// Authentication middleware
export async function requireAuth(req, res, next) {
  try {
    const accessToken = req.cookies?.access_token;
    const clientIP = getClientIP(req);
    
    if (!accessToken) {
      console.warn('No access token provided');
      return res.status(401).json({ error: 'Authentication required' });
    }

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
    
    // First try Supabase token validation
    try {
      const url = `${process.env.SUPABASE_URL}/auth/v1/user`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': process.env.SUPABASE_ANON_KEY || ''
        }
      });
      
      if (response.ok) {
        const user = await response.json();
        
        // Ensure user has a profile
        await ensureUserProfile(user.id, user.email, user.user_metadata?.name, user.user_metadata?.avatar_url);
        
        setCachedUser(accessToken, user);
        req.user = user;
        return next();
      }
    } catch (supabaseError) {
      // Fallback to OAuth session validation when Supabase validation fails
    }
    
    // If Supabase validation failed, check OAuth session
    try {
      const oauthUser = await secureSessionStore.validateSession(accessToken);
      
      if (oauthUser) {
        console.log('OAuth user validated:', {
          userId: oauthUser.user_id || oauthUser.id,
          email: oauthUser.email,
          provider: oauthUser.provider
        });
        
        // Use user_id if available (from validateSession), otherwise fall back to id
        const userId = oauthUser.user_id || oauthUser.id;
        
        // Ensure user has a profile (OAuth users have email, full_name, avatar_url directly)
        await ensureUserProfile(userId, oauthUser.email, oauthUser.full_name, oauthUser.avatar_url);
        
        // Create a normalized user object with consistent ID field
        const normalizedUser = {
          id: userId,
          email: oauthUser.email,
          full_name: oauthUser.full_name,
          avatar_url: oauthUser.avatar_url,
          provider: oauthUser.provider
        };
        
        setCachedUser(accessToken, normalizedUser);
        req.user = normalizedUser;
        return next();
      }
    } catch (sessionError) {
      console.error('OAuth session validation error:', sessionError);
    }
    
    // No valid authentication found
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
    const clientIP = getClientIP(req);
    
    if (!accessToken) {
      console.warn('No access token provided');
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
    
    // Check if user has admin privileges
    // This would depend on your user role system
    const isAdmin = req.user.role === 'admin' || req.user.is_admin === true;
    
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


