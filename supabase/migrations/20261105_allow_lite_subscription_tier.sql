-- Migration: 20261105_allow_lite_subscription_tier.sql
-- Description: Allow 'lite' in profiles.subscription_tier check constraint.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS check_subscription_tier;

ALTER TABLE public.profiles
  ADD CONSTRAINT check_subscription_tier
  CHECK (subscription_tier = ANY (ARRAY['free'::text, 'lite'::text, 'pro'::text, 'enterprise'::text]));
