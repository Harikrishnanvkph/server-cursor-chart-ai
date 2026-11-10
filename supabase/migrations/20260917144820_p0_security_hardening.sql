-- P0-1: Revoke EXECUTE from anon and public for ALL sensitive SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.deduct_ai_credit(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.save_chart_snapshot(uuid, text, jsonb, jsonb, integer, jsonb, jsonb, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.update_user_profile(uuid, text, text, text, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_user_profile_by_email(text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.create_conversation_with_message(uuid, text, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_user_conversations(uuid, integer) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_user_templates(uuid, boolean) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.upsert_user_template(uuid, text, text, jsonb, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.add_chat_message(uuid, text, text, uuid, text, jsonb) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.log_security_event(text, text, text, jsonb) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_session_stats() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_oauth_sessions() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_security_logs() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, public;

-- P0-2: Add RLS policies to chart_snapshots (currently has RLS enabled but ZERO policies)
CREATE POLICY "Users can read own chart snapshots" ON public.chart_snapshots
  FOR SELECT USING (
    conversation_id IN (
      SELECT id FROM public.conversations WHERE user_id = (select auth.uid())
    )
  );

CREATE POLICY "Users can manage own chart snapshots" ON public.chart_snapshots
  FOR ALL USING (
    conversation_id IN (
      SELECT id FROM public.conversations WHERE user_id = (select auth.uid())
    )
  );

CREATE POLICY "Anyone can view shared snapshots" ON public.chart_snapshots
  FOR SELECT USING (share_id IS NOT NULL);

-- P0-3: Fix search_path on all 15 functions to prevent search_path manipulation attacks
ALTER FUNCTION public.deduct_ai_credit(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.save_chart_snapshot(uuid, text, jsonb, jsonb, integer, jsonb, jsonb, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_user_profile(uuid, text, text, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_profile_by_email(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_conversation_with_message(uuid, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_conversations(uuid, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_templates(uuid, boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public.upsert_user_template(uuid, text, text, jsonb, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.add_chat_message(uuid, text, text, uuid, text, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_security_event(text, text, text, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_session_stats() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_expired_oauth_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_security_logs() SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp;;
