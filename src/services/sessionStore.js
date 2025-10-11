import crypto from 'crypto';
import { supabaseAdminClient } from '../supabase/client.js';

// Secure database-backed session store for OAuth users with minimal logging
class SecureSessionStore {
  constructor() {
    this.rateLimitMap = new Map();
    this.maxFailedAttempts = 5;
    this.lockoutDuration = 15 * 60 * 1000; // 15 minutes
  }

  /**
   * Hash access token for secure storage
   */
  hashToken(accessToken) {
    return crypto.createHash('sha256').update(accessToken).digest('hex');
  }

  /**
   * Check rate limiting for failed attempts
   */
  checkRateLimit(identifier) {
    const now = Date.now();
    const attempts = this.rateLimitMap.get(identifier) || { count: 0, firstAttempt: now };
    
    if (now - attempts.firstAttempt > this.lockoutDuration) {
      // Reset if lockout period has passed
      attempts.count = 0;
      attempts.firstAttempt = now;
    }
    
    if (attempts.count >= this.maxFailedAttempts) {
      return false; // Blocked
    }
    
    return true; // Allowed
  }

  /**
   * Record failed attempt
   */
  recordFailedAttempt(identifier) {
    const attempts = this.rateLimitMap.get(identifier) || { count: 0, firstAttempt: Date.now() };
    attempts.count++;
    this.rateLimitMap.set(identifier, attempts);
  }

  /**
   * Create or update OAuth session
   */
  async createSession(accessToken, userData, provider) {
    try {
      const tokenHash = this.hashToken(accessToken);
      const expiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000); // 15 days

      // First, create or get user via Supabase Auth (this triggers profile creation via trigger)
      let user = await this.getUserByEmail(userData.email);
      
      if (!user) {
        // Create user in Supabase Auth first (this will auto-create profile via trigger)
        const { data: authData, error: authError } = await supabaseAdminClient.auth.admin.createUser({
          email: userData.email,
          email_confirm: true, // Auto-confirm email for OAuth users
          user_metadata: {
            full_name: userData.name || userData.full_name,
            name: userData.name || userData.full_name,
            avatar_url: userData.picture,
            provider_id: userData.sub || userData.id
          },
          app_metadata: {
            provider: provider
          }
        });

        if (authError) {
          console.error('Error creating Supabase auth user:', authError);
          throw new Error('Failed to create user account');
        }

        // Wait a moment for trigger to create profile
        await new Promise(resolve => setTimeout(resolve, 100));

        // Get the newly created profile
        user = await this.getUserByEmail(userData.email);
        
        if (!user) {
          console.error('Profile not created by trigger for user:', authData.user.id);
          throw new Error('Failed to create user profile');
        }
      } else {
        // Update existing user profile with latest data from OAuth provider
        const { data: updatedUser, error: updateError } = await supabaseAdminClient
          .from('profiles')
          .update({
            full_name: userData.name || userData.full_name,
            avatar_url: userData.picture,
            provider: provider,
            provider_id: userData.sub || userData.id,
            updated_at: new Date().toISOString()
          })
          .eq('id', user.id)
          .select()
          .single();

        if (updateError) {
          console.error('Error updating user profile:', updateError);
          // Don't throw error, continue with existing user data
        } else {
          user = updatedUser;
        }
      }

      // Create OAuth session
      const { data: session, error: sessionError } = await supabaseAdminClient
        .from('oauth_sessions')
        .upsert({
          access_token_hash: tokenHash,
          user_id: user.id,
          provider: provider,
          expires_at: expiresAt.toISOString()
        }, {
          onConflict: 'access_token_hash'
        })
        .select()
        .single();

      if (sessionError) {
        console.error('Error creating OAuth session:', sessionError);
        throw new Error('Failed to create OAuth session');
      }

      // Only log critical security events (new user creation)
      if (!user.created_at || new Date(user.created_at).getTime() > Date.now() - 60000) {
        await this.logSecurityEvent('new_oauth_user_created', null, null, {
          user_id: user.id,
          provider: provider,
          email: userData.email
        });
      }

      return {
        id: session.id,
        user_id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        provider: provider,
        expires_at: session.expires_at
      };

    } catch (error) {
      console.error('Error in createSession:', error);
      throw error;
    }
  }

  /**
   * Validate OAuth session
   */
  async validateSession(accessToken) {
    try {
      const tokenHash = this.hashToken(accessToken);
      
      const { data: session, error } = await supabaseAdminClient
        .from('oauth_sessions')
        .select(`
          *,
          profiles:user_id (
            id,
            email,
            full_name,
            avatar_url,
            provider
          )
        `)
        .eq('access_token_hash', tokenHash)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (error || !session) {
        return null;
      }

      // Update last used timestamp
      await supabaseAdminClient
        .from('oauth_sessions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', session.id);

      return {
        id: session.id,
        user_id: session.profiles.id,
        email: session.profiles.email,
        full_name: session.profiles.full_name,
        avatar_url: session.profiles.avatar_url,
        provider: session.profiles.provider,
        expires_at: session.expires_at
      };

    } catch (error) {
      console.error('Error in validateSession:', error);
      return null;
    }
  }

  /**
   * Get user by email
   */
  async getUserByEmail(email) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('profiles')
        .select('*')
        .eq('email', email)
        .single();

      if (error) return null;
      return data;
    } catch (error) {
      console.error('Error getting user by email:', error);
      return null;
    }
  }

  /**
   * Delete OAuth session
   */
  async deleteSession(accessToken) {
    try {
      const tokenHash = this.hashToken(accessToken);
      
      const { error } = await supabaseAdminClient
        .from('oauth_sessions')
        .delete()
        .eq('access_token_hash', tokenHash);

      if (error) {
        console.error('Error deleting session:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error in deleteSession:', error);
      return false;
    }
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions() {
    try {
      const { error } = await supabaseAdminClient
        .rpc('cleanup_expired_oauth_sessions');

      if (error) {
        console.error('Error cleaning up expired sessions:', error);
      }
    } catch (error) {
      console.error('Error in cleanupExpiredSessions:', error);
    }
  }

  /**
   * Log only critical security events to minimize storage usage
   */
  async logSecurityEvent(action, ipAddress, userAgent, details) {
    try {
      // Only log critical security events, skip routine operations
      const criticalEvents = [
        'failed_login',
        'suspicious_activity', 
        'rate_limit_exceeded',
        'new_oauth_user_created',
        'oauth_callback_failed'
      ];

      if (criticalEvents.includes(action)) {
        await supabaseAdminClient
          .rpc('log_security_event', {
            action: action,
            ip_address: ipAddress,
            user_agent: userAgent,
            details: details
          });
      }
    } catch (error) {
      console.error('Error logging security event:', error);
    }
  }

  /**
   * Get active sessions count
   */
  async getActiveSessionsCount() {
    try {
      const { data, error } = await supabaseAdminClient
        .from('active_sessions')
        .select('id', { count: 'exact' });

      if (error) return 0;
      return data?.length || 0;
    } catch (error) {
      console.error('Error getting active sessions count:', error);
      return 0;
    }
  }
}

export default new SecureSessionStore();
