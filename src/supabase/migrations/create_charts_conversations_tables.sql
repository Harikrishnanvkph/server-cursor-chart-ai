-- Database schema for charts and conversations
-- Run this script in your Supabase SQL editor

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- PROJECTS/WORKSPACES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    is_public BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- CONVERSATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.conversations (
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

-- =============================================
-- CHART SNAPSHOTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.chart_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    chart_type TEXT NOT NULL,
    chart_data JSONB NOT NULL,
    chart_config JSONB NOT NULL,
    version INTEGER DEFAULT 1,
    is_current BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- CHAT MESSAGES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.chat_messages (
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

-- =============================================
-- USER PREFERENCES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    chart_defaults JSONB DEFAULT '{}',
    ui_preferences JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id)
);

-- =============================================
-- INDEXES FOR PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON public.projects(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON public.conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON public.conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_activity ON public.conversations(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_chart_snapshots_conversation_id ON public.chart_snapshots(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chart_snapshots_is_current ON public.chart_snapshots(is_current) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON public.chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_order ON public.chat_messages(conversation_id, message_order);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chart_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- Projects policies
CREATE POLICY "Users can manage own projects" ON public.projects
    FOR ALL USING (auth.uid()::text = user_id::text);

-- Conversations policies
CREATE POLICY "Users can manage own conversations" ON public.conversations
    FOR ALL USING (auth.uid()::text = user_id::text);

-- Chart snapshots policies
CREATE POLICY "Users can manage own chart snapshots" ON public.chart_snapshots
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.conversations c 
            WHERE c.id = conversation_id 
            AND c.user_id::text = auth.uid()::text
        )
    );

-- Chat messages policies
CREATE POLICY "Users can manage own chat messages" ON public.chat_messages
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.conversations c 
            WHERE c.id = conversation_id 
            AND c.user_id::text = auth.uid()::text
        )
    );

-- User preferences policies
CREATE POLICY "Users can manage own preferences" ON public.user_preferences
    FOR ALL USING (auth.uid()::text = user_id::text);

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chart_snapshots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences TO authenticated;

-- =============================================
-- HELPFUL FUNCTIONS
-- =============================================

-- Function to get user's recent conversations
CREATE OR REPLACE FUNCTION get_user_conversations(
    user_uuid UUID,
    limit_count INTEGER DEFAULT 50
)
RETURNS TABLE(
    id UUID,
    title TEXT,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    last_activity TIMESTAMP WITH TIME ZONE,
    message_count BIGINT,
    current_chart_type TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.title,
        c.description,
        c.created_at,
        c.updated_at,
        c.last_activity,
        COUNT(cm.id) as message_count,
        cs.chart_type as current_chart_type
    FROM public.conversations c
    LEFT JOIN public.chat_messages cm ON c.id = cm.conversation_id
    LEFT JOIN public.chart_snapshots cs ON c.id = cs.conversation_id AND cs.is_current = true
    WHERE c.user_id = user_uuid
    GROUP BY c.id, c.title, c.description, c.created_at, c.updated_at, c.last_activity, cs.chart_type
    ORDER BY c.last_activity DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to create a new conversation with initial message
CREATE OR REPLACE FUNCTION create_conversation_with_message(
    user_uuid UUID,
    conversation_title TEXT,
    initial_message TEXT DEFAULT 'Hi! Describe the chart you want to create, or ask me to modify an existing chart.'
)
RETURNS UUID AS $$
DECLARE
    new_conversation_id UUID;
BEGIN
    -- Create conversation
    INSERT INTO public.conversations (user_id, title)
    VALUES (user_uuid, conversation_title)
    RETURNING id INTO new_conversation_id;
    
    -- Create initial assistant message
    INSERT INTO public.chat_messages (conversation_id, role, content, message_order)
    VALUES (new_conversation_id, 'assistant', initial_message, 1);
    
    RETURN new_conversation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to save chart snapshot
CREATE OR REPLACE FUNCTION save_chart_snapshot(
    conv_id UUID,
    chart_type_val TEXT,
    chart_data_val JSONB,
    chart_config_val JSONB,
    version_val INTEGER DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    new_snapshot_id UUID;
    next_version INTEGER;
BEGIN
    -- Get next version number
    SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
    FROM public.chart_snapshots 
    WHERE conversation_id = conv_id;
    
    -- Set all existing snapshots as not current
    UPDATE public.chart_snapshots 
    SET is_current = false 
    WHERE conversation_id = conv_id;
    
    -- Create new snapshot
    INSERT INTO public.chart_snapshots (
        conversation_id, 
        chart_type, 
        chart_data, 
        chart_config, 
        version,
        is_current
    )
    VALUES (
        conv_id, 
        chart_type_val, 
        chart_data_val, 
        chart_config_val, 
        COALESCE(version_val, next_version),
        true
    )
    RETURNING id INTO new_snapshot_id;
    
    -- Update conversation last activity
    UPDATE public.conversations 
    SET last_activity = NOW(), updated_at = NOW()
    WHERE id = conv_id;
    
    RETURN new_snapshot_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_user_conversations(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION create_conversation_with_message(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION save_chart_snapshot(UUID, TEXT, JSONB, JSONB, INTEGER) TO authenticated;

-- Final verification
DO $$
BEGIN
    RAISE NOTICE '✅ Charts and Conversations tables created successfully!';
    RAISE NOTICE '📊 Tables created: projects, conversations, chart_snapshots, chat_messages, user_preferences';
    RAISE NOTICE '🔒 RLS policies configured for user isolation';
    RAISE NOTICE '⚡ Essential functions and indexes created';
    RAISE NOTICE '🛡️ Ready for backend integration';
END $$;

