-- Migration: 20261102_credit_packs_overhaul.sql
-- Description: Overhaul pricing & quota system to AI Credits | Cloud Credits pack architecture
-- Free Baseline: 10 Monthly Free AI Credits + 5 Permanent Cloud Save Credits (Never Expire)
-- AI Packs: Lite ($2 -> +15 AI credits, never expire) | Pro ($5 -> +60 AI credits, never expire)
--   * First AI pack purchase grants a one-time +5 permanent cloud save credits bonus (never expires).
-- Cloud Packs: Lite ($2 -> +10 cloud save credits for 2 months) | Pro ($5 -> +15 cloud save credits for 6 months)

-- 1. Extend profiles table with two-bucket AI & Cloud credit columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS purchased_ai_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS permanent_cloud_credits INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS first_ai_bonus_claimed BOOLEAN NOT NULL DEFAULT false;

-- Update column defaults on profiles for new signups
ALTER TABLE public.profiles
  ALTER COLUMN subscription_tier SET DEFAULT 'free',
  ALTER COLUMN ai_credits_used SET DEFAULT 0,
  ALTER COLUMN ai_credits_limit SET DEFAULT 10,
  ALTER COLUMN cloud_charts_limit SET DEFAULT 5;

-- 2. Reset all existing profiles to the new Free baseline (10 monthly AI credits, 5 permanent cloud credits)
UPDATE public.profiles
SET
  subscription_tier = 'free',
  ai_credits_used = 0,
  ai_credits_limit = 10,
  purchased_ai_credits = 0,
  permanent_cloud_credits = 5,
  cloud_charts_limit = 5,
  first_ai_bonus_claimed = false,
  credits_reset_at = NOW() + INTERVAL '30 days';

-- 3. Extend payment_transactions table with pack_id and idempotency flag
ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS pack_id VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS fulfilled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_pack_id ON public.payment_transactions(pack_id);

-- 4. Create cloud_credit_grants table for time-limited Cloud Credits packs (+10 for 2mo, +15 for 6mo)
CREATE TABLE IF NOT EXISTS public.cloud_credit_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pack_id VARCHAR(30) NOT NULL CHECK (pack_id IN ('cloud_lite', 'cloud_pro')),
  credits_amount INTEGER NOT NULL CHECK (credits_amount > 0),
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  transaction_id UUID UNIQUE REFERENCES public.payment_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cloud_credit_grants_user_expiry
  ON public.cloud_credit_grants(user_id, expires_at);

ALTER TABLE public.cloud_credit_grants ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'cloud_credit_grants' AND policyname = 'Users can view own cloud credit grants'
  ) THEN
    CREATE POLICY "Users can view own cloud credit grants"
      ON public.cloud_credit_grants
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'cloud_credit_grants' AND policyname = 'Service role can manage all cloud credit grants'
  ) THEN
    CREATE POLICY "Service role can manage all cloud credit grants"
      ON public.cloud_credit_grants
      FOR ALL
      USING (auth.jwt() ->> 'role' = 'service_role');
  END IF;
END $$;

-- 5. Replace deduct_ai_credit RPC to consume Monthly Free AI Credits first, then Purchased (Never-Expiring) AI Credits
DROP FUNCTION IF EXISTS public.deduct_ai_credit(UUID);

CREATE OR REPLACE FUNCTION public.deduct_ai_credit(p_user_id UUID)
RETURNS TABLE (
  success BOOLEAN,
  out_credits_used INTEGER,
  out_credits_limit INTEGER,
  out_credits_remaining INTEGER,
  out_purchased_remaining INTEGER,
  out_deducted_bucket TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_used INTEGER;
  v_limit INTEGER;
  v_purchased INTEGER;
  v_reset_at TIMESTAMPTZ;
BEGIN
  -- Lock the user's profile row for atomic update
  SELECT
    COALESCE(ai_credits_used, 0),
    COALESCE(ai_credits_limit, 10),
    COALESCE(purchased_ai_credits, 0),
    credits_reset_at
  INTO v_used, v_limit, v_purchased, v_reset_at
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 10, 10, 0, 'none'::TEXT;
    RETURN;
  END IF;

  -- Auto-reset monthly free credits if the 30-day window has elapsed
  IF v_reset_at IS NULL OR v_reset_at <= NOW() THEN
    v_used := 0;
    v_reset_at := NOW() + INTERVAL '30 days';
    UPDATE public.profiles
    SET ai_credits_used = 0,
        credits_reset_at = v_reset_at
    WHERE id = p_user_id;
  END IF;

  -- Priority 1: Deduct from monthly free AI credits if available
  IF v_used < v_limit THEN
    v_used := v_used + 1;
    UPDATE public.profiles
    SET ai_credits_used = v_used
    WHERE id = p_user_id;

    RETURN QUERY SELECT
      true,
      v_used,
      v_limit,
      GREATEST(0, v_limit - v_used) + v_purchased,
      v_purchased,
      'free'::TEXT;
    RETURN;
  END IF;

  -- Priority 2: Deduct from never-expiring purchased AI credits
  IF v_purchased > 0 THEN
    v_purchased := v_purchased - 1;
    UPDATE public.profiles
    SET purchased_ai_credits = v_purchased
    WHERE id = p_user_id;

    RETURN QUERY SELECT
      true,
      v_used,
      v_limit,
      GREATEST(0, v_limit - v_used) + v_purchased,
      v_purchased,
      'purchased'::TEXT;
    RETURN;
  END IF;

  -- Exhausted both buckets
  RETURN QUERY SELECT
    false,
    v_used,
    v_limit,
    0,
    0,
    'none'::TEXT;
END;
$$;

-- 6. Create refund_ai_credit RPC to accurately refund back to the exact bucket deducted
CREATE OR REPLACE FUNCTION public.refund_ai_credit(p_user_id UUID, p_bucket TEXT DEFAULT 'free')
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_bucket = 'purchased' THEN
    UPDATE public.profiles
    SET purchased_ai_credits = COALESCE(purchased_ai_credits, 0) + 1
    WHERE id = p_user_id;
  ELSE
    UPDATE public.profiles
    SET ai_credits_used = GREATEST(0, COALESCE(ai_credits_used, 0) - 1)
    WHERE id = p_user_id;
  END IF;

  RETURN FOUND;
END;
$$;
