-- P1-5: Fix chart_style_presets FK inconsistency
-- Change from auth.users(id) ON DELETE SET NULL to profiles(id) ON DELETE CASCADE
ALTER TABLE public.chart_style_presets
  DROP CONSTRAINT IF EXISTS chart_style_presets_user_id_fkey;

ALTER TABLE public.chart_style_presets
  ADD CONSTRAINT chart_style_presets_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- P2-6: Add missing index on user_uploaded_images.user_id
CREATE INDEX IF NOT EXISTS idx_user_uploaded_images_user_id ON public.user_uploaded_images(user_id);;
