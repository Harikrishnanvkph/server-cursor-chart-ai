-- =============================================
-- Chart Style Presets Table
-- Migration for the Chart Style Gallery feature
-- =============================================

CREATE TABLE IF NOT EXISTS chart_style_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name TEXT NOT NULL,
  description TEXT,

  -- Chart type (bar, line, pie, doughnut, radar, polarArea, etc.)
  chart_type TEXT NOT NULL,

  -- Color strategy (JSONB)
  -- { mode: 'single'|'slice', singleColor: string|null, baseColors: string[], baseBorderColors: string[] }
  color_strategy JSONB NOT NULL DEFAULT '{
    "mode": "slice",
    "singleColor": null,
    "baseColors": [],
    "baseBorderColors": []
  }',

  -- Sanitized chart config (JSONB) — NO data-dependent values (no min/max/stepSize/title text)
  config_snapshot JSONB NOT NULL DEFAULT '{}',

  -- Dataset-level style template (JSONB)
  -- { borderWidth, tension, fill, pointRadius, borderRadius, datasetPattern, hoverOffset }
  dataset_style JSONB NOT NULL DEFAULT '{
    "borderWidth": 2,
    "tension": 0,
    "fill": false,
    "pointRadius": 3,
    "borderRadius": 0
  }',

  -- Dimensions (optional — user can opt-in to adopt preset dimensions)
  -- { width: '800px', height: '600px' }
  dimensions JSONB DEFAULT '{ "width": "800px", "height": "600px" }',

  -- Categorization
  category TEXT DEFAULT 'minimal',
  tags TEXT[] DEFAULT '{}',

  -- Ownership & visibility
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  is_official BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT FALSE,
  sort_order INT DEFAULT 100,

  -- Thumbnail (generated or base64)
  thumbnail_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- Indexes
-- =============================================

CREATE INDEX IF NOT EXISTS idx_chart_style_presets_official
  ON chart_style_presets (is_official)
  WHERE is_official = true;

CREATE INDEX IF NOT EXISTS idx_chart_style_presets_user
  ON chart_style_presets (user_id);

CREATE INDEX IF NOT EXISTS idx_chart_style_presets_chart_type
  ON chart_style_presets (chart_type);

CREATE INDEX IF NOT EXISTS idx_chart_style_presets_category
  ON chart_style_presets (category);

-- =============================================
-- Row Level Security (RLS)
-- =============================================

ALTER TABLE chart_style_presets ENABLE ROW LEVEL SECURITY;

-- Anyone can read official or public presets, or their own
CREATE POLICY "read_official_public_or_own" ON chart_style_presets
  FOR SELECT USING (
    is_official = true
    OR is_public = true
    OR user_id = auth.uid()
  );

-- Users can insert their own presets
CREATE POLICY "insert_own_presets" ON chart_style_presets
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own presets
CREATE POLICY "update_own_presets" ON chart_style_presets
  FOR UPDATE USING (user_id = auth.uid());

-- Users can delete their own presets
CREATE POLICY "delete_own_presets" ON chart_style_presets
  FOR DELETE USING (user_id = auth.uid());
