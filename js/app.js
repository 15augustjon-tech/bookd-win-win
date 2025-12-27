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

// ============================================
// EARNINGS & REFERRAL FUNCTIONS
// ============================================

// Get trucker's earnings
async function getTruckerEarnings(truckerId) {
  const { data, error } = await supabase
    .from('earnings_ledger')
    .select(`
      *,
      broker:brokers(*, profile:profiles(*))
    `)
    .eq('trucker_id', truckerId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching earnings:', error);
    return [];
  }
  return data || [];
}

// Get trucker's Pro broker count
async function getTruckerProBrokerCount(truckerId) {
  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .select(`
      broker:brokers(id, tier)
    `)
    .eq('trucker_id', truckerId)
    .eq('status', 'active');

  if (error) {
    console.error('Error fetching Pro broker count:', error);
    return 0;
  }

  // Count brokers with tier = 'pro'
  const proBrokers = (data || []).filter(r => r.broker?.tier === 'pro');
  return proBrokers.length;
}

// Get trucker's payouts
async function getTruckerPayouts(truckerId) {
  const { data, error } = await supabase
    .from('payouts')
    .select('*')
    .eq('trucker_id', truckerId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching payouts:', error);
    return [];
  }
  return data || [];
}

// Calculate earning rate based on Pro broker count
function calculateEarningRate(proBrokerCount) {
  return proBrokerCount >= 10 ? 0.70 : 0.40;
}

// Calculate trucker earning for a Free broker transaction
function calculateFreeBrokerEarning(transactionAmount, monthlyEarnedFromBroker = 0) {
  const BROKER_FEE_RATE = 0.05; // 5% of early pay
  const TRUCKER_SHARE = 0.10;   // 10% of the 5%
  const MONTHLY_CAP = 100;      // $100/month per broker

  const brokerFee = transactionAmount * BROKER_FEE_RATE;
  let truckerCut = brokerFee * TRUCKER_SHARE;

  // Apply monthly cap
  if (monthlyEarnedFromBroker + truckerCut > MONTHLY_CAP) {
    truckerCut = Math.max(0, MONTHLY_CAP - monthlyEarnedFromBroker);
  }

  return {
    grossFee: Math.round(brokerFee * 100) / 100,
    truckerShare: Math.round(truckerCut * 100) / 100,
    capped: monthlyEarnedFromBroker + truckerCut >= MONTHLY_CAP
  };
}

// Get monthly earnings from a specific broker (for cap calculation)
async function getMonthlyEarningsFromBroker(truckerId, brokerId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('earnings_ledger')
    .select('trucker_share')
    .eq('trucker_id', truckerId)
    .eq('source_broker_id', brokerId)
    .eq('source_type', 'broker_free_fee')
    .gte('created_at', startOfMonth.toISOString())
    .neq('status', 'clawed_back');

  if (error) {
    console.error('Error fetching monthly earnings:', error);
    return 0;
  }

  return (data || []).reduce((sum, e) => sum + parseFloat(e.trucker_share || 0), 0);
}

// Log a Free broker earning (called when early pay is funded)
async function logFreeBrokerEarning(truckerId, brokerId, requestId, transactionAmount) {
  // Get monthly earnings from this broker for cap calculation
  const monthlyEarned = await getMonthlyEarningsFromBroker(truckerId, brokerId);
  const earning = calculateFreeBrokerEarning(transactionAmount, monthlyEarned);

  // Only log if there's something to earn
  if (earning.truckerShare <= 0) {
    return { success: true, capped: true, amount: 0 };
  }

  // Calculate when this becomes payable (7 days from now)
  const becomesPayableAt = new Date();
  becomesPayableAt.setDate(becomesPayableAt.getDate() + 7);

  const { data, error } = await supabase
    .from('earnings_ledger')
    .insert({
      trucker_id: truckerId,
      source_type: 'broker_free_fee',
      source_broker_id: brokerId,
      source_request_id: requestId,
      gross_amount: earning.grossFee,
      trucker_share: earning.truckerShare,
      status: 'pending',
      collected_at: new Date().toISOString(),
      becomes_payable_at: becomesPayableAt.toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('Error logging earning:', error);
    return { success: false, error: error.message };
  }

  // Also log recruiter bonus if this trucker has a recruiter
  await logRecruiterBonus(truckerId, earning.truckerShare);

  return { success: true, earning: data, amount: earning.truckerShare };
}

// Log recruiter bonus (10% of trucker's earnings)
async function logRecruiterBonus(truckerIdWhoEarned, truckerEarningAmount) {
  // Find if this trucker has a recruiter
  const { data: recruiterRel } = await supabase
    .from('trucker_recruiters')
    .select('recruiter_id')
    .eq('recruited_id', truckerIdWhoEarned)
    .single();

  if (!recruiterRel) {
    return; // No recruiter, nothing to do
  }

  const RECRUITER_BONUS_RATE = 0.10; // 10% of recruited trucker's earnings
  const recruiterBonus = truckerEarningAmount * RECRUITER_BONUS_RATE;

  if (recruiterBonus <= 0) {
    return;
  }

  const becomesPayableAt = new Date();
  becomesPayableAt.setDate(becomesPayableAt.getDate() + 7);

  await supabase
    .from('earnings_ledger')
    .insert({
      trucker_id: recruiterRel.recruiter_id,
      source_type: 'recruiter_bonus',
      source_trucker_id: truckerIdWhoEarned,
      gross_amount: truckerEarningAmount,
      trucker_share: Math.round(recruiterBonus * 100) / 100,
      status: 'pending',
      collected_at: new Date().toISOString(),
      becomes_payable_at: becomesPayableAt.toISOString()
    });
}

// Get trucker's total pending + payable earnings
async function getTruckerPayableBalance(truckerId) {
  const { data, error } = await supabase
    .from('earnings_ledger')
    .select('trucker_share, status')
    .eq('trucker_id', truckerId)
    .in('status', ['pending', 'payable']);

  if (error) {
    console.error('Error fetching payable balance:', error);
    return { pending: 0, payable: 0, total: 0 };
  }

  const pending = (data || [])
    .filter(e => e.status === 'pending')
    .reduce((sum, e) => sum + parseFloat(e.trucker_share || 0), 0);

  const payable = (data || [])
    .filter(e => e.status === 'payable')
    .reduce((sum, e) => sum + parseFloat(e.trucker_share || 0), 0);

  return {
    pending: Math.round(pending * 100) / 100,
    payable: Math.round(payable * 100) / 100,
    total: Math.round((pending + payable) * 100) / 100
  };
}

// ============================================
// V2: CONNECTION SYSTEM
// ============================================

// Search for a broker by search code
async function searchBrokerByCode(searchCode) {
  const { data, error } = await supabase
    .from('brokers')
    .select('id, company_name, search_code')
    .ilike('search_code', searchCode)
    .eq('is_searchable', true)
    .limit(1)
    .single();

  if (error) {
    console.error('Broker not found:', error);
    return null;
  }
  return data;
}

// Request connection to a broker
async function requestBrokerConnection(truckerId, brokerId) {
  // Check if connection already exists
  const { data: existing } = await supabase
    .from('trucker_broker_relationships')
    .select('id, status')
    .eq('trucker_id', truckerId)
    .eq('broker_id', brokerId)
    .single();

  if (existing) {
    if (existing.status === 'active') {
      return { success: false, error: 'Already connected to this broker' };
    }
    if (existing.status === 'pending') {
      return { success: false, error: 'Connection request already pending' };
    }
    if (existing.status === 'rejected' || existing.status === 'blocked') {
      return { success: false, error: 'Cannot connect to this broker' };
    }
  }

  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .insert({
      trucker_id: truckerId,
      broker_id: brokerId,
      status: 'pending',
      initiated_by: 'trucker'
    })
    .select()
    .single();

  if (error) {
    console.error('Error requesting connection:', error);
    return { success: false, error: error.message };
  }

  return { success: true, relationship: data };
}

// Get pending connection requests for a broker
async function getBrokerPendingConnections(brokerId) {
  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .select(`
      *,
      trucker:truckers(*, profiles:profiles(*))
    `)
    .eq('broker_id', brokerId)
    .in('status', ['pending', 'active'])
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching connections:', error);
    return [];
  }
  return data || [];
}

// Get trucker's connections (for trucker dashboard)
async function getTruckerConnections(truckerId) {
  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .select(`
      *,
      broker:brokers(*)
    `)
    .eq('trucker_id', truckerId)
    .in('status', ['pending', 'active'])
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching trucker connections:', error);
    return [];
  }
  return data || [];
}

// Approve connection request
async function approveConnection(relationshipId, brokerId) {
  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .update({
      status: 'active',
      connected_at: new Date().toISOString()
    })
    .eq('id', relationshipId)
    .eq('broker_id', brokerId)
    .select()
    .single();

  if (error) {
    console.error('Error approving connection:', error);
    return { success: false, error: error.message };
  }

  return { success: true, relationship: data };
}

// Reject connection request
async function rejectConnection(relationshipId, brokerId, reason = null) {
  const { data, error } = await supabase
    .from('trucker_broker_relationships')
    .update({
      status: 'rejected',
      rejection_reason: reason
    })
    .eq('id', relationshipId)
    .eq('broker_id', brokerId)
    .select()
    .single();

  if (error) {
    console.error('Error rejecting connection:', error);
    return { success: false, error: error.message };
  }

  return { success: true, relationship: data };
}

// ============================================
// V2: PAYMENT REQUEST SYSTEM
// ============================================

// Create a v2 payment request
async function createPaymentRequest(truckerId, brokerId, loadReference, totalOwed, amountRequested, speed = 'standard') {
  // Calculate platform fee based on speed
  const platformFee = speed === 'instant' ? 5.00 : 0.00;

  const { data, error } = await supabase
    .from('payment_requests')
    .insert({
      trucker_id: truckerId,
      broker_id: brokerId,
      load_reference: loadReference,
      total_owed: totalOwed,
      amount_requested: amountRequested,
      speed: speed,
      platform_fee: platformFee
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating payment request:', error);
    return { success: false, error: error.message };
  }

  return { success: true, request: data };
}

// Get v2 payment requests for a trucker
async function getTruckerPaymentRequests(truckerId) {
  const { data, error } = await supabase
    .from('payment_requests')
    .select(`
      *,
      broker:brokers(*, profile:profiles(*))
    `)
    .eq('trucker_id', truckerId)
    .order('requested_at', { ascending: false });

  if (error) {
    console.error('Error fetching payment requests:', error);
    return [];
  }
  return data || [];
}

// Get v2 payment requests for a broker
async function getBrokerPaymentRequests(brokerId) {
  const { data, error } = await supabase
    .from('payment_requests')
    .select(`
      *,
      trucker:truckers(*, profile:profiles(*))
    `)
    .eq('broker_id', brokerId)
    .order('requested_at', { ascending: false });

  if (error) {
    console.error('Error fetching payment requests:', error);
    return [];
  }
  return data || [];
}

// Approve v2 payment request
async function approvePaymentRequest(requestId, brokerId) {
  const { data, error } = await supabase
    .from('payment_requests')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString()
    })
    .eq('id', requestId)
    .eq('broker_id', brokerId)
    .eq('status', 'pending')
    .select()
    .single();

  if (error) {
    console.error('Error approving payment request:', error);
    return { success: false, error: error.message };
  }

  return { success: true, request: data };
}

// Reject v2 payment request
async function rejectPaymentRequest(requestId, brokerId, reason = null) {
  const { data, error } = await supabase
    .from('payment_requests')
    .update({
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      rejection_reason: reason
    })
    .eq('id', requestId)
    .eq('broker_id', brokerId)
    .eq('status', 'pending')
    .select()
    .single();

  if (error) {
    console.error('Error rejecting payment request:', error);
    return { success: false, error: error.message };
  }

  return { success: true, request: data };
}

// Mark v2 payment request as completed (money sent)
async function completePaymentRequest(requestId, moovTransferId = null) {
  const { data, error } = await supabase
    .from('payment_requests')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      moov_transfer_id: moovTransferId,
      moov_status: 'completed'
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) {
    console.error('Error completing payment request:', error);
    return { success: false, error: error.message };
  }

  return { success: true, request: data };
}
