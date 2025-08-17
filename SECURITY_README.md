






# AIChartor Security Documentation

## Overview

This document outlines the comprehensive security measures implemented in AIChartor to protect user data, prevent attacks, and ensure secure OAuth authentication.

## 🔒 Security Features Implemented

### 1. **Secure OAuth Authentication**
- **Database-backed sessions**: OAuth sessions are stored securely in the database instead of in-memory
- **Token hashing**: Access tokens are hashed using SHA-256 before storage
- **Automatic cleanup**: Expired sessions are automatically removed
- **Session validation**: Secure token validation with rate limiting

### 2. **Rate Limiting & IP Blocking**
- **Global rate limiting**: 1000 requests per IP per 15-minute window
- **Auth-specific limits**: Stricter limits on authentication endpoints
- **IP blocking**: Automatic blocking of suspicious IPs
- **Temporary blocks**: 30-minute blocks for rate limit violations
- **Permanent blocks**: Admin-controlled permanent IP blocking

### 3. **Enhanced Authentication Middleware**
- **Multi-provider support**: Supabase + OAuth authentication
- **IP validation**: Client IP verification and blocking
- **Session security**: Secure session management
- **Admin controls**: Role-based access control

### 4. **Database Security**
- **Row Level Security (RLS)**: Database-level access control
- **Service role isolation**: Secure database operations
- **Audit logging**: Comprehensive authentication event logging
- **Secure policies**: Database access policies for OAuth users

### 5. **Request Security**
- **Helmet.js**: Security headers and CSP
- **CORS protection**: Controlled cross-origin requests
- **Request size limits**: 10MB maximum request body size
- **Input validation**: Comprehensive request validation

## 🚀 Getting Started

### 1. **Database Setup**

Run the database setup script in your Supabase SQL editor:

```sql
-- Run the contents of src/supabase/setup-database.sql
```

This will create:
- `profiles` table for user data
- `oauth_sessions` table for secure session storage
- `auth_audit_log` table for security monitoring
- All necessary indexes and RLS policies

### 2. **Environment Variables**

Add these security-related environment variables:

```bash
# Required
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Security (optional)
ADMIN_EMAIL=admin@yourdomain.com  # For admin security endpoints
NODE_ENV=production               # Enable strict security in production
```

### 3. **Start the Server**

```bash
npm run dev    # Development mode
npm start      # Production mode
```

## 🛡️ Security Endpoints

### **Public Endpoints**
- `GET /health` - Server health check
- `GET /security/status` - Security status (public info only)

### **Protected Endpoints**
- `GET /admin/security/stats` - Detailed security statistics
- `POST /admin/security/block-ip` - Block malicious IP addresses
- `POST /admin/security/unblock-ip` - Unblock IP addresses

### **Authentication Endpoints**
- `POST /auth/signup` - User registration
- `POST /auth/signin` - User login
- `GET /auth/google` - Google OAuth initiation
- `GET /auth/google/callback` - Google OAuth callback
- `GET /auth/me` - Get current user info
- `POST /auth/signout` - User logout

## 🔍 Security Monitoring

### **Real-time Monitoring**

The system provides comprehensive security monitoring:

```bash
# Check security status
curl http://localhost:3001/security/status

# Get detailed stats (admin only)
curl -H "Cookie: access_token=your_token" \
     http://localhost:3001/admin/security/stats
```

### **Security Metrics**

- **Blocked IPs**: Permanently blocked IP addresses
- **Suspicious IPs**: Temporarily blocked IPs with reasons
- **Rate Limit Stats**: Current rate limiting statistics
- **Session Stats**: Active and expired OAuth sessions

### **Audit Logging**

All authentication events are logged to `auth_audit_log` table:
- User login/logout attempts
- OAuth authentication events
- Failed authentication attempts
- IP addresses and user agents

## 🚨 Threat Protection

### **1. Brute Force Attacks**
- Rate limiting on authentication endpoints
- Automatic IP blocking after multiple failures
- Progressive delays for repeated attempts

### **2. Session Hijacking**
- Secure HTTP-only cookies
- Token hashing in database
- Automatic session expiration
- IP-based session validation

### **3. CSRF Attacks**
- Referer header validation
- Secure cookie settings
- State parameter validation for OAuth

### **4. SQL Injection**
- Parameterized queries via Supabase
- Input validation and sanitization
- Database access through service role only

### **5. XSS Attacks**
- Content Security Policy (CSP)
- Input sanitization
- Secure cookie handling

## 📊 Security Configuration

### **Rate Limiting Configuration**

```javascript
// Global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,                 // 1000 requests per window
  message: 'Too many requests'
});

// Auth-specific rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // 100 requests per window
  message: 'Too many auth attempts'
});
```

### **Session Configuration**

```javascript
// Secure cookie settings
const cookieOptions = {
  httpOnly: true,           // Prevent XSS access
  secure: isProd,           // HTTPS only in production
  sameSite: 'lax',          // CSRF protection
  path: '/',                // Cookie scope
  maxAge: session.expires_in * 1000
};
```

### **Database Security**

```sql
-- RLS policies for OAuth sessions
CREATE POLICY "Service role can manage all OAuth sessions" 
ON public.oauth_sessions
FOR ALL USING (auth.role() = 'service_role');

-- Secure token storage
CREATE TABLE public.oauth_sessions (
  access_token_hash TEXT UNIQUE NOT NULL, -- Hashed tokens only
  user_id UUID NOT NULL REFERENCES public.profiles(id),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
```

## 🚀 Production Deployment

### **1. Environment Setup**

```bash
# Production environment variables
NODE_ENV=production
SUPABASE_URL=your_production_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_production_service_role_key
ADMIN_EMAIL=admin@yourdomain.com
```

### **2. Security Headers**

The server automatically sets security headers:
- `Strict-Transport-Security`
- `Content-Security-Policy`
- `X-Content-Type-Options`
- `X-Frame-Options`
- `X-XSS-Protection`

### **3. Monitoring & Alerts**

Set up monitoring for:
- Failed authentication attempts
- Rate limit violations
- IP blocking events
- Database connection issues

### **4. Backup & Recovery**

- Regular database backups
- Session data persistence
- User profile recovery procedures

## 🔧 Troubleshooting

### **Common Issues**

1. **OAuth users not persisting**
   - Check database connection
   - Verify RLS policies
   - Check service role permissions

2. **Rate limiting too strict**
   - Adjust `MAX_REQUESTS_PER_WINDOW`
   - Check IP detection logic
   - Review proxy configuration

3. **Session validation failures**
   - Verify token hashing
   - Check database indexes
   - Review cleanup procedures

### **Debug Mode**

Enable debug logging:

```bash
DEBUG=oauth:*,security:*,auth:* npm run dev
```

### **Security Testing**

Test security features:

```bash
# Test rate limiting
for i in {1..101}; do curl http://localhost:3001/auth/me; done

# Test IP blocking
curl -H "X-Forwarded-For: 192.168.1.100" \
     http://localhost:3001/auth/me

# Test OAuth flow
curl http://localhost:3001/auth/google
```

## 📚 Additional Resources

- [Supabase Security Documentation](https://supabase.com/docs/guides/security)
- [OAuth 2.0 Security Best Practices](https://tools.ietf.org/html/rfc6819)
- [OWASP Security Guidelines](https://owasp.org/www-project-top-ten/)
- [Express.js Security Best Practices](https://expressjs.com/en/advanced/best-practices-security.html)

## 🆘 Support

For security issues or questions:
1. Check the logs for error details
2. Review this documentation
3. Test with the provided endpoints
4. Contact the development team

---

**⚠️ Security Notice**: This system implements industry-standard security measures. However, security is an ongoing process. Regularly review and update security configurations based on your specific requirements and threat landscape.
