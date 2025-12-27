-- PayPal/Venmo Payment Integration Migration
-- Run this in Supabase SQL Editor after schema.sql

-- ============================================
-- ADD PAYMENT COLUMNS TO TRUCKERS
-- ============================================

ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'manual' CHECK (payment_method IN ('manual', 'paypal', 'venmo'));

ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS paypal_email TEXT;

ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS venmo_handle TEXT;

-- ============================================
-- ADD PAYOUT TRACKING TO EARLY_PAY_REQUESTS
-- ============================================

ALTER TABLE early_pay_requests
ADD COLUMN IF NOT EXISTS payout_id TEXT;

ALTER TABLE early_pay_requests
ADD COLUMN IF NOT EXISTS payout_status TEXT CHECK (payout_status IN ('pending', 'success', 'failed', 'unclaimed'));

ALTER TABLE early_pay_requests
ADD COLUMN IF NOT EXISTS payout_method TEXT CHECK (payout_method IN ('manual', 'paypal', 'venmo'));

ALTER TABLE early_pay_requests
ADD COLUMN IF NOT EXISTS payout_error TEXT;

-- ============================================
-- CREATE INDEX FOR FASTER PAYOUT LOOKUPS
-- ============================================

CREATE INDEX IF NOT EXISTS idx_early_pay_requests_payout_id
ON early_pay_requests(payout_id);

-- ============================================
-- CREATE FUNCTION TO INCREMENT BROKER EARNINGS
-- ============================================

CREATE OR REPLACE FUNCTION add_broker_earnings(p_broker_id UUID, p_amount DECIMAL)
RETURNS void AS $$
BEGIN
  UPDATE brokers
  SET total_earned = COALESCE(total_earned, 0) + p_amount
  WHERE id = p_broker_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- DONE!
-- ============================================
-- After running this:
-- 1. Truckers can save their PayPal email or Venmo handle
-- 2. Early pay requests track payout status and ID
-- 3. System can lookup requests by PayPal payout ID (for webhooks)
-- 4. Broker earnings can be incremented via add_broker_earnings function
