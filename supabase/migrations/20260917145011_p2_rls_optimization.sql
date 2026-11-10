-- ================================================================
-- P2-4: Wrap auth.uid()/auth.role() in (select ...) for initplan optimization
-- P2-5: Consolidate overlapping permissive policies
-- ================================================================

-- CHART_STYLE_PRESETS: Fix initplan (4 policies)
DROP POLICY IF EXISTS "delete_own_presets" ON public.chart_style_presets;
DROP POLICY IF EXISTS "insert_own_presets" ON public.chart_style_presets;
DROP POLICY IF EXISTS "read_official_public_or_own" ON public.chart_style_presets;
DROP POLICY IF EXISTS "update_own_presets" ON public.chart_style_presets;

CREATE POLICY "read_official_public_or_own" ON public.chart_style_presets
  FOR SELECT USING ((is_official = true) OR (is_public = true) OR (user_id = (select auth.uid())));
CREATE POLICY "insert_own_presets" ON public.chart_style_presets
  FOR INSERT WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "update_own_presets" ON public.chart_style_presets
  FOR UPDATE USING (user_id = (select auth.uid()));
CREATE POLICY "delete_own_presets" ON public.chart_style_presets
  FOR DELETE USING (user_id = (select auth.uid()));

-- CHAT_MESSAGES: Fix initplan (1 policy)
DROP POLICY IF EXISTS "Users can manage own chat messages" ON public.chat_messages;
CREATE POLICY "Users can manage own chat messages" ON public.chat_messages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM conversations c WHERE c.id = chat_messages.conversation_id AND c.user_id = (select auth.uid()))
  );

-- CONVERSATIONS: Fix initplan (1 policy)
DROP POLICY IF EXISTS "Users can manage own conversations" ON public.conversations;
CREATE POLICY "Users can manage own conversations" ON public.conversations
  FOR ALL USING ((select auth.uid()) = user_id);

-- FORMAT_BLUEPRINTS: Fix initplan + consolidate overlapping SELECT policies (P2-5)
DROP POLICY IF EXISTS "Anyone can read official formats" ON public.format_blueprints;
DROP POLICY IF EXISTS "Users can read own formats" ON public.format_blueprints;
DROP POLICY IF EXISTS "Users can create own formats" ON public.format_blueprints;
DROP POLICY IF EXISTS "Users can update own formats" ON public.format_blueprints;
DROP POLICY IF EXISTS "Users can delete own formats" ON public.format_blueprints;

-- Consolidated: single SELECT policy replaces two overlapping ones
CREATE POLICY "Read own or official formats" ON public.format_blueprints
  FOR SELECT USING (is_official = true OR is_public = true OR user_id = (select auth.uid()));
CREATE POLICY "Users can create own formats" ON public.format_blueprints
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can update own formats" ON public.format_blueprints
  FOR UPDATE USING ((select auth.uid()) = user_id);
CREATE POLICY "Users can delete own formats" ON public.format_blueprints
  FOR DELETE USING ((select auth.uid()) = user_id);

-- PROFILES: Fix initplan + consolidate (P2-5 — Service role overlap)
DROP POLICY IF EXISTS "Service role can manage all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;

-- Consolidated: Service role uses (select auth.role()), user policies use (select auth.uid())
CREATE POLICY "Service role can manage all profiles" ON public.profiles
  FOR ALL USING ((select auth.role()) = 'service_role'::text);
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING ((select auth.uid()) = id);
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK ((select auth.uid()) = id);
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING ((select auth.uid()) = id);

-- PROJECTS: Fix initplan
DROP POLICY IF EXISTS "Users can manage own projects" ON public.projects;
CREATE POLICY "Users can manage own projects" ON public.projects
  FOR ALL USING ((select auth.uid()) = user_id);

-- SECURITY_LOGS: Fix initplan
DROP POLICY IF EXISTS "Service role can access security logs" ON public.security_logs;
CREATE POLICY "Service role can access security logs" ON public.security_logs
  FOR ALL USING ((select auth.role()) = 'service_role'::text);

-- OAUTH_SESSIONS: Fix initplan
DROP POLICY IF EXISTS "Service role can manage all OAuth sessions" ON public.oauth_sessions;
CREATE POLICY "Service role can manage all OAuth sessions" ON public.oauth_sessions
  FOR ALL USING ((select auth.role()) = 'service_role'::text);

-- USER_PREFERENCES: Fix initplan
DROP POLICY IF EXISTS "Users can manage own preferences" ON public.user_preferences;
CREATE POLICY "Users can manage own preferences" ON public.user_preferences
  FOR ALL USING ((select auth.uid()) = user_id);

-- USER_TEMPLATES: Fix initplan + consolidate overlapping SELECT policies (P2-5)
DROP POLICY IF EXISTS "Users can view own templates" ON public.user_templates;
DROP POLICY IF EXISTS "Users can view public templates" ON public.user_templates;
DROP POLICY IF EXISTS "Users can insert own templates" ON public.user_templates;
DROP POLICY IF EXISTS "Users can update own templates" ON public.user_templates;
DROP POLICY IF EXISTS "Users can delete own templates" ON public.user_templates;

-- Consolidated: single SELECT policy replaces two overlapping ones
CREATE POLICY "View own or public templates" ON public.user_templates
  FOR SELECT USING (is_public = true OR user_id = (select auth.uid()));
CREATE POLICY "Users can insert own templates" ON public.user_templates
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users can update own templates" ON public.user_templates
  FOR UPDATE USING ((select auth.uid()) = user_id);
CREATE POLICY "Users can delete own templates" ON public.user_templates
  FOR DELETE USING ((select auth.uid()) = user_id);

-- USER_UPLOADED_IMAGES: Fix initplan
DROP POLICY IF EXISTS "Users can manage their own uploaded images" ON public.user_uploaded_images;
CREATE POLICY "Users can manage their own uploaded images" ON public.user_uploaded_images
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));;
