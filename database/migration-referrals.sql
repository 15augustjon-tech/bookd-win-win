-- Referral & Earnings System Migration
-- Run this in Supabase SQL Editor after schema.sql and migration-payments.sql

-- ============================================
-- ADD TIER COLUMNS TO BROKERS
-- ============================================

ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'pro'));

ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS tier_started_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- ============================================
-- ADD REFERRAL CODE TO TRUCKERS
-- ============================================

ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- Generate referral codes for existing truckers
UPDATE truckers
SET referral_code = 'REF' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 6))
WHERE referral_code IS NULL;

-- ============================================
-- CREATE EARNINGS LEDGER TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS earnings_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trucker_id UUID REFERENCES truckers(id) ON DELETE CASCADE NOT NULL,

  -- What generated this earning
  source_type TEXT NOT NULL CHECK (source_type IN (
    'broker_free_fee',        -- 10% of 5% from Free broker transactions
    'broker_pro_subscription', -- 40% or 70% of Pro broker monthly fee
    'recruiter_bonus'         -- 10% of recruited trucker's earnings
  )),

  -- Source references
  source_broker_id UUID REFERENCES brokers(id) ON DELETE SET NULL,
  source_trucker_id UUID REFERENCES truckers(id) ON DELETE SET NULL,
  source_request_id UUID REFERENCES early_pay_requests(id) ON DELETE SET NULL,

  -- Amounts
  gross_amount DECIMAL(10,2) NOT NULL,  -- Total fee collected
  trucker_share DECIMAL(10,2) NOT NULL, -- What trucker earns

  -- Status tracking
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending',     -- Fee collected, waiting 7-day hold
    'payable',     -- Past hold period, ready for payout
    'paid_out',    -- Included in a payout
    'clawed_back'  -- Reversed due to chargeback
  )),

  -- Timing
  becomes_payable_at TIMESTAMP WITH TIME ZONE, -- 7 days after collection
  collected_at TIMESTAMP WITH TIME ZONE,
  paid_out_at TIMESTAMP WITH TIME ZONE,
  payout_id UUID, -- References payouts table when paid

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- CREATE TRUCKER RECRUITERS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS trucker_recruiters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id UUID REFERENCES truckers(id) ON DELETE CASCADE NOT NULL,
  recruited_id UUID REFERENCES truckers(id) ON DELETE CASCADE NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- CREATE PAYOUTS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trucker_id UUID REFERENCES truckers(id) ON DELETE CASCADE NOT NULL,

  -- Payout details
  amount DECIMAL(10,2) NOT NULL,
  method TEXT CHECK (method IN ('paypal', 'venmo')),

  -- Status tracking
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending',    -- Created, not yet sent
    'processing', -- Sent to PayPal
    'success',    -- PayPal confirmed
    'failed'      -- PayPal rejected
  )),

  -- PayPal tracking
  paypal_payout_id TEXT,
  error TEXT,

  -- Timing
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE
);

-- ============================================
-- CREATE INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX IF NOT EXISTS idx_earnings_trucker_status
ON earnings_ledger(trucker_id, status);

CREATE INDEX IF NOT EXISTS idx_earnings_payable
ON earnings_ledger(becomes_payable_at)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_payouts_trucker
ON payouts(trucker_id);

CREATE INDEX IF NOT EXISTS idx_recruiters_recruiter
ON trucker_recruiters(recruiter_id);

-- ============================================
-- CREATE HELPER FUNCTIONS
-- ============================================

-- Function to get trucker's Pro broker count
CREATE OR REPLACE FUNCTION get_pro_broker_count(p_trucker_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(DISTINCT b.id)
    FROM trucker_broker_relationships tbr
    JOIN brokers b ON b.id = tbr.broker_id
    WHERE tbr.trucker_id = p_trucker_id
    AND tbr.status = 'active'
    AND b.tier = 'pro'
  );
END;
$$ LANGUAGE plpgsql;

-- Function to calculate earning rate based on Pro broker count
CREATE OR REPLACE FUNCTION get_earning_rate(p_trucker_id UUID)
RETURNS DECIMAL AS $$
DECLARE
  pro_count INTEGER;
BEGIN
  pro_count := get_pro_broker_count(p_trucker_id);
  IF pro_count >= 10 THEN
    RETURN 0.70; -- 70% for 10+ Pro brokers
  ELSE
    RETURN 0.40; -- 40% for 1-9 Pro brokers
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to get monthly earnings from a specific broker (for $100 cap)
CREATE OR REPLACE FUNCTION get_monthly_earnings_from_broker(
  p_trucker_id UUID,
  p_broker_id UUID
)
RETURNS DECIMAL AS $$
BEGIN
  RETURN COALESCE((
    SELECT SUM(trucker_share)
    FROM earnings_ledger
    WHERE trucker_id = p_trucker_id
    AND source_broker_id = p_broker_id
    AND source_type = 'broker_free_fee'
    AND created_at >= DATE_TRUNC('month', NOW())
    AND status != 'clawed_back'
  ), 0);
END;
$$ LANGUAGE plpgsql;

-- Function to log a Free broker earning (called when early pay funded)
CREATE OR REPLACE FUNCTION log_free_broker_earning(
  p_trucker_id UUID,
  p_broker_id UUID,
  p_request_id UUID,
  p_transaction_amount DECIMAL
)
RETURNS UUID AS $$
DECLARE
  fee_amount DECIMAL;
  trucker_cut DECIMAL;
  monthly_earned DECIMAL;
  capped_cut DECIMAL;
  new_id UUID;
BEGIN
  -- Calculate 5% fee
  fee_amount := p_transaction_amount * 0.05;

  -- Trucker gets 10% of that
  trucker_cut := fee_amount * 0.10;

  -- Check monthly cap ($100 per broker)
  monthly_earned := get_monthly_earnings_from_broker(p_trucker_id, p_broker_id);

  IF monthly_earned + trucker_cut > 100 THEN
    capped_cut := GREATEST(0, 100 - monthly_earned);
  ELSE
    capped_cut := trucker_cut;
  END IF;

  -- Only insert if there's something to earn
  IF capped_cut > 0 THEN
    INSERT INTO earnings_ledger (
      trucker_id,
      source_type,
      source_broker_id,
      source_request_id,
      gross_amount,
      trucker_share,
      status,
      collected_at,
      becomes_payable_at
    ) VALUES (
      p_trucker_id,
      'broker_free_fee',
      p_broker_id,
      p_request_id,
      fee_amount,
      capped_cut,
      'pending',
      NOW(),
      NOW() + INTERVAL '7 days'
    )
    RETURNING id INTO new_id;

    RETURN new_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to mark pending earnings as payable (run daily by cron)
CREATE OR REPLACE FUNCTION mark_earnings_payable()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE earnings_ledger
  SET status = 'payable'
  WHERE status = 'pending'
  AND becomes_payable_at <= NOW();

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE earnings_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker_recruiters ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;

-- Truckers can view their own earnings
CREATE POLICY "Truckers can view own earnings" ON earnings_ledger
FOR SELECT USING (
  trucker_id IN (
    SELECT id FROM truckers WHERE user_id = auth.uid()
  )
);

-- Truckers can view their recruiter relationships
CREATE POLICY "Truckers can view own recruiter relationships" ON trucker_recruiters
FOR SELECT USING (
  recruiter_id IN (SELECT id FROM truckers WHERE user_id = auth.uid())
  OR recruited_id IN (SELECT id FROM truckers WHERE user_id = auth.uid())
);

-- Truckers can view their own payouts
CREATE POLICY "Truckers can view own payouts" ON payouts
FOR SELECT USING (
  trucker_id IN (
    SELECT id FROM truckers WHERE user_id = auth.uid()
  )
);

-- ============================================
-- DONE!
-- ============================================
-- After running this:
-- 1. Brokers have a tier column (free/pro)
-- 2. Truckers have referral codes
-- 3. Earnings are tracked in earnings_ledger
-- 4. Recruiter relationships are tracked
-- 5. Payouts are tracked separately from early pay
-- 6. Helper functions calculate rates and caps
