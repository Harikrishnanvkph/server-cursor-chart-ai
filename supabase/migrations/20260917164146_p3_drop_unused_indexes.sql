-- P3-2: Drop confirmed-safe unused indexes (low-cardinality boolean/category columns)
-- These are on boolean flags and low-cardinality columns that PostgreSQL's sequential scan handles fine

-- user_templates: boolean flag indexes (never used)
DROP INDEX IF EXISTS idx_user_templates_is_official;
DROP INDEX IF EXISTS idx_user_templates_is_public;
DROP INDEX IF EXISTS idx_user_templates_created_at;

-- format_blueprints: boolean/category indexes (never used)
DROP INDEX IF EXISTS idx_format_blueprints_official;
DROP INDEX IF EXISTS idx_format_blueprints_category;

-- chart_snapshots: boolean flag indexes (never used)
DROP INDEX IF EXISTS idx_chart_snapshots_template_mode;
DROP INDEX IF EXISTS idx_chart_snapshots_is_current;

-- chart_style_presets: low-cardinality indexes (never used)
DROP INDEX IF EXISTS idx_chart_style_presets_official;
DROP INDEX IF EXISTS idx_chart_style_presets_category;

-- security_logs: rarely queried (never used)
DROP INDEX IF EXISTS idx_security_logs_action;
DROP INDEX IF EXISTS idx_security_logs_created_at;

-- profiles: redundant (email already has unique constraint, provider is low cardinality)
DROP INDEX IF EXISTS idx_profiles_email;
DROP INDEX IF EXISTS idx_profiles_provider;;
