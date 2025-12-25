-- Bookd Database Schema
-- Run this in Supabase SQL Editor to set up the database

-- ============================================
-- DROP OLD TABLES (from previous project)
-- ============================================
DROP TABLE IF EXISTS payouts CASCADE;
DROP TABLE IF EXISTS deliveries CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS sellers CASCADE;

-- ============================================
-- CREATE BOOKD TABLES
-- ============================================

-- 1. Profiles (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  user_type TEXT NOT NULL CHECK (user_type IN ('trucker', 'broker')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Truckers
CREATE TABLE IF NOT EXISTS truckers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  mc_number TEXT,
  dot_number TEXT,
  bonus_credit_remaining DECIMAL(10,2) DEFAULT 100.00,
  bonus_credit_used DECIMAL(10,2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Brokers
CREATE TABLE IF NOT EXISTS brokers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  mc_number TEXT,
  total_earned DECIMAL(10,2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Trucker-Broker Relationships
CREATE TABLE IF NOT EXISTS trucker_broker_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trucker_id UUID REFERENCES truckers(id) ON DELETE CASCADE,
  broker_id UUID REFERENCES brokers(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive')),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  connected_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(trucker_id, broker_id)
);

-- 5. Invoices (loads/amounts owed)
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trucker_id UUID REFERENCES truckers(id) ON DELETE CASCADE,
  broker_id UUID REFERENCES brokers(id) ON DELETE CASCADE,
  load_reference TEXT,
  original_amount DECIMAL(10,2) NOT NULL,
  amount_remaining DECIMAL(10,2) NOT NULL,
  due_date DATE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paid')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Early Pay Requests
CREATE TABLE IF NOT EXISTS early_pay_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trucker_id UUID REFERENCES truckers(id) ON DELETE CASCADE,
  broker_id UUID REFERENCES brokers(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_requested DECIMAL(10,2) NOT NULL,
  broker_fee DECIMAL(10,2) NOT NULL,
  platform_fee DECIMAL(10,2) NOT NULL,
  credit_applied DECIMAL(10,2) DEFAULT 0.00,
  amount_to_trucker DECIMAL(10,2) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'funded', 'completed', 'rejected')),
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  approved_at TIMESTAMP WITH TIME ZONE,
  funded_at TIMESTAMP WITH TIME ZONE
);

-- 7. Broker Invites
CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trucker_id UUID REFERENCES truckers(id) ON DELETE CASCADE,
  broker_email TEXT NOT NULL,
  broker_name TEXT,
  invite_code TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired')),
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE truckers ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker_broker_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE early_pay_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can read/update their own profile
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Truckers: Truckers can manage their own record
CREATE POLICY "Truckers can view own record" ON truckers
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Truckers can update own record" ON truckers
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can create trucker record" ON truckers
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Brokers: Brokers can manage their own record, truckers can view connected brokers
CREATE POLICY "Brokers can view own record" ON brokers
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Truckers can view connected brokers" ON brokers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trucker_broker_relationships tbr
      JOIN truckers t ON t.id = tbr.trucker_id
      WHERE tbr.broker_id = brokers.id AND t.user_id = auth.uid()
    )
  );

CREATE POLICY "Brokers can update own record" ON brokers
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can create broker record" ON brokers
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Relationships: Both parties can view
CREATE POLICY "View relationships" ON trucker_broker_relationships
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
  );

CREATE POLICY "Truckers can create relationships" ON trucker_broker_relationships
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
  );

CREATE POLICY "Either party can update relationships" ON trucker_broker_relationships
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
  );

-- Invoices: Brokers create, both view
CREATE POLICY "View invoices" ON invoices
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
  );

CREATE POLICY "Brokers can create invoices" ON invoices
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
  );

CREATE POLICY "Brokers can update invoices" ON invoices
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
  );

-- Early Pay Requests: Both parties can view, truckers create, brokers approve
CREATE POLICY "View early pay requests" ON early_pay_requests
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
  );

CREATE POLICY "Truckers can create requests" ON early_pay_requests
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
  );

CREATE POLICY "Brokers can update requests" ON early_pay_requests
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM brokers WHERE id = broker_id AND user_id = auth.uid())
  );

-- Invites: Truckers create, anyone can view by code
CREATE POLICY "Truckers can view own invites" ON invites
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
  );

CREATE POLICY "Truckers can create invites" ON invites
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM truckers WHERE id = trucker_id AND user_id = auth.uid())
  );

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, user_type)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    NEW.raw_user_meta_data->>'phone',
    COALESCE(NEW.raw_user_meta_data->>'user_type', 'trucker')
  );

  -- Create trucker or broker record based on user_type
  IF NEW.raw_user_meta_data->>'user_type' = 'broker' THEN
    INSERT INTO public.brokers (user_id, company_name, mc_number)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'company_name', ''),
      NEW.raw_user_meta_data->>'mc_number'
    );
  ELSE
    INSERT INTO public.truckers (user_id, mc_number, dot_number)
    VALUES (
      NEW.id,
      NEW.raw_user_meta_data->>'mc_number',
      NEW.raw_user_meta_data->>'dot_number'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to auto-create profile on signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================
-- DONE!
-- ============================================
