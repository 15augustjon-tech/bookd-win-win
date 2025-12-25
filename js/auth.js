// Authentication Functions for Bookd
// Requires supabase.js to be loaded first

// Sign up a new user
async function signUp(email, password, userType, metadata = {}) {
  const { data, error } = await supabase.auth.signUp({
    email: email,
    password: password,
    options: {
      data: {
        user_type: userType,
        full_name: metadata.fullName || '',
        phone: metadata.phone || '',
        mc_number: metadata.mcNumber || '',
        dot_number: metadata.dotNumber || '',
        company_name: metadata.companyName || ''
      }
    }
  });

  if (error) {
    console.error('Signup error:', error.message);
    return { success: false, error: error.message };
  }

  return { success: true, user: data.user };
}

// Sign in existing user
async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email,
    password: password
  });

  if (error) {
    console.error('Login error:', error.message);
    return { success: false, error: error.message };
  }

  return { success: true, user: data.user, session: data.session };
}

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
