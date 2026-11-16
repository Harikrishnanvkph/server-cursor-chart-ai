import fetch from 'node-fetch'

class GitHubOAuthService {
  constructor() {
    this.clientId = process.env.GITHUB_CLIENT_ID
    this.clientSecret = process.env.GITHUB_CLIENT_SECRET
    this.redirectUri =
      process.env.GITHUB_REDIRECT_URI ||
      `${process.env.SERVER_PUBLIC_URL || 'http://localhost:5000'}/auth/github/callback`

    if (!this.clientId || !this.clientSecret) {
      console.warn('GitHub OAuth credentials not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in environment variables.')
    }
  }

  /**
   * Generate GitHub OAuth authorization URL
   * @param {string} state - CSRF state parameter
   * @returns {string} Authorization URL
   */
  getAuthorizationUrl(state = null) {
    if (!this.clientId) {
      throw new Error('GitHub OAuth not configured - missing GITHUB_CLIENT_ID')
    }
    if (!this.clientSecret) {
      throw new Error('GitHub OAuth not configured - missing GITHUB_CLIENT_SECRET')
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'read:user user:email',
    })

    if (state) {
      params.append('state', state)
    }

    return `https://github.com/login/oauth/authorize?${params.toString()}`
  }

  /**
   * Exchange authorization code for GitHub access token
   * @param {string} code
   * @returns {Promise<{ access_token: string }>}
   */
  async exchangeCodeForToken(code) {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('GitHub OAuth not configured')
    }

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUri,
      }),
    })

    const data = await response.json()
    if (!response.ok || data.error || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Failed to exchange GitHub authorization code')
    }

    return data
  }

  /**
   * Fetch verified GitHub user profile and primary email
   * @param {string} accessToken
   */
  async getUserInfo(accessToken) {
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'AIChartor-App',
    }

    const [userRes, emailsRes] = await Promise.all([
      fetch('https://api.github.com/user', { headers }),
      fetch('https://api.github.com/user/emails', { headers }),
    ])

    if (!userRes.ok) {
      throw new Error('Failed to fetch GitHub user profile')
    }

    const user = await userRes.json()
    let primaryEmail = user.email

    if (emailsRes.ok) {
      const emails = await emailsRes.json()
      if (Array.isArray(emails)) {
        const primaryVerified = emails.find((e) => e.primary && e.verified)
        const anyVerified = emails.find((e) => e.verified)
        primaryEmail = primaryVerified?.email || anyVerified?.email || primaryEmail
      }
    }

    if (!primaryEmail) {
      throw new Error('GitHub account does not have a verified email address')
    }

    const displayName = user.name || user.login || primaryEmail.split('@')[0]

    return {
      sub: String(user.id),
      id: String(user.id),
      email: primaryEmail,
      name: displayName,
      full_name: displayName,
      picture: user.avatar_url || null,
    }
  }
}

export default new GitHubOAuthService()
