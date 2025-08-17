# Google OAuth Setup Guide

This guide will walk you through setting up Google OAuth for the Chart Generator application.

## Prerequisites

- Google Cloud Console account
- Supabase project
- Node.js and npm/pnpm installed

## Step 1: Google Cloud Console Setup

### 1.1 Create a New Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Enter a project name (e.g., "Chart Generator OAuth")
4. Click "Create"

### 1.2 Enable Required APIs
1. In your project, go to "APIs & Services" → "Library"
2. Search for and enable these APIs:
   - **Google+ API**
   - **Google OAuth2 API**

### 1.3 Create OAuth 2.0 Credentials
1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth 2.0 Client IDs"
3. Configure the OAuth consent screen if prompted
4. Set **Application Type** to **Web application**
5. Add **Authorized redirect URIs**:
   - `http://localhost:3001/auth/google/callback` (for development)
   - `https://your-domain.com/auth/google/callback` (for production)
6. Click "Create"
7. **Save the Client ID and Client Secret** - you'll need these for the environment variables

## Step 2: Environment Configuration

### 2.1 Copy Environment Template
```bash
cp env.template .env
```

### 2.2 Update Environment Variables
Edit your `.env` file and add your Google OAuth credentials:

```bash
# Google OAuth Configuration
GOOGLE_CLIENT_ID=your_actual_client_id_here
GOOGLE_CLIENT_SECRET=your_actual_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3001/auth/google/callback

# Server URLs
SERVER_PUBLIC_URL=http://localhost:3001
APP_ORIGIN=http://localhost:3000
```

## Step 3: Database Setup

### 3.1 Run the Migration
Execute the SQL migration in your Supabase SQL editor:

```sql
-- Copy and paste the contents of src/supabase/migrations/create_profiles_table.sql
-- This will create the profiles table needed for storing user information
```

### 3.2 Verify Table Creation
In Supabase Dashboard:
1. Go to "Table Editor"
2. Verify that the `profiles` table exists with the correct columns

## Step 4: Install Dependencies

```bash
cd server
npm install
# or
pnpm install
```

## Step 5: Test the Setup

### 5.1 Start the Server
```bash
npm run dev
# or
pnpm dev
```

### 5.2 Test OAuth Flow
1. Open your frontend application
2. Click "Continue with Google"
3. You should be redirected to Google's OAuth consent screen
4. After authorization, you should be redirected back to your app

## Troubleshooting

### Common Issues

#### 1. "Failed to start Google OAuth"
- Check that `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in `.env`
- Verify the redirect URI matches exactly what's configured in Google Cloud Console

#### 2. "Invalid OAuth state parameter"
- This is a security feature - the error should resolve on retry
- Check that cookies are enabled in your browser

#### 3. "OAuth callback error"
- Check server logs for detailed error messages
- Verify the redirect URI in Google Cloud Console matches your server URL

#### 4. Database Connection Issues
- Ensure Supabase credentials are correct in `.env`
- Check that the `profiles` table exists and has the correct structure

### Debug Mode

To enable debug logging, add this to your `.env`:

```bash
DEBUG=oauth:*
NODE_ENV=development
```

## Security Considerations

### 1. Environment Variables
- Never commit `.env` files to version control
- Use strong, unique secrets for production
- Rotate credentials regularly

### 2. OAuth Security
- The `state` parameter prevents CSRF attacks
- Redirect URIs are validated by Google
- Access tokens are stored securely in HTTP-only cookies

### 3. Production Deployment
- Use HTTPS in production
- Set `NODE_ENV=production`
- Use strong session secrets
- Consider using Redis for session storage instead of cookies

## Next Steps

After successful setup:

1. **Customize User Experience**: Modify the OAuth callback to redirect users to appropriate pages
2. **Add Profile Management**: Allow users to edit their profile information
3. **Implement Token Refresh**: Handle expired access tokens automatically
4. **Add Other Providers**: Extend the system to support GitHub, Microsoft, etc.

## Support

If you encounter issues:

1. Check the server logs for error messages
2. Verify all environment variables are set correctly
3. Ensure Google Cloud Console configuration matches your setup
4. Check that the database migration ran successfully

