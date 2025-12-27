-- Bookd V2 Migration: Moov Payments + SMS Auth
-- Run this in Supabase SQL Editor after previous migrations

-- ============================================
-- 1. MAKE EMAIL OPTIONAL (PHONE-FIRST AUTH)
-- ============================================

-- Email is no longer required - phone is primary
ALTER TABLE profiles
ALTER COLUMN email DROP NOT NULL;

-- Add phone as primary identifier
ALTER TABLE profiles
ALTER COLUMN phone SET NOT NULL;

-- ============================================
-- 2. ADD MOOV/PLAID BANK LINKING TO TRUCKERS
-- ============================================

-- Moov account ID (created when they link bank)
ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS moov_account_id TEXT;

-- Bank account details from Plaid/Moov
ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS bank_linked BOOLEAN DEFAULT FALSE;

ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS bank_name TEXT;

ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS bank_last_four TEXT;

ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS moov_payment_method_id TEXT;

-- Onboarding status
ALTER TABLE truckers
ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

-- ============================================
-- 3. ADD MOOV/PLAID BANK LINKING TO BROKERS
-- ============================================

-- Moov account ID for brokers (to fund payments)
ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS moov_account_id TEXT;

-- Bank account details
ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS bank_linked BOOLEAN DEFAULT FALSE;

ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS bank_name TEXT;

ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS bank_last_four TEXT;

ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS moov_payment_method_id TEXT;

-- Onboarding status
ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

-- ============================================
-- 4. CREATE V2 PAYMENT REQUESTS TABLE
-- ============================================
-- Simpler than early_pay_requests - no invoice dependency
-- Trucker submits request, broker approves, money moves

CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who is involved
  trucker_id UUID REFERENCES truckers(id) ON DELETE CASCADE NOT NULL,
  broker_id UUID REFERENCES brokers(id) ON DELETE CASCADE NOT NULL,

  -- Load details (trucker provides)
  load_reference TEXT NOT NULL,
  total_owed DECIMAL(10,2) NOT NULL,
  amount_requested DECIMAL(10,2) NOT NULL,

  -- Optional BOL attachment
  bol_url TEXT,

  -- Speed preference
  speed TEXT DEFAULT 'standard' CHECK (speed IN ('standard', 'instant')),

  -- Fee calculation (stored at time of request)
  platform_fee DECIMAL(10,2) DEFAULT 0,

  -- Status tracking
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending',   -- Waiting for broker approval
    'approved',  -- Broker approved, processing payment
    'completed', -- Money sent
    'rejected',  -- Broker rejected
    'expired'    -- Auto-expired after 7 days
  )),

  -- Moov transfer tracking
  moov_transfer_id TEXT,
  moov_status TEXT,

  -- Timestamps
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  approved_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  rejected_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days'),

  -- Rejection reason (optional)
  rejection_reason TEXT
);

-- ============================================
-- 5. ADD BROKER SEARCHABILITY
-- ============================================

-- Brokers can set a public search code for truckers to find them
ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS search_code TEXT UNIQUE;

-- Auto-generate search codes for existing brokers
UPDATE brokers
SET search_code = UPPER(SUBSTRING(company_name FROM 1 FOR 3)) || SUBSTRING(MD5(id::TEXT) FROM 1 FOR 4)
WHERE search_code IS NULL;

-- Brokers can be searchable or invite-only
ALTER TABLE brokers
ADD COLUMN IF NOT EXISTS is_searchable BOOLEAN DEFAULT TRUE;

-- ============================================
-- 6. UPDATE RELATIONSHIPS FOR CONNECTION FLOW
-- ============================================

-- Add who initiated the connection
ALTER TABLE trucker_broker_relationships
ADD COLUMN IF NOT EXISTS initiated_by TEXT DEFAULT 'trucker' CHECK (initiated_by IN ('trucker', 'broker'));

-- Add rejection reason
ALTER TABLE trucker_broker_relationships
ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Update status options
ALTER TABLE trucker_broker_relationships
DROP CONSTRAINT IF EXISTS trucker_broker_relationships_status_check;

ALTER TABLE trucker_broker_relationships
ADD CONSTRAINT trucker_broker_relationships_status_check
CHECK (status IN ('pending', 'active', 'rejected', 'blocked'));

-- ============================================
-- 7. CREATE INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX IF NOT EXISTS idx_payment_requests_trucker
ON payment_requests(trucker_id);

CREATE INDEX IF NOT EXISTS idx_payment_requests_broker
ON payment_requests(broker_id);

CREATE INDEX IF NOT EXISTS idx_payment_requests_status
ON payment_requests(status);

CREATE INDEX IF NOT EXISTS idx_payment_requests_pending
ON payment_requests(broker_id, status)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_brokers_search_code
ON brokers(search_code);

CREATE INDEX IF NOT EXISTS idx_profiles_phone
ON profiles(phone);

-- ============================================
-- 8. ROW LEVEL SECURITY FOR PAYMENT REQUESTS
-- ============================================

ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;

-- Both parties can view their requests
CREATE POLICY "View payment requests" ON payment_requests
FOR SELECT USING (
  EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
);

-- Truckers can create requests (only to connected brokers)
CREATE POLICY "Truckers can create payment requests" ON payment_requests
FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
  AND EXISTS (
    SELECT 1 FROM trucker_broker_relationships
    WHERE trucker_id = payment_requests.trucker_id
    AND broker_id = payment_requests.broker_id
    AND status = 'active'
  )
);

-- Brokers can update requests (approve/reject)
CREATE POLICY "Brokers can update payment requests" ON payment_requests
FOR UPDATE USING (
  EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
);

-- ============================================
-- 9. UPDATE HANDLE_NEW_USER FOR PHONE AUTH
-- ============================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, user_type)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,  -- Can be NULL now
    COALESCE(NEW.phone, NEW.raw_user_meta_data->>'phone'),
    COALESCE(NEW.raw_user_meta_data->>'user_type', 'trucker')
  );

  -- Create trucker or broker record based on user_type
  IF NEW.raw_user_meta_data->>'user_type' = 'broker' THEN
    INSERT INTO public.brokers (user_id, company_name, search_code)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'company_name', 'My Company'),
      UPPER(SUBSTRING(COALESCE(NEW.raw_user_meta_data->>'company_name', 'BRK') FROM 1 FOR 3))
        || SUBSTRING(MD5(NEW.id::TEXT) FROM 1 FOR 4)
    );
  ELSE
    INSERT INTO public.truckers (user_id)
    VALUES (NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 10. HELPER FUNCTIONS
-- ============================================

-- Find broker by search code
CREATE OR REPLACE FUNCTION find_broker_by_code(p_search_code TEXT)
RETURNS TABLE (
  id UUID,
  company_name TEXT,
  search_code TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT b.id, b.company_name, b.search_code
  FROM brokers b
  WHERE UPPER(b.search_code) = UPPER(p_search_code)
  AND b.is_searchable = TRUE;
END;
$$ LANGUAGE plpgsql;

-- Get pending payment requests for a broker
CREATE OR REPLACE FUNCTION get_pending_requests(p_broker_id UUID)
RETURNS TABLE (
  request_id UUID,
  trucker_name TEXT,
  load_reference TEXT,
  total_owed DECIMAL,
  amount_requested DECIMAL,
  speed TEXT,
  requested_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pr.id,
    p.full_name,
    pr.load_reference,
    pr.total_owed,
    pr.amount_requested,
    pr.speed,
    pr.requested_at
  FROM payment_requests pr
  JOIN truckers t ON t.id = pr.trucker_id
  JOIN profiles p ON p.id = t.user_id
  WHERE pr.broker_id = p_broker_id
  AND pr.status = 'pending'
  ORDER BY pr.requested_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Approve a payment request (broker action)
CREATE OR REPLACE FUNCTION approve_payment_request(p_request_id UUID, p_broker_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_broker_id UUID;
BEGIN
  -- Get broker ID
  SELECT id INTO v_broker_id FROM brokers WHERE user_id = p_broker_user_id;

  IF v_broker_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Update the request
  UPDATE payment_requests
  SET
    status = 'approved',
    approved_at = NOW()
  WHERE id = p_request_id
  AND broker_id = v_broker_id
  AND status = 'pending';

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Reject a payment request
CREATE OR REPLACE FUNCTION reject_payment_request(
  p_request_id UUID,
  p_broker_user_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_broker_id UUID;
BEGIN
  -- Get broker ID
  SELECT id INTO v_broker_id FROM brokers WHERE user_id = p_broker_user_id;

  IF v_broker_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Update the request
  UPDATE payment_requests
  SET
    status = 'rejected',
    rejected_at = NOW(),
    rejection_reason = p_reason
  WHERE id = p_request_id
  AND broker_id = v_broker_id
  AND status = 'pending';

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Auto-expire old pending requests (run daily via cron)
CREATE OR REPLACE FUNCTION expire_old_requests()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE payment_requests
  SET status = 'expired'
  WHERE status = 'pending'
  AND expires_at <= NOW();

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 11. BROKER PUBLIC SEARCH POLICY
-- ============================================

-- Allow anyone to search for searchable brokers
CREATE POLICY "Anyone can search public brokers" ON brokers
FOR SELECT USING (
  is_searchable = TRUE
  OR user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM trucker_broker_relationships tbr
    JOIN truckers t ON t.id = tbr.trucker_id
    WHERE tbr.broker_id = brokers.id AND t.user_id = auth.uid()
  )
);

-- ============================================
-- DONE!
-- ============================================
-- V2 Changes:
-- 1. Phone is now primary auth (email optional)
-- 2. Truckers + Brokers have Moov account fields
-- 3. Bank linking tracked with bank_linked, bank_name, bank_last_four
-- 4. New payment_requests table (simpler than early_pay_requests)
-- 5. Brokers have search_code for truckers to find them
-- 6. Connection flow updated with initiated_by field
-- 7. Helper functions for common operations
