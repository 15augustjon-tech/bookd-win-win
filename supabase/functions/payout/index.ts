// PayPal Payouts Edge Function for Bookd
// Sends instant payments to truckers via PayPal or Venmo

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PAYPAL_CLIENT_ID = Deno.env.get('PAYPAL_CLIENT_ID')!
const PAYPAL_SECRET = Deno.env.get('PAYPAL_SECRET')!
const PAYPAL_API = Deno.env.get('PAYPAL_MODE') === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { requestId } = await req.json()

    if (!requestId) {
      return new Response(
        JSON.stringify({ error: 'Missing requestId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Get the early pay request with trucker info
    const { data: request, error: fetchError } = await supabase
      .from('early_pay_requests')
      .select(`
        *,
        trucker:truckers(
          id,
          payment_method,
          paypal_email,
          venmo_handle,
          profile:profiles(full_name)
        )
      `)
      .eq('id', requestId)
      .single()

    if (fetchError || !request) {
      return new Response(
        JSON.stringify({ error: 'Request not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate request status
    if (request.status !== 'approved') {
      return new Response(
        JSON.stringify({ error: 'Request must be approved before payout' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get payment details
    const trucker = request.trucker
    const paymentMethod = trucker.payment_method

    if (paymentMethod === 'manual') {
      return new Response(
        JSON.stringify({ error: 'Trucker has not set up automatic payments' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Determine recipient based on payment method
    let recipientEmail: string
    let recipientType: string

    if (paymentMethod === 'paypal') {
      if (!trucker.paypal_email) {
        return new Response(
          JSON.stringify({ error: 'Trucker has not set up PayPal email' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      recipientEmail = trucker.paypal_email
      recipientType = 'EMAIL'
    } else if (paymentMethod === 'venmo') {
      if (!trucker.venmo_handle) {
        return new Response(
          JSON.stringify({ error: 'Trucker has not set up Venmo handle' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      // Venmo uses phone number or email through PayPal
      recipientEmail = trucker.venmo_handle
      recipientType = 'EMAIL' // Or PHONE if it's a phone number
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid payment method' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get PayPal access token
    const auth = btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`)
    const tokenRes = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    })

    if (!tokenRes.ok) {
      const tokenError = await tokenRes.text()
      console.error('PayPal token error:', tokenError)
      return new Response(
        JSON.stringify({ error: 'Failed to authenticate with PayPal' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { access_token } = await tokenRes.json()

    // Create unique batch ID
    const senderBatchId = `BOOKD_${requestId}_${Date.now()}`

    // Create payout
    const payoutBody = {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        recipient_type: recipientType,
        email_subject: "You've been paid via Bookd!",
        email_message: "Your early pay request has been funded. The money is on its way!"
      },
      items: [{
        recipient_type: recipientType,
        amount: {
          value: request.amount_to_trucker.toFixed(2),
          currency: 'USD'
        },
        receiver: recipientEmail,
        note: `Early pay for load - Bookd`,
        sender_item_id: requestId,
        recipient_wallet: paymentMethod === 'venmo' ? 'VENMO' : 'PAYPAL'
      }]
    }

    const payoutRes = await fetch(`${PAYPAL_API}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payoutBody)
    })

    const payout = await payoutRes.json()

    if (!payoutRes.ok) {
      console.error('PayPal payout error:', payout)

      // Update request with error
      await supabase
        .from('early_pay_requests')
        .update({
          payout_status: 'failed',
          payout_error: payout.message || 'PayPal payout failed',
          payout_method: paymentMethod
        })
        .eq('id', requestId)

      return new Response(
        JSON.stringify({
          error: 'Payout failed',
          details: payout.message || 'Unknown error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Update request with payout info
    const payoutBatchId = payout.batch_header?.payout_batch_id

    await supabase
      .from('early_pay_requests')
      .update({
        status: 'funded',
        funded_at: new Date().toISOString(),
        payout_id: payoutBatchId,
        payout_status: 'pending', // Will be updated by webhook
        payout_method: paymentMethod
      })
      .eq('id', requestId)

    // Update broker earnings (legacy)
    await supabase.rpc('add_broker_earnings', {
      p_broker_id: request.broker_id,
      p_amount: request.broker_fee
    })

    // ============================================
    // LOG REFERRAL EARNINGS FOR TRUCKER
    // ============================================

    // Get the broker with tier info
    const { data: broker } = await supabase
      .from('brokers')
      .select('id, tier')
      .eq('id', request.broker_id)
      .single()

    // Find the referring trucker (who connected this broker)
    const { data: relationship } = await supabase
      .from('trucker_broker_relationships')
      .select('trucker_id')
      .eq('broker_id', request.broker_id)
      .eq('status', 'active')
      .limit(1)
      .single()

    if (relationship && broker?.tier === 'free') {
      // Free broker: Trucker earns 10% of 5% fee (with $100/mo cap)
      const BROKER_FEE_RATE = 0.05
      const TRUCKER_SHARE = 0.10
      const MONTHLY_CAP = 100

      const grossFee = request.amount_requested * BROKER_FEE_RATE
      let truckerShare = grossFee * TRUCKER_SHARE

      // Check monthly cap
      const startOfMonth = new Date()
      startOfMonth.setDate(1)
      startOfMonth.setHours(0, 0, 0, 0)

      const { data: monthlyEarnings } = await supabase
        .from('earnings_ledger')
        .select('trucker_share')
        .eq('trucker_id', relationship.trucker_id)
        .eq('source_broker_id', request.broker_id)
        .eq('source_type', 'broker_free_fee')
        .gte('created_at', startOfMonth.toISOString())
        .neq('status', 'clawed_back')

      const monthlyTotal = (monthlyEarnings || [])
        .reduce((sum: number, e: any) => sum + parseFloat(e.trucker_share || 0), 0)

      if (monthlyTotal + truckerShare > MONTHLY_CAP) {
        truckerShare = Math.max(0, MONTHLY_CAP - monthlyTotal)
      }

      // Log earning if there's anything to earn
      if (truckerShare > 0) {
        const becomesPayableAt = new Date()
        becomesPayableAt.setDate(becomesPayableAt.getDate() + 7)

        await supabase
          .from('earnings_ledger')
          .insert({
            trucker_id: relationship.trucker_id,
            source_type: 'broker_free_fee',
            source_broker_id: request.broker_id,
            source_request_id: requestId,
            gross_amount: grossFee,
            trucker_share: Math.round(truckerShare * 100) / 100,
            status: 'pending',
            collected_at: new Date().toISOString(),
            becomes_payable_at: becomesPayableAt.toISOString()
          })

        // Log recruiter bonus (10% of trucker's earnings)
        const { data: recruiterRel } = await supabase
          .from('trucker_recruiters')
          .select('recruiter_id')
          .eq('recruited_id', relationship.trucker_id)
          .single()

        if (recruiterRel) {
          const recruiterBonus = truckerShare * 0.10

          await supabase
            .from('earnings_ledger')
            .insert({
              trucker_id: recruiterRel.recruiter_id,
              source_type: 'recruiter_bonus',
              source_trucker_id: relationship.trucker_id,
              gross_amount: truckerShare,
              trucker_share: Math.round(recruiterBonus * 100) / 100,
              status: 'pending',
              collected_at: new Date().toISOString(),
              becomes_payable_at: becomesPayableAt.toISOString()
            })
        }

        console.log(`Logged earning: $${truckerShare} for trucker ${relationship.trucker_id}`)
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        payout_batch_id: payoutBatchId,
        amount: request.amount_to_trucker,
        recipient: recipientEmail,
        method: paymentMethod
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Payout error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
