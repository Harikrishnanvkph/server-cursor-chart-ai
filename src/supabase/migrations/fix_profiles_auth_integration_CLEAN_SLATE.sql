-- CLEAN SLATE VERSION - This will DELETE all existing data and start fresh
-- ⚠️  WARNING: This will PERMANENTLY DELETE all conversations, projects, and chart data!
-- Only use this if you're okay with losing existing data for a fresh start.

-- Database schema for fixing profiles integration with Supabase Auth

-- =============================================
-- STEP 1: Drop all dependent tables
-- =============================================

DROP TABLE IF EXISTS public.chat_messages CASCADE;
DROP TABLE IF EXISTS public.chart_snapshots CASCADE;
DROP TABLE IF EXISTS public.conversations CASCADE;
DROP TABLE IF EXISTS public.projects CASCADE;
DROP TABLE IF EXISTS public.user_preferences CASCADE;
DROP TABLE IF EXISTS public.oauth_sessions CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- =============================================
-- STEP 2: Create profiles table linked to auth.users
-- =============================================

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
-- STEP 3: Create automatic profile creation trigger
-- =============================================

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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT OR UPDATE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- =============================================
-- STEP 4: Backfill existing auth.users into profiles
-- =============================================

INSERT INTO public.profiles (id, email, full_name, avatar_url, provider, provider_id)
SELECT 
    u.id,
    u.email,
    COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
    u.raw_user_meta_data->>'avatar_url',
    COALESCE(u.raw_app_meta_data->>'provider', 'email'),
    u.raw_user_meta_data->>'provider_id'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- =============================================
-- STEP 5: Recreate all dependent tables
-- =============================================

-- Projects table
CREATE TABLE public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    is_public BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Conversations table
CREATE TABLE public.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chart snapshots table
CREATE TABLE public.chart_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    chart_type TEXT NOT NULL,
    chart_data JSONB NOT NULL,
    chart_config JSONB NOT NULL,
    version INTEGER DEFAULT 1,
    is_current BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chat messages table
CREATE TABLE public.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    chart_snapshot_id UUID REFERENCES public.chart_snapshots(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    action TEXT CHECK (action IN ('create', 'modify', 'update', 'reset')),
    changes JSONB,
    message_order INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User preferences table
CREATE TABLE public.user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    chart_defaults JSONB DEFAULT '{}',
    ui_preferences JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id)
);

-- OAuth sessions table (if using custom OAuth)
CREATE TABLE IF NOT EXISTS public.oauth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    access_token_hash TEXT UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_id TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- STEP 6: Create indexes
-- =============================================

CREATE INDEX idx_profiles_email ON public.profiles(email);
CREATE INDEX idx_profiles_provider ON public.profiles(provider, provider_id);
CREATE INDEX idx_projects_user_id ON public.projects(user_id);
CREATE INDEX idx_conversations_user_id ON public.conversations(user_id);
CREATE INDEX idx_conversations_project_id ON public.conversations(project_id);
CREATE INDEX idx_conversations_last_activity ON public.conversations(last_activity DESC);
CREATE INDEX idx_chart_snapshots_conversation_id ON public.chart_snapshots(conversation_id);
CREATE INDEX idx_chart_snapshots_is_current ON public.chart_snapshots(is_current) WHERE is_current = true;
CREATE INDEX idx_chat_messages_conversation_id ON public.chat_messages(conversation_id);
CREATE INDEX idx_chat_messages_order ON public.chat_messages(conversation_id, message_order);
CREATE INDEX idx_oauth_sessions_token_hash ON public.oauth_sessions(access_token_hash);
CREATE INDEX idx_oauth_sessions_user_id ON public.oauth_sessions(user_id);
CREATE INDEX idx_oauth_sessions_expires ON public.oauth_sessions(expires_at);

-- =============================================
-- STEP 7: Enable RLS and create policies
-- =============================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chart_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_sessions ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Service role can manage all profiles" ON public.profiles
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON public.profiles
    FOR INSERT WITH CHECK (auth.uid() = id);

-- Projects policies
CREATE POLICY "Users can manage own projects" ON public.projects
    FOR ALL USING (auth.uid() = user_id);

-- Conversations policies
CREATE POLICY "Users can manage own conversations" ON public.conversations
    FOR ALL USING (auth.uid() = user_id);

-- Chart snapshots policies
CREATE POLICY "Users can manage own chart snapshots" ON public.chart_snapshots
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.conversations c 
            WHERE c.id = conversation_id 
            AND c.user_id = auth.uid()
        )
    );

-- Chat messages policies
CREATE POLICY "Users can manage own chat messages" ON public.chat_messages
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.conversations c 
            WHERE c.id = conversation_id 
            AND c.user_id = auth.uid()
        )
    );

-- User preferences policies
CREATE POLICY "Users can manage own preferences" ON public.user_preferences
    FOR ALL USING (auth.uid() = user_id);

-- OAuth sessions policies
CREATE POLICY "Service role can manage all OAuth sessions" ON public.oauth_sessions
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- STEP 8: Grant permissions
-- =============================================

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chart_snapshots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences TO authenticated;
GRANT ALL ON public.oauth_sessions TO service_role;

-- =============================================
-- VERIFICATION
-- =============================================

DO $$
DECLARE
    auth_user_count INTEGER;
    profile_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO auth_user_count FROM auth.users;
    SELECT COUNT(*) INTO profile_count FROM public.profiles;
    
    RAISE NOTICE '✅ CLEAN SLATE migration completed!';
    RAISE NOTICE '👥 Auth users: %, Profiles: %', auth_user_count, profile_count;
    RAISE NOTICE '🔗 Profiles table now linked to auth.users';
    RAISE NOTICE '⚡ Automatic profile creation trigger enabled';
    RAISE NOTICE '🔒 RLS policies configured';
    RAISE NOTICE '📊 All tables recreated with proper foreign keys';
    RAISE NOTICE '🆕 Ready for fresh data!';
    
    IF auth_user_count != profile_count THEN
        RAISE WARNING '⚠️  Mismatch between auth users and profiles!';
    ELSE
        RAISE NOTICE '✓ All auth users have corresponding profiles';
    END IF;
END $$;

