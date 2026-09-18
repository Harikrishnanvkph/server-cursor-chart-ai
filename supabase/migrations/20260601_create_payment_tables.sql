-- Migration: 20260601_create_payment_tables.sql
-- Description: Create payment_transactions table and extend profiles with billing & location attributes.

-- 1. Extend profiles table with payment, location, and subscription tracking columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) DEFAULT 'GLOBAL',
  ADD COLUMN IF NOT EXISTS billing_currency VARCHAR(10) DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS payment_gateway VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gateway_customer_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gateway_subscription_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(30) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ DEFAULT NULL;

-- 2. Create payment_transactions table
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  gateway VARCHAR(30) NOT NULL, -- 'razorpay' | 'dodo' | 'simulation'
  gateway_order_id TEXT,
  gateway_payment_id TEXT,
  gateway_subscription_id TEXT,
  gateway_signature TEXT,
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  plan_tier VARCHAR(30) NOT NULL DEFAULT 'pro',
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'monthly', -- 'monthly' | 'yearly'
  status VARCHAR(30) NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'failed' | 'refunded'
  customer_email TEXT,
  customer_country VARCHAR(10),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create indexes for quick lookups
CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_id ON public.payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_gateway_order_id ON public.payment_transactions(gateway_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_gateway_payment_id ON public.payment_transactions(gateway_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON public.payment_transactions(status);

-- 4. Set up Row Level Security (RLS)
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own transaction history
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'payment_transactions' AND policyname = 'Users can view own transactions'
  ) THEN
    CREATE POLICY "Users can view own transactions"
      ON public.payment_transactions
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Policy: Service role can manage all transactions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'payment_transactions' AND policyname = 'Service role can manage all transactions'
  ) THEN
    CREATE POLICY "Service role can manage all transactions"
      ON public.payment_transactions
      FOR ALL
      USING (auth.jwt() ->> 'role' = 'service_role');
  END IF;
END $$;
