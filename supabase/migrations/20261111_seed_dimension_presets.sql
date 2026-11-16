-- =============================================
-- Seed 4:5 and 3:2 Presets
-- Adds Editorial Column (4:5), Cyber Pulse Area (4:5), Swiss Horizon (3:2), and Sunset Boardroom (3:2)
-- =============================================

INSERT INTO chart_style_presets (
  id, name, description, chart_type, color_strategy, config_snapshot, dataset_style, dimensions, category, tags, is_official, is_public, sort_order
) VALUES
  (
    'a1b2c3d4-4005-4001-8000-000000000001',
    'Editorial Column (4:5)',
    'Clean data-journalism aesthetic inspired by The Economist & FT with left-aligned headers and top-rounded columns',
    'bar',
    '{
      "mode": "slice",
      "singleColor": null,
      "baseColors": ["#1e293b", "#d97706", "#0f766e", "#dc2626", "#4338ca", "#475569", "#2563eb", "#ca8a04"],
      "baseBorderColors": []
    }'::jsonb,
    '{
      "visualSettings": { "fillArea": true, "showBorder": true, "showImages": true, "showLabels": true, "uniformityMode": "uniform" },
      "background": { "type": "color", "color": "#fcfbf9", "opacity": 100 },
      "layout": { "padding": { "top": 36, "right": 32, "bottom": 36, "left": 32 } },
      "plugins": {
        "title": { "display": true, "font": { "size": 22, "weight": "800" }, "color": "#0f172a", "align": "start" },
        "subtitle": { "display": true, "font": { "size": 14, "weight": "500" }, "color": "#64748b", "align": "start" },
        "legend": { "display": false },
        "tooltip": { "enabled": true, "backgroundColor": "rgba(15,23,42,0.9)", "titleColor": "#fff", "bodyColor": "#fff", "borderColor": "#334155", "borderWidth": 1 },
        "datalabels": { "display": true, "anchor": "end", "align": "top", "offset": 4, "color": "#1e293b", "font": { "weight": "bold", "size": 12 } }
      },
      "scales": {
        "x": {
          "display": true,
          "grid": { "display": false },
          "ticks": { "color": "#334155", "font": { "size": 12, "weight": "600" } },
          "border": { "display": true, "color": "#cbd5e1" }
        },
        "y": {
          "display": true,
          "grid": { "display": true, "color": "#e5e7eb" },
          "ticks": { "color": "#64748b", "font": { "size": 11 } },
          "border": { "display": false },
          "title": { "display": true, "text": "Metric", "color": "#64748b", "font": { "size": 12, "weight": "500" } }
        }
      },
      "animation": { "duration": 1000, "easing": "easeOutQuart" },
      "interaction": { "intersect": true, "mode": "point" },
      "hoverFadeEffect": false
    }'::jsonb,
    '{ "borderWidth": 0, "tension": 0, "fill": true, "pointRadius": 0, "borderRadius": { "topLeft": 8, "topRight": 8, "bottomLeft": 0, "bottomRight": 0 } }'::jsonb,
    '{ "width": "1080px", "height": "1350px" }'::jsonb,
    'professional',
    ARRAY['editorial', '4:5', 'portrait', 'minimal', 'journalism', 'report', 'clean'],
    true,
    true,
    18
  ),
  (
    'a1b2c3d4-4005-4001-8000-000000000002',
    'Cyber Pulse Area (4:5)',
    'Luminous neon area chart on deep space gradient with glowing data nodes for tech & fintech feeds',
    'line',
    '{
      "mode": "single",
      "singleColor": "#06b6d4",
      "baseColors": ["#06b6d4", "#8b5cf6", "#3b82f6", "#10b981"],
      "baseBorderColors": ["#0891b2"]
    }'::jsonb,
    '{
      "visualSettings": { "fillArea": true, "showBorder": true, "showImages": true, "showLabels": true, "uniformityMode": "uniform" },
      "background": {
        "type": "gradient",
        "gradientType": "linear",
        "gradientDirection": "to bottom",
        "gradientColor1": "#090d16",
        "gradientColor2": "#0f172a",
        "opacity": 100
      },
      "layout": { "padding": { "top": 36, "right": 32, "bottom": 36, "left": 32 } },
      "plugins": {
        "title": { "display": true, "font": { "size": 22, "weight": "800" }, "color": "#f8fafc" },
        "subtitle": { "display": true, "font": { "size": 14, "weight": "400" }, "color": "rgba(255, 255, 255, 0.6)" },
        "legend": { "display": true, "position": "bottom", "labels": { "color": "#cbd5e1", "usePointStyle": true, "pointStyle": "rectRounded" } },
        "tooltip": { "enabled": true, "backgroundColor": "rgba(9,13,22,0.95)", "titleColor": "#fff", "bodyColor": "#fff", "borderColor": "rgba(6,182,212,0.4)", "borderWidth": 1 },
        "datalabels": { "display": false }
      },
      "scales": {
        "x": {
          "display": true,
          "grid": { "display": true, "color": "rgba(255, 255, 255, 0.05)" },
          "ticks": { "color": "rgba(255, 255, 255, 0.6)", "font": { "size": 11 } },
          "border": { "display": true, "color": "rgba(255, 255, 255, 0.1)" },
          "title": { "display": true, "text": "Timeline", "color": "rgba(255, 255, 255, 0.5)", "font": { "size": 12, "weight": "500" } }
        },
        "y": {
          "display": true,
          "grid": { "display": true, "color": "rgba(255, 255, 255, 0.05)" },
          "ticks": { "color": "rgba(255, 255, 255, 0.6)", "font": { "size": 11 } },
          "border": { "display": false },
          "title": { "display": true, "text": "Activity", "color": "rgba(255, 255, 255, 0.5)", "font": { "size": 12, "weight": "500" } }
        }
      },
      "animation": { "duration": 1000, "easing": "easeOutQuart" },
      "interaction": { "intersect": true, "mode": "point" },
      "hoverFadeEffect": false
    }'::jsonb,
    '{ "borderWidth": 3, "tension": 0.4, "fill": true, "pointRadius": 5, "pointHoverRadius": 8, "pointBorderWidth": 2, "pointStyle": "circle", "borderRadius": 0 }'::jsonb,
    '{ "width": "1080px", "height": "1350px" }'::jsonb,
    'dark',
    ARRAY['cyber', '4:5', 'neon', 'fintech', 'dark', 'glow', 'area', 'line'],
    true,
    true,
    19
  ),
  (
    'a1b2c3d4-3002-4001-8000-000000000001',
    'Swiss Horizon (3:2)',
    'Architectural Swiss modernist aesthetic for 3:2 landscape presentations with balanced horizontal bars',
    'horizontalBar',
    '{
      "mode": "slice",
      "singleColor": null,
      "baseColors": ["#dc2626", "#1e3a8a", "#475569", "#047857", "#ca8a04", "#2563eb", "#0891b2", "#0f172a"],
      "baseBorderColors": []
    }'::jsonb,
    '{
      "visualSettings": { "fillArea": true, "showBorder": true, "showImages": true, "showLabels": true, "uniformityMode": "uniform" },
      "background": { "type": "color", "color": "#ffffff", "opacity": 100 },
      "layout": { "padding": { "top": 40, "right": 48, "bottom": 40, "left": 48 } },
      "plugins": {
        "title": { "display": true, "font": { "size": 24, "weight": "800" }, "color": "#111827", "align": "start" },
        "subtitle": { "display": true, "font": { "size": 15, "weight": "400" }, "color": "#6b7280", "align": "start" },
        "legend": { "display": true, "position": "top", "align": "end", "labels": { "color": "#374151", "usePointStyle": true, "pointStyle": "rect" } },
        "tooltip": { "enabled": true, "backgroundColor": "rgba(17,24,39,0.9)", "titleColor": "#fff", "bodyColor": "#fff", "borderColor": "#e2e8f0", "borderWidth": 1 },
        "datalabels": { "display": true, "anchor": "end", "align": "end", "offset": 6, "color": "#111827", "font": { "weight": "bold", "size": 13 } }
      },
      "scales": {
        "x": {
          "display": true,
          "grid": { "display": true, "color": "#f1f5f9" },
          "ticks": { "color": "#64748b", "font": { "size": 12 } },
          "border": { "display": false },
          "title": { "display": true, "text": "Value (Units)", "color": "#64748b", "font": { "size": 13, "weight": "600" } }
        },
        "y": {
          "display": true,
          "grid": { "display": false },
          "ticks": { "color": "#111827", "font": { "size": 13, "weight": "600" } },
          "border": { "display": true, "color": "#e2e8f0" }
        }
      },
      "animation": { "duration": 1000, "easing": "easeOutQuart" },
      "interaction": { "intersect": true, "mode": "point" },
      "hoverFadeEffect": false
    }'::jsonb,
    '{ "borderWidth": 0, "tension": 0, "fill": true, "pointRadius": 0, "borderRadius": 4 }'::jsonb,
    '{ "width": "1620px", "height": "1080px" }'::jsonb,
    'minimal',
    ARRAY['swiss', '3:2', 'landscape', 'minimal', 'modernist', 'clean', 'presentation'],
    true,
    true,
    20
  ),
  (
    'a1b2c3d4-3002-4001-8000-000000000002',
    'Sunset Boardroom (3:2)',
    'Warm terracotta and amber executive landscape slide with floating pillar bars for investor keynotes',
    'bar',
    '{
      "mode": "slice",
      "singleColor": null,
      "baseColors": ["#ea580c", "#f59e0b", "#c2410c", "#78350f", "#f43f5e", "#d97706", "#b45309", "#92400e"],
      "baseBorderColors": []
    }'::jsonb,
    '{
      "visualSettings": { "fillArea": true, "showBorder": true, "showImages": true, "showLabels": true, "uniformityMode": "uniform" },
      "background": {
        "type": "gradient",
        "gradientType": "linear",
        "gradientDirection": "to bottom",
        "gradientColor1": "#fffdfa",
        "gradientColor2": "#fef7ee",
        "opacity": 100
      },
      "layout": { "padding": { "top": 40, "right": 48, "bottom": 40, "left": 48 } },
      "plugins": {
        "title": { "display": true, "font": { "size": 24, "weight": "800" }, "color": "#451a03" },
        "subtitle": { "display": true, "font": { "size": 15, "weight": "500" }, "color": "#9a3412" },
        "legend": { "display": true, "position": "bottom", "labels": { "color": "#78350f", "usePointStyle": true, "pointStyle": "rectRounded" } },
        "tooltip": { "enabled": true, "backgroundColor": "rgba(69,26,3,0.9)", "titleColor": "#fff", "bodyColor": "#fff", "borderColor": "#fed7aa", "borderWidth": 1 },
        "datalabels": { "display": true, "anchor": "end", "align": "top", "offset": 4, "color": "#9a3412", "font": { "weight": "bold", "size": 13 } }
      },
      "scales": {
        "x": {
          "display": true,
          "grid": { "display": false },
          "ticks": { "color": "#78350f", "font": { "size": 12, "weight": "600" } },
          "border": { "display": true, "color": "#fde68a" },
          "title": { "display": true, "text": "Segments", "color": "#78350f", "font": { "size": 13, "weight": "600" } }
        },
        "y": {
          "display": true,
          "grid": { "display": true, "color": "#fef3c7" },
          "ticks": { "color": "#9a3412", "font": { "size": 12 } },
          "border": { "display": false },
          "title": { "display": true, "text": "Revenue Growth", "color": "#9a3412", "font": { "size": 13, "weight": "600" } }
        }
      },
      "animation": { "duration": 1000, "easing": "easeOutQuart" },
      "interaction": { "intersect": true, "mode": "point" },
      "hoverFadeEffect": false
    }'::jsonb,
    '{ "borderWidth": 0, "tension": 0, "fill": true, "pointRadius": 0, "borderRadius": { "topLeft": 10, "topRight": 10, "bottomLeft": 0, "bottomRight": 0 } }'::jsonb,
    '{ "width": "1620px", "height": "1080px" }'::jsonb,
    'bold',
    ARRAY['sunset', '3:2', 'landscape', 'executive', 'warm', 'keynote', 'deck', 'amber'],
    true,
    true,
    21
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
