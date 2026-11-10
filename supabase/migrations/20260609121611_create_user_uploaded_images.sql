CREATE TABLE IF NOT EXISTS public.user_uploaded_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL UNIQUE, -- e.g. "presets/format-image-..."
  image_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_uploaded_images ENABLE ROW LEVEL SECURITY;

-- Drop policy if exists
DROP POLICY IF EXISTS "Users can manage their own uploaded images" ON public.user_uploaded_images;

-- Create RLS Policies
CREATE POLICY "Users can manage their own uploaded images"
  ON public.user_uploaded_images
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());;
