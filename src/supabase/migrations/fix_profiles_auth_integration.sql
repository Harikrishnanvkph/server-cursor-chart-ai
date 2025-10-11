-- Fix profiles table integration with Supabase Auth
-- This migration creates the proper linkage between auth.users and profiles

-- =============================================
-- STEP 1: Update profiles table to use auth.users ID
-- =============================================

-- =============================================
-- STEP 0: Backup and clean existing data
-- =============================================

-- Temporarily store oauth_sessions data
CREATE TEMP TABLE temp_oauth_sessions AS 
SELECT * FROM public.oauth_sessions;

-- Temporarily store conversations data
CREATE TEMP TABLE temp_conversations AS 
SELECT * FROM public.conversations;

-- Temporarily store projects data (if exists)
CREATE TEMP TABLE temp_projects AS 
SELECT * FROM public.projects WHERE EXISTS (SELECT 1 FROM public.projects LIMIT 1);

-- Temporarily store user_preferences data (if exists)
CREATE TEMP TABLE temp_user_preferences AS 
SELECT * FROM public.user_preferences WHERE EXISTS (SELECT 1 FROM public.user_preferences LIMIT 1);

-- Drop existing foreign key constraints that reference profiles
ALTER TABLE IF EXISTS public.conversations DROP CONSTRAINT IF EXISTS conversations_user_id_fkey;
ALTER TABLE IF EXISTS public.projects DROP CONSTRAINT IF EXISTS projects_user_id_fkey;
ALTER TABLE IF EXISTS public.user_preferences DROP CONSTRAINT IF EXISTS user_preferences_user_id_fkey;
ALTER TABLE IF EXISTS public.oauth_sessions DROP CONSTRAINT IF EXISTS oauth_sessions_user_id_fkey;

-- Clear tables to allow profile table recreation
TRUNCATE TABLE public.oauth_sessions CASCADE;
TRUNCATE TABLE public.conversations CASCADE;
TRUNCATE TABLE public.projects CASCADE;
TRUNCATE TABLE public.user_preferences CASCADE;

-- Drop existing RLS policies
DROP POLICY IF EXISTS "Users can manage own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can manage own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can manage own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Service role can manage all profiles" ON public.profiles;

-- Recreate profiles table to use auth.users ID as primary key
DROP TABLE IF EXISTS public.profiles CASCADE;

CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    provider TEXT DEFAULT 'email',
    provider_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- STEP 2: Create automatic profile creation trigger
-- =============================================

-- Function to automatically create profile when user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, avatar_url, provider, provider_id)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
        NEW.raw_user_meta_data->>'avatar_url',
        COALESCE(NEW.raw_app_meta_data->>'provider', 'email'),
        NEW.raw_user_meta_data->>'provider_id'
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
        avatar_url = COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url),
        updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to automatically create profile on user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT OR UPDATE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- =============================================
-- STEP 3: Recreate foreign key constraints
-- =============================================

-- Recreate projects table foreign key
ALTER TABLE public.projects 
    ADD CONSTRAINT projects_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- Recreate conversations table foreign key
ALTER TABLE public.conversations 
    ADD CONSTRAINT conversations_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- Recreate user_preferences table foreign key
ALTER TABLE public.user_preferences 
    ADD CONSTRAINT user_preferences_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- Recreate oauth_sessions table foreign key (if it exists)
ALTER TABLE IF EXISTS public.oauth_sessions 
    ADD CONSTRAINT oauth_sessions_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- =============================================
-- STEP 4: Recreate indexes
-- =============================================

CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_provider ON public.profiles(provider, provider_id);

-- =============================================
-- STEP 5: Enable RLS and create policies
-- =============================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Service role can manage all profiles
CREATE POLICY "Service role can manage all profiles" ON public.profiles
    FOR ALL USING (auth.role() = 'service_role');

-- Users can view their own profile
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = id);

-- Users can insert their own profile (though trigger handles this)
CREATE POLICY "Users can insert own profile" ON public.profiles
    FOR INSERT WITH CHECK (auth.uid() = id);

-- Recreate other table policies
CREATE POLICY "Users can manage own projects" ON public.projects
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own conversations" ON public.conversations
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own preferences" ON public.user_preferences
    FOR ALL USING (auth.uid() = user_id);

-- =============================================
-- STEP 6: Grant permissions
-- =============================================

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

-- =============================================
-- STEP 7: Backfill existing auth.users into profiles
-- =============================================

-- Create profiles for any existing users who don't have one
INSERT INTO public.profiles (id, email, full_name, avatar_url, provider, provider_id)
SELECT 
    u.id,
    u.email,
    COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
    u.raw_user_meta_data->>'avatar_url',
    COALESCE(u.raw_app_meta_data->>'provider', 'email'),
    u.raw_user_meta_data->>'provider_id'
FROM auth.users u
WHERE NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = u.id
)
ON CONFLICT (id) DO NOTHING;

-- =============================================
-- STEP 8: Restore data that references valid profiles
-- =============================================

-- Restore OAuth sessions only for users that exist in auth.users
INSERT INTO public.oauth_sessions (id, access_token_hash, user_id, provider, provider_id, expires_at, created_at, last_used_at)
SELECT 
    t.id, 
    t.access_token_hash, 
    t.user_id, 
    t.provider, 
    t.provider_id, 
    t.expires_at, 
    t.created_at, 
    t.last_used_at
FROM temp_oauth_sessions t
WHERE EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = t.user_id
)
ON CONFLICT DO NOTHING;

-- Restore conversations only for users that exist in auth.users
INSERT INTO public.conversations (id, user_id, project_id, title, description, is_active, created_at, updated_at, last_activity)
SELECT 
    t.id, 
    t.user_id, 
    t.project_id, 
    t.title, 
    t.description, 
    t.is_active, 
    t.created_at, 
    t.updated_at, 
    t.last_activity
FROM temp_conversations t
WHERE EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = t.user_id
)
ON CONFLICT DO NOTHING;

-- Restore projects only for users that exist in auth.users
INSERT INTO public.projects (id, user_id, name, description, is_public, created_at, updated_at)
SELECT 
    t.id, 
    t.user_id, 
    t.name, 
    t.description, 
    t.is_public, 
    t.created_at, 
    t.updated_at
FROM temp_projects t
WHERE EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = t.user_id
)
ON CONFLICT DO NOTHING;

-- Restore user preferences only for users that exist in auth.users
INSERT INTO public.user_preferences (id, user_id, chart_defaults, ui_preferences, created_at, updated_at)
SELECT 
    t.id, 
    t.user_id, 
    t.chart_defaults, 
    t.ui_preferences, 
    t.created_at, 
    t.updated_at
FROM temp_user_preferences t
WHERE EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = t.user_id
)
ON CONFLICT DO NOTHING;

-- =============================================
-- VERIFICATION
-- =============================================

DO $$
DECLARE
    auth_user_count INTEGER;
    profile_count INTEGER;
    oauth_count INTEGER;
    conversation_count INTEGER;
    project_count INTEGER;
    preference_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO auth_user_count FROM auth.users;
    SELECT COUNT(*) INTO profile_count FROM public.profiles;
    SELECT COUNT(*) INTO oauth_count FROM public.oauth_sessions;
    SELECT COUNT(*) INTO conversation_count FROM public.conversations;
    SELECT COUNT(*) INTO project_count FROM public.projects;
    SELECT COUNT(*) INTO preference_count FROM public.user_preferences;
    
    RAISE NOTICE '✅ Profile-Auth integration completed!';
    RAISE NOTICE '👥 Auth users: %, Profiles: %', auth_user_count, profile_count;
    RAISE NOTICE '🔗 Profiles table now linked to auth.users';
    RAISE NOTICE '⚡ Automatic profile creation trigger enabled';
    RAISE NOTICE '🔒 RLS policies recreated';
    RAISE NOTICE '📊 Data restored:';
    RAISE NOTICE '   - OAuth sessions: %', oauth_count;
    RAISE NOTICE '   - Conversations: %', conversation_count;
    RAISE NOTICE '   - Projects: %', project_count;
    RAISE NOTICE '   - Preferences: %', preference_count;
    
    IF auth_user_count != profile_count THEN
        RAISE WARNING '⚠️  Mismatch between auth users and profiles!';
    ELSE
        RAISE NOTICE '✓ All auth users have corresponding profiles';
    END IF;
END $$;

