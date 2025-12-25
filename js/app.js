// App Logic for Bookd
// Requires supabase.js and auth.js to be loaded first

// Fee calculation
function calculateEarlyPay(amount, creditRemaining) {
  const BROKER_FEE = 0.03;  // 3%
  const PLATFORM_FEE = 0.01; // 1%

  const brokerFee = amount * BROKER_FEE;
  let platformFee = amount * PLATFORM_FEE;

  // Apply credit to platform fee only
  const creditApplied = Math.min(platformFee, creditRemaining);
  platformFee = platformFee - creditApplied;

  const totalFee = brokerFee + platformFee;
  const amountToTrucker = amount - totalFee;

  return {
    amount,
    brokerFee: Math.round(brokerFee * 100) / 100,
    platformFee: Math.round(platformFee * 100) / 100,
    creditApplied: Math.round(creditApplied * 100) / 100,
    totalFee: Math.round(totalFee * 100) / 100,
    amountToTrucker: Math.round(amountToTrucker * 100) / 100,
    creditRemaining: Math.round((creditRemaining - creditApplied) * 100) / 100
  };
}

// Format currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
}

// Format date
function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

// Generate invite code
function generateInviteCode() {
  return 'BKD' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ============================================
// TRUCKER FUNCTIONS
// ============================================

// Get trucker's connected brokers
async function getTruckerBrokers(truckerId) {
  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .select(`
      *,
      broker:brokers(*, profile:profiles(*))
    `)
    .eq('trucker_id', truckerId)
    .eq('status', 'active');

  if (error) {
    console.error('Error fetching brokers:', error);
    return [];
  }
  return data || [];
}

// Get invoices for a trucker
async function getTruckerInvoices(truckerId) {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      *,
      broker:brokers(*, profile:profiles(*))
    `)
    .eq('trucker_id', truckerId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching invoices:', error);
    return [];
  }
  return data || [];
}

// Get early pay requests for a trucker
async function getTruckerRequests(truckerId) {
  const { data, error } = await supabase
    .from('early_pay_requests')
    .select(`
      *,
      broker:brokers(*, profile:profiles(*))
    `)
    .eq('trucker_id', truckerId)
    .order('requested_at', { ascending: false });

  if (error) {
    console.error('Error fetching requests:', error);
    return [];
  }
  return data || [];
}

// Create early pay request
async function createEarlyPayRequest(truckerId, brokerId, invoiceId, amount, creditRemaining) {
  const fees = calculateEarlyPay(amount, creditRemaining);

  const { data, error } = await supabase
    .from('early_pay_requests')
    .insert({
      trucker_id: truckerId,
      broker_id: brokerId,
      invoice_id: invoiceId,
      amount_requested: amount,
      broker_fee: fees.brokerFee,
      platform_fee: fees.platformFee,
      credit_applied: fees.creditApplied,
      amount_to_trucker: fees.amountToTrucker
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating request:', error);
    return { success: false, error: error.message };
  }

  // Update trucker credit if applied
  if (fees.creditApplied > 0) {
    await supabase
      .from('truckers')
      .update({
        bonus_credit_remaining: creditRemaining - fees.creditApplied,
        bonus_credit_used: supabase.raw(`bonus_credit_used + ${fees.creditApplied}`)
      })
      .eq('id', truckerId);
  }

  return { success: true, request: data };
}

// Send broker invite
async function sendBrokerInvite(truckerId, brokerEmail, brokerName) {
  const inviteCode = generateInviteCode();

  const { data, error } = await supabase
    .from('invites')
    .insert({
      trucker_id: truckerId,
      broker_email: brokerEmail,
      broker_name: brokerName,
      invite_code: inviteCode
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating invite:', error);
    return { success: false, error: error.message };
  }

  return { success: true, invite: data, inviteCode };
}

// ============================================
// BROKER FUNCTIONS
// ============================================

// Get broker's truckers
async function getBrokerTruckers(brokerId) {
  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .select(`
      *,
      trucker:truckers(*, profile:profiles(*))
    `)
    .eq('broker_id', brokerId)
    .eq('status', 'active');

  if (error) {
    console.error('Error fetching truckers:', error);
    return [];
  }
  return data || [];
}

// Get invoices created by broker
async function getBrokerInvoices(brokerId) {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      *,
      trucker:truckers(*, profile:profiles(*))
    `)
    .eq('broker_id', brokerId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching invoices:', error);
    return [];
  }
  return data || [];
}

// Get early pay requests for broker
async function getBrokerRequests(brokerId) {
  const { data, error } = await supabase
    .from('early_pay_requests')
    .select(`
      *,
      trucker:truckers(*, profile:profiles(*))
    `)
    .eq('broker_id', brokerId)
    .order('requested_at', { ascending: false });

  if (error) {
    console.error('Error fetching requests:', error);
    return [];
  }
  return data || [];
}

// Create invoice (add amount owed to trucker)
async function createInvoice(brokerId, truckerId, loadReference, amount, dueDate) {
  const { data, error } = await supabase
    .from('invoices')
    .insert({
      broker_id: brokerId,
      trucker_id: truckerId,
      load_reference: loadReference,
      original_amount: amount,
      amount_remaining: amount,
      due_date: dueDate
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating invoice:', error);
    return { success: false, error: error.message };
  }

  return { success: true, invoice: data };
}

// Approve early pay request
async function approveRequest(requestId) {
  const { data, error } = await supabase
    .from('early_pay_requests')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString()
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) {
    console.error('Error approving request:', error);
    return { success: false, error: error.message };
  }

  return { success: true, request: data };
}

// Reject early pay request
async function rejectRequest(requestId) {
  const { data, error } = await supabase
    .from('early_pay_requests')
    .update({
      status: 'rejected'
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) {
    console.error('Error rejecting request:', error);
    return { success: false, error: error.message };
  }

  return { success: true, request: data };
}

// Mark request as funded
async function markAsFunded(requestId, brokerId) {
  const { data: request, error: fetchError } = await supabase
    .from('early_pay_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (fetchError) {
    return { success: false, error: fetchError.message };
  }

  // Update request status
  const { error: updateError } = await supabase
    .from('early_pay_requests')
    .update({
      status: 'funded',
      funded_at: new Date().toISOString()
    })
    .eq('id', requestId);

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  // Update broker earnings
  await supabase
    .from('brokers')
    .update({
      total_earned: supabase.raw(`total_earned + ${request.broker_fee}`)
    })
    .eq('id', brokerId);

  return { success: true };
}

// ============================================
// UI HELPERS
// ============================================

// Show loading state on button
function setButtonLoading(button, isLoading) {
  if (isLoading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Loading...';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

// Show error message
function showError(message, containerId = 'error-message') {
  const container = document.getElementById(containerId);
  if (container) {
    container.textContent = message;
    container.style.display = 'block';
  } else {
    alert(message);
  }
}

// Hide error message
function hideError(containerId = 'error-message') {
  const container = document.getElementById(containerId);
  if (container) {
    container.style.display = 'none';
  }
}

// Show success message
function showSuccess(message, containerId = 'success-message') {
  const container = document.getElementById(containerId);
  if (container) {
    container.textContent = message;
    container.style.display = 'block';
  }
}
