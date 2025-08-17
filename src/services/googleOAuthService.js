import fetch from 'node-fetch';

class GoogleOAuthService {
  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.SERVER_PUBLIC_URL}/auth/google/callback`;
    
    console.log('GoogleOAuthService initialized with:');
    console.log('- Client ID:', this.clientId ? '✓ Set' : '❌ Missing');
    console.log('- Client Secret:', this.clientSecret ? '✓ Set' : '❌ Missing');
    console.log('- Redirect URI:', this.redirectUri);
    
    if (!this.clientId || !this.clientSecret) {
      console.warn('Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment variables.');
    }
  }

  /**
   * Generate Google OAuth authorization URL
   * @param {string} state - Optional state parameter for security
   * @returns {string} Authorization URL
   */
  getAuthorizationUrl(state = null) {
    if (!this.clientId) {
      throw new Error('Google OAuth not configured - missing CLIENT_ID');
    }

    if (!this.clientSecret) {
      throw new Error('Google OAuth not configured - missing CLIENT_SECRET');
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt : 'select_account'
      // Removed 'prompt: consent' - users will only see consent screen once
      // prompt : 'select_account'  = Shows account selector only when multiple accounts
      // No prompt parameter = Only shows consent on first authorization

      // Currently we are using No prompt/ not added
    });

    if (state) {
      params.append('state', state);
    }

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    
    console.log('Generated OAuth URL:', authUrl);
    console.log('OAuth Parameters:', Object.fromEntries(params.entries()));
    
    return authUrl;
  }

  /**
   * Exchange authorization code for access token
   * @param {string} code - Authorization code from Google
   * @returns {Promise<Object>} Token response with access_token, refresh_token, etc.
   */
  async exchangeCodeForToken(code) {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Google OAuth not configured');
    }

    console.log('Exchanging code for token...');
    console.log('Code length:', code?.length || 0);
    console.log('Redirect URI:', this.redirectUri);

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        error: errorText
      });
      throw new Error(`Token exchange failed: ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    console.log('Token exchange successful:', {
      hasAccessToken: !!tokenData.access_token,
      hasRefreshToken: !!tokenData.refresh_token,
      expiresIn: tokenData.expires_in
    });

    return tokenData;
  }

  /**
   * Get user information from Google
   * @param {string} accessToken - Access token from Google
   * @returns {Promise<Object>} User profile information
   */
  async getUserInfo(accessToken) {
    console.log('Fetching user info from Google...');
    
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!userInfoResponse.ok) {
      const errorText = await userInfoResponse.text();
      console.error('Failed to fetch user info:', {
        status: userInfoResponse.status,
        statusText: userInfoResponse.statusText,
        error: errorText
      });
      throw new Error('Failed to fetch user info from Google');
    }

    const userInfo = await userInfoResponse.json();
    console.log('User info fetched successfully:', {
      id: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture
    });

    return userInfo;
  }

  /**
   * Complete OAuth flow and return user data
   * @param {string} code - Authorization code
   * @returns {Promise<Object>} User data and tokens
   */
  async completeOAuthFlow(code) {
    try {
      console.log('Starting OAuth flow completion...');
      
      // Exchange code for tokens
      const tokens = await this.exchangeCodeForToken(code);
      
      // Get user information
      const userInfo = await this.getUserInfo(tokens.access_token);
      
      const result = {
        user: {
          id: userInfo.id,
          email: userInfo.email,
          full_name: userInfo.name,
          avatar_url: userInfo.picture,
          provider: 'google',
          provider_id: userInfo.id
        },
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in
        }
      };

      console.log('OAuth flow completed successfully');
      return result;
    } catch (error) {
      console.error('Google OAuth flow error:', error);
      throw new Error(`OAuth flow failed: ${error.message}`);
    }
  }

  /**
   * Refresh access token using refresh token
   * @param {string} refreshToken - Refresh token from previous OAuth flow
   * @returns {Promise<Object>} New access token
   */
  async refreshAccessToken(refreshToken) {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Google OAuth not configured');
    }

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Token refresh failed: ${errorText}`);
    }

    return await tokenResponse.json();
  }
}

export default new GoogleOAuthService();

