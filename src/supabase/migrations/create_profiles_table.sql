-- Create profiles table for storing user information
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    provider TEXT DEFAULT 'email',
    provider_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);

-- Create index on provider and provider_id for OAuth lookups
CREATE INDEX IF NOT EXISTS idx_profiles_provider ON public.profiles(provider, provider_id);

-- Create OAuth sessions table for secure token storage
CREATE TABLE IF NOT EXISTS public.oauth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    access_token_hash TEXT UNIQUE NOT NULL, -- Store hash, not plain token
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_id TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for OAuth sessions
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_token_hash ON public.oauth_sessions(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_user_id ON public.oauth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON public.oauth_sessions(expires_at);

-- Enable Row Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_sessions ENABLE ROW LEVEL SECURITY;

-- Profiles table policies
-- Service role can manage all profiles (for OAuth operations)
CREATE POLICY "Service role can manage all profiles" ON public.profiles
    FOR ALL USING (auth.role() = 'service_role');

-- Users can view their own profile (for Supabase auth users)
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT USING (auth.uid()::text = id::text);

-- Users can update their own profile (for Supabase auth users)
CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid()::text = id::text);

-- Users can insert their own profile (for Supabase auth users)
CREATE POLICY "Users can insert own profile" ON public.profiles
    FOR INSERT WITH CHECK (auth.uid()::text = id::text);

-- OAuth sessions table policies
-- Service role can manage all OAuth sessions
CREATE POLICY "Service role can manage all OAuth sessions" ON public.oauth_sessions
    FOR ALL USING (auth.role() = 'service_role');

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT ALL ON public.oauth_sessions TO service_role;

-- Create function to clean up expired OAuth sessions
CREATE OR REPLACE FUNCTION cleanup_expired_oauth_sessions()
RETURNS void AS $$
BEGIN
    DELETE FROM public.oauth_sessions 
    WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create a scheduled job to clean up expired sessions (runs every hour)
-- Note: This requires pg_cron extension. If not available, use application-level cleanup.
-- SELECT cron.schedule('cleanup-oauth-sessions', '0 * * * *', 'SELECT cleanup_expired_oauth_sessions();');

