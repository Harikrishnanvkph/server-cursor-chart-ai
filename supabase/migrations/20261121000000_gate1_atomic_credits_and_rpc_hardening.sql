-- ============================================================
-- Migration: 20261121000000_gate1_atomic_credits_and_rpc_hardening.sql
-- Gate 1 Security & Billing Atomicity:
--   1. public.deduct_ai_credits(UUID, INTEGER) -> atomic multi-credit deduction
--      using fixed monthly free allowance = 10 (NOT ai_credits_limit).
--   2. public.refund_ai_credits(UUID, INTEGER, INTEGER) -> atomic split refund
--      returning exact deducted counts to ai_credits_used & purchased_ai_credits.
--   3. Revoke PUBLIC / anon / authenticated EXECUTE on sensitive SECURITY DEFINER
--      RPCs and grant EXECUTE exclusively to service_role.
-- ============================================================

CREATE OR REPLACE FUNCTION public.deduct_ai_credits(
  p_user_id UUID,
  p_amount INTEGER DEFAULT 1
)
RETURNS TABLE (
  success BOOLEAN,
  exhausted BOOLEAN,
  out_free_used INTEGER,
  out_purchased_remaining INTEGER,
  out_deducted_free INTEGER,
  out_deducted_purchased INTEGER,
  out_deducted_bucket TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_free_limit CONSTANT INTEGER := 10;
  v_used INTEGER;
  v_purchased INTEGER;
  v_reset_at TIMESTAMPTZ;
  v_reset_triggered BOOLEAN := false;
  v_free_avail INTEGER;
  v_deduct_free INTEGER;
  v_deduct_purchased INTEGER;
  v_new_used INTEGER;
  v_new_purchased INTEGER;
  v_bucket TEXT;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT false, false, 0, 0, 0, 0, 'none'::TEXT;
    RETURN;
  END IF;

  -- Lock profile row to serialize concurrent AI credit deductions for the same user
  SELECT
    GREATEST(0, COALESCE(ai_credits_used, 0)),
    GREATEST(0, COALESCE(purchased_ai_credits, 0)),
    credits_reset_at
  INTO v_used, v_purchased, v_reset_at
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, true, 0, 0, 0, 0, 'none'::TEXT;
    RETURN;
  END IF;

  -- Auto-reset 30-day monthly free credit allowance when expired
  IF v_reset_at IS NULL OR v_reset_at <= NOW() THEN
    v_used := 0;
    v_reset_at := NOW() + INTERVAL '30 days';
    v_reset_triggered := true;
  END IF;

  v_free_avail := GREATEST(0, v_free_limit - v_used);

  -- Fail cleanly if combined pool cannot cover requested p_amount (1 for chart, 2 for template)
  IF (v_free_avail + v_purchased) < p_amount THEN
    IF v_reset_triggered THEN
      UPDATE public.profiles
      SET ai_credits_used = v_used,
          credits_reset_at = v_reset_at,
          updated_at = NOW()
      WHERE id = p_user_id;
    END IF;

    RETURN QUERY SELECT
      false,
      true,
      v_used,
      v_purchased,
      0,
      0,
      'none'::TEXT;
    RETURN;
  END IF;

  -- Deduct from monthly free allowance first, then never-expiring purchased pool
  v_deduct_free := LEAST(p_amount, v_free_avail);
  v_deduct_purchased := p_amount - v_deduct_free;
  v_new_used := v_used + v_deduct_free;
  v_new_purchased := v_purchased - v_deduct_purchased;

  v_bucket := CASE
    WHEN v_deduct_free > 0 AND v_deduct_purchased > 0 THEN 'split'
    WHEN v_deduct_purchased > 0 THEN 'purchased'
    ELSE 'free'
  END;

  UPDATE public.profiles
  SET ai_credits_used = v_new_used,
      purchased_ai_credits = v_new_purchased,
      credits_reset_at = v_reset_at,
      updated_at = NOW()
  WHERE id = p_user_id;

  RETURN QUERY SELECT
    true,
    false,
    v_new_used,
    v_new_purchased,
    v_deduct_free,
    v_deduct_purchased,
    v_bucket;
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_ai_credits(
  p_user_id UUID,
  p_free INTEGER DEFAULT 0,
  p_purchased INTEGER DEFAULT 0
)
RETURNS TABLE (
  success BOOLEAN,
  out_free_used INTEGER,
  out_purchased_remaining INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_free_refund CONSTANT INTEGER := GREATEST(0, COALESCE(p_free, 0));
  v_purch_refund CONSTANT INTEGER := GREATEST(0, COALESCE(p_purchased, 0));
  v_new_used INTEGER;
  v_new_purchased INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  UPDATE public.profiles
  SET ai_credits_used = GREATEST(0, COALESCE(ai_credits_used, 0) - v_free_refund),
      purchased_ai_credits = GREATEST(0, COALESCE(purchased_ai_credits, 0)) + v_purch_refund,
      updated_at = NOW()
  WHERE id = p_user_id
  RETURNING ai_credits_used, purchased_ai_credits
  INTO v_new_used, v_new_purchased;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_new_used, v_new_purchased;
END;
$$;

-- Hardening: Revoke EXECUTE from PUBLIC, anon, and authenticated across all
-- sensitive SECURITY DEFINER RPCs and grant exclusively to service_role.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT p.oid::regprocedure AS func_sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'deduct_ai_credits',
        'refund_ai_credits',
        'deduct_ai_credit',
        'refund_ai_credit',
        'add_purchased_credits',
        'check_and_deduct_credits',
        'refund_credits',
        'sync_user_subscription',
        'activate_subscription',
        'cancel_subscription',
        'grant_credits',
        'reset_monthly_credits',
        'increment_saved_charts',
        'decrement_saved_charts',
        'update_user_plan',
        'record_payment_transaction',
        'claim_credit_pack_fulfillment',
        'fulfill_payment_transaction',
        'save_chart_snapshot',
        'update_user_profile',
        'get_user_profile_by_email',
        'create_conversation_with_message',
        'get_user_conversations',
        'get_user_templates',
        'upsert_user_template',
        'add_chat_message',
        'log_security_event',
        'get_session_stats',
        'cleanup_expired_oauth_sessions',
        'cleanup_old_security_logs',
        'handle_new_user',
        'prevent_profile_privilege_escalation'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', rec.func_sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, public', rec.func_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', rec.func_sig);
  END LOOP;
END $$;
