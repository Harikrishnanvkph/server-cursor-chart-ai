-- ============================================================
-- Security Hardening: Restore RPC Execute Revocations, Search Path,
-- and Protect Privileged Columns on public.profiles
-- ============================================================

-- 1. Re-apply search_path and REVOKE EXECUTE on credit RPC functions
--    (Dropped when 20261102_credit_packs_overhaul.sql recreated them)
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT p.oid::regprocedure AS func_sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('deduct_ai_credit', 'refund_ai_credit')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', rec.func_sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, public', rec.func_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', rec.func_sig);
  END LOOP;
END $$;

-- 2. Prevent authenticated users from directly escalating privileges or mutating
--    credit balances via PostgREST UPDATE on public.profiles
CREATE OR REPLACE FUNCTION public.prevent_profile_privilege_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Allow service_role / postgres superuser / backend admin operations
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'authenticated'
     AND current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Preserve privileged and billing columns for standard authenticated users
  NEW.is_admin := OLD.is_admin;
  NEW.subscription_tier := OLD.subscription_tier;
  NEW.subscription_status := OLD.subscription_status;
  NEW.ai_credits_used := OLD.ai_credits_used;
  NEW.ai_credits_limit := OLD.ai_credits_limit;
  NEW.purchased_ai_credits := OLD.purchased_ai_credits;
  NEW.permanent_cloud_credits := OLD.permanent_cloud_credits;
  NEW.cloud_charts_limit := OLD.cloud_charts_limit;
  NEW.first_ai_bonus_claimed := OLD.first_ai_bonus_claimed;
  NEW.credits_reset_at := OLD.credits_reset_at;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_profile_privilege_escalation ON public.profiles;
CREATE TRIGGER trg_prevent_profile_privilege_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_profile_privilege_escalation();
