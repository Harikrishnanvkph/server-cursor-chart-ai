-- =============================================
-- Seed 9:16 Corporate Presets
-- Adds Executive Briefing (9:16) and Midnight Boardroom (9:16)
-- =============================================

INSERT INTO chart_style_presets (
  id, name, description, chart_type, color_strategy, config_snapshot, dataset_style, dimensions, category, tags, is_official, is_public, sort_order
) VALUES
  (
    'a1b2c3d4-9f16-4001-8000-000000000001',
    'Executive Briefing (9:16)',
    'High-contrast corporate portrait theme optimized for 9:16 executive decks, board reports, and mobile stories',
    'horizontalBar',
    '{
      "mode": "slice",
      "singleColor": null,
      "baseColors": ["#1e3a8a", "#2563eb", "#0284c7", "#0f766e", "#475569", "#d97706", "#4338ca", "#64748b"],
      "baseBorderColors": []
    }'::jsonb,
    '{
      "visualSettings": { "fillArea": true, "showBorder": true, "showImages": true, "showLabels": true, "uniformityMode": "uniform" },
      "background": {
        "type": "gradient",
        "gradientType": "linear",
        "gradientDirection": "to bottom",
        "gradientColor1": "#ffffff",
        "gradientColor2": "#f8fafc",
        "opacity": 100
      },
      "layout": { "padding": { "top": 32, "right": 28, "bottom": 32, "left": 28 } },
      "plugins": {
        "title": { "display": true, "font": { "size": 22, "weight": "800" }, "color": "#0f172a" },
        "subtitle": { "display": true, "font": { "size": 14, "weight": "500" }, "color": "#475569" },
        "legend": { "display": true, "position": "bottom", "labels": { "color": "#334155", "usePointStyle": true, "pointStyle": "rectRounded" } },
        "tooltip": { "enabled": true, "backgroundColor": "rgba(15,23,42,0.9)", "titleColor": "#fff", "bodyColor": "#fff", "borderColor": "#334155", "borderWidth": 1 },
        "datalabels": { "display": true, "anchor": "end", "align": "end", "offset": 4, "color": "#0f172a", "font": { "weight": "bold", "size": 13 } }
      },
      "scales": {
        "x": {
          "display": true,
          "grid": { "display": true, "color": "#e2e8f0" },
          "ticks": { "color": "#64748b", "font": { "size": 12, "weight": "500" } },
          "border": { "display": false },
          "title": { "display": true, "text": "Metric", "color": "#64748b", "font": { "size": 13, "weight": "600" } }
        },
        "y": {
          "display": true,
          "grid": { "display": false },
          "ticks": { "color": "#0f172a", "font": { "size": 13, "weight": "600" } },
          "border": { "display": true, "color": "#cbd5e1" }
        }
      },
      "animation": { "duration": 1000, "easing": "easeOutQuart" },
      "interaction": { "intersect": true, "mode": "point" },
      "hoverFadeEffect": false
    }'::jsonb,
    '{ "borderWidth": 0, "tension": 0, "fill": true, "pointRadius": 0, "borderRadius": 6 }'::jsonb,
    '{ "width": "1080px", "height": "1920px" }'::jsonb,
    'professional',
    ARRAY['corporate', '9:16', 'portrait', 'executive', 'business', 'story', 'mobile'],
    true,
    true,
    16
  ),
  (
    'a1b2c3d4-9f16-4001-8000-000000000002',
    'Midnight Boardroom (9:16)',
    'Dark executive corporate theme with luminous sapphire accents for 9:16 mobile feeds and presentations',
    'horizontalBar',
    '{
      "mode": "slice",
      "singleColor": null,
      "baseColors": ["#38bdf8", "#60a5fa", "#818cf8", "#34d399", "#fbbf24", "#a78bfa", "#22d3ee", "#94a3b8"],
      "baseBorderColors": []
    }'::jsonb,
    '{
      "visualSettings": { "fillArea": true, "showBorder": true, "showImages": true, "showLabels": true, "uniformityMode": "uniform" },
      "background": {
        "type": "gradient",
        "gradientType": "linear",
        "gradientDirection": "to bottom",
        "gradientColor1": "#0a1128",
        "gradientColor2": "#101f42",
        "opacity": 100
      },
      "layout": { "padding": { "top": 32, "right": 28, "bottom": 32, "left": 28 } },
      "plugins": {
        "title": { "display": true, "font": { "size": 22, "weight": "800" }, "color": "#f8fafc" },
        "subtitle": { "display": true, "font": { "size": 14, "weight": "400" }, "color": "#94a3b8" },
        "legend": { "display": true, "position": "bottom", "labels": { "color": "#cbd5e1", "usePointStyle": true, "pointStyle": "rectRounded" } },
        "tooltip": { "enabled": true, "backgroundColor": "rgba(10,17,40,0.95)", "titleColor": "#fff", "bodyColor": "#fff", "borderColor": "rgba(56,189,248,0.3)", "borderWidth": 1 },
        "datalabels": { "display": true, "anchor": "end", "align": "end", "offset": 4, "color": "#f8fafc", "font": { "weight": "bold", "size": 13 } }
      },
      "scales": {
        "x": {
          "display": true,
          "grid": { "display": true, "color": "rgba(255, 255, 255, 0.08)" },
          "ticks": { "color": "#94a3b8", "font": { "size": 12, "weight": "500" } },
          "border": { "display": false },
          "title": { "display": true, "text": "Metric", "color": "#94a3b8", "font": { "size": 13, "weight": "600" } }
        },
        "y": {
          "display": true,
          "grid": { "display": false },
          "ticks": { "color": "#f1f5f9", "font": { "size": 13, "weight": "600" } },
          "border": { "display": true, "color": "rgba(255, 255, 255, 0.15)" }
        }
      },
      "animation": { "duration": 1000, "easing": "easeOutQuart" },
      "interaction": { "intersect": true, "mode": "point" },
      "hoverFadeEffect": false
    }'::jsonb,
    '{ "borderWidth": 0, "tension": 0, "fill": true, "pointRadius": 0, "borderRadius": 6 }'::jsonb,
    '{ "width": "1080px", "height": "1920px" }'::jsonb,
    'dark',
    ARRAY['corporate', '9:16', 'portrait', 'executive', 'dark', 'fintech', 'story', 'mobile'],
    true,
    true,
    17
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  chart_type = EXCLUDED.chart_type,
  color_strategy = EXCLUDED.color_strategy,
  config_snapshot = EXCLUDED.config_snapshot,
  dataset_style = EXCLUDED.dataset_style,
  dimensions = EXCLUDED.dimensions,
  category = EXCLUDED.category,
  tags = EXCLUDED.tags,
  is_official = EXCLUDED.is_official,
  is_public = EXCLUDED.is_public,
  sort_order = EXCLUDED.sort_order;
