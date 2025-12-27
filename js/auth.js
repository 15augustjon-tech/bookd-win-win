// Bookd V2 - SMS Authentication
// No passwords. Phone number is identity.

// ============================================
// SMS AUTH FUNCTIONS
// ============================================

// Send OTP to phone number
async function sendOTP(phone) {
  // Normalize phone to E.164 format
  const normalizedPhone = normalizePhone(phone);

  const { data, error } = await supabase.auth.signInWithOtp({
    phone: normalizedPhone
  });

  if (error) {
    console.error('OTP send error:', error.message);
    return { success: false, error: error.message };
  }

  return { success: true };
}

// Verify OTP and sign in (creates user if new)
async function verifyOTP(phone, code, userType = 'trucker', metadata = {}) {
  const normalizedPhone = normalizePhone(phone);

  const { data, error } = await supabase.auth.verifyOtp({
    phone: normalizedPhone,
    token: code,
    type: 'sms'
  });

  if (error) {
    console.error('OTP verify error:', error.message);
    return { success: false, error: error.message };
  }

  // Check if this is a new user (no profile yet)
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', data.user.id)
    .single();

  if (!profile) {
    // New user - update their metadata
    const { error: updateError } = await supabase.auth.updateUser({
      data: {
        user_type: userType,
        full_name: metadata.fullName || '',
        company_name: metadata.companyName || ''
      }
    });

    if (updateError) {
      console.error('Metadata update error:', updateError.message);
    }

    return {
      success: true,
      user: data.user,
      isNewUser: true
    };
  }

  return {
    success: true,
    user: data.user,
    isNewUser: false
  };
}

// ============================================
// PHONE UTILITIES
// ============================================

// Normalize phone to E.164 format (+1XXXXXXXXXX)
function normalizePhone(phone) {
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '');

  // Handle US numbers
  if (digits.length === 10) {
    digits = '1' + digits;
  }

  // Add + prefix
  if (!digits.startsWith('+')) {
    digits = '+' + digits;
  }

  return digits;
}

// Format phone for display
function formatPhoneDisplay(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

// ============================================
// SESSION FUNCTIONS
// ============================================

// Sign out
async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error('Logout error:', error.message);
    return { success: false, error: error.message };
  }
  return { success: true };
}

// Get current user
async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Get current session
async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// ============================================
// PROFILE FUNCTIONS
// ============================================

// Get user profile with trucker/broker data
async function getUserProfile() {
  const user = await getCurrentUser();
  if (!user) return null;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (error || !profile) return null;

  // Get trucker or broker record
  if (profile.user_type === 'trucker') {
    const { data: trucker } = await supabase
      .from('truckers')
      .select('*')
      .eq('user_id', user.id)
      .single();
    return { ...profile, trucker };
  } else {
    const { data: broker } = await supabase
      .from('brokers')
      .select('*')
      .eq('user_id', user.id)
      .single();
    return { ...profile, broker };
  }
}

// Update profile
async function updateProfile(updates) {
  const user = await getCurrentUser();
  if (!user) return { success: false, error: 'Not authenticated' };

  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id);

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
}

// ============================================
// ONBOARDING FUNCTIONS
// ============================================

// Check if user has completed onboarding
async function isOnboardingComplete() {
  const profile = await getUserProfile();
  if (!profile) return false;

  if (profile.user_type === 'trucker') {
    return profile.trucker?.onboarding_completed || false;
  } else {
    return profile.broker?.onboarding_completed || false;
  }
}

// Mark onboarding as complete
async function completeOnboarding() {
  const profile = await getUserProfile();
  if (!profile) return { success: false, error: 'Not authenticated' };

  const table = profile.user_type === 'trucker' ? 'truckers' : 'brokers';
  const recordId = profile.user_type === 'trucker'
    ? profile.trucker?.id
    : profile.broker?.id;

  const { error } = await supabase
    .from(table)
    .update({ onboarding_completed: true })
    .eq('id', recordId);

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
}

// ============================================
// BANK LINKING FUNCTIONS
// ============================================

// Save bank link info (called after Plaid/Moov flow)
async function saveBankLink(bankData) {
  const profile = await getUserProfile();
  if (!profile) return { success: false, error: 'Not authenticated' };

  const table = profile.user_type === 'trucker' ? 'truckers' : 'brokers';
  const recordId = profile.user_type === 'trucker'
    ? profile.trucker?.id
    : profile.broker?.id;

  const { error } = await supabase
    .from(table)
    .update({
      bank_linked: true,
      bank_name: bankData.bankName,
      bank_last_four: bankData.lastFour,
      moov_account_id: bankData.moovAccountId,
      moov_payment_method_id: bankData.moovPaymentMethodId
    })
    .eq('id', recordId);

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
}

// ============================================
// NAVIGATION FUNCTIONS
// ============================================

// Redirect based on user type
function redirectToDashboard(userType) {
  if (userType === 'broker') {
    window.location.href = '/broker/dashboard.html';
  } else {
    window.location.href = '/trucker/dashboard.html';
  }
}

// Check if user is authenticated, redirect to login if not
async function requireAuth(expectedUserType = null) {
  const session = await getSession();

  if (!session) {
    window.location.href = '/login.html';
    return null;
  }

  const profile = await getUserProfile();

  if (!profile) {
    window.location.href = '/login.html';
    return null;
  }

  // Check user type if specified
  if (expectedUserType && profile.user_type !== expectedUserType) {
    redirectToDashboard(profile.user_type);
    return null;
  }

  return profile;
}

// Redirect authenticated users away from auth pages
async function redirectIfAuthenticated() {
  const session = await getSession();

  if (session) {
    const profile = await getUserProfile();
    if (profile) {
      // Check if onboarding is complete
      const onboarded = await isOnboardingComplete();
      if (!onboarded) {
        // Redirect to onboarding
        if (profile.user_type === 'trucker') {
          window.location.href = '/onboarding/trucker.html';
        } else {
          window.location.href = '/onboarding/broker.html';
        }
        return true;
      }
      redirectToDashboard(profile.user_type);
      return true;
    }
  }
  return false;
}

// Handle logout click
async function handleLogout(e) {
  if (e) e.preventDefault();
  await signOut();
  window.location.href = '/login.html';
}
