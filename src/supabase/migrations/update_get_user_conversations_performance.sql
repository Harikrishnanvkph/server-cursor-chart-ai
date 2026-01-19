-- ============================================
-- PERFORMANCE OPTIMIZATION MIGRATION
-- Update get_user_conversations function
-- ============================================
-- This migration optimizes the get_user_conversations function
-- to return is_template_mode and chart_mode in a single query,
-- eliminating the need for a second database query.
--
-- Date: 2024-12-19
-- ============================================

-- Drop existing function first (required when changing return type)
DROP FUNCTION IF EXISTS get_user_conversations(UUID, INTEGER);

-- Create get_user_conversations function with new return type including metadata
CREATE FUNCTION get_user_conversations(
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
    current_chart_type TEXT,
    is_template_mode BOOLEAN,
    chart_mode TEXT
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
        cs.chart_type as current_chart_type,
        COALESCE(cs.is_template_mode, false) as is_template_mode,
        COALESCE(
            cs.chart_data->'datasets'->0->>'mode',
            'single'
        ) as chart_mode
    FROM public.conversations c
    LEFT JOIN public.chat_messages cm ON c.id = cm.conversation_id
    LEFT JOIN public.chart_snapshots cs ON c.id = cs.conversation_id AND cs.is_current = true
    WHERE c.user_id = user_uuid
      AND c.is_active = true
    GROUP BY c.id, c.title, c.description, c.created_at, c.updated_at, c.last_activity, 
             cs.chart_type, cs.is_template_mode, cs.chart_data
    ORDER BY c.last_activity DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ensure execute permission is granted
GRANT EXECUTE ON FUNCTION get_user_conversations(UUID, INTEGER) TO authenticated;

-- Verify the function was updated
DO $$
BEGIN
    RAISE NOTICE '✅ get_user_conversations function updated successfully!';
    RAISE NOTICE '📊 Function now returns is_template_mode and chart_mode in single query';
    RAISE NOTICE '⚡ Performance optimization complete';
END $$;
