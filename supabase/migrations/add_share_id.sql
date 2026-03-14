-- Add this script to your Supabase SQL editor to enable the Share Link feature

-- 1. Add the share_id column to the chart_snapshots table
ALTER TABLE public.chart_snapshots
ADD COLUMN share_id UUID UNIQUE DEFAULT NULL;

-- 2. Create an index on share_id for fast lookup
CREATE INDEX IF NOT EXISTS idx_chart_snapshots_share_id ON public.chart_snapshots(share_id);

-- Note: We do NOT need to add any row-level security (RLS) policies 
-- for the public share route because the backend fetches it using 
-- the service_role key bypassing RLS, making it perfectly secure 
-- while allowing anyone with the link to view it.
