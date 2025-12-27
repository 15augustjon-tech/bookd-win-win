// PayPal Webhook Handler for Bookd
// Receives payout status updates from PayPal

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PAYPAL_WEBHOOK_ID = Deno.env.get('PAYPAL_WEBHOOK_ID')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.text()
    const event = JSON.parse(body)

    // Initialize Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    console.log('PayPal webhook event:', event.event_type)

    // Handle different event types
    switch (event.event_type) {
      case 'PAYMENT.PAYOUTSBATCH.SUCCESS': {
        // Batch payout completed successfully
        const batchId = event.resource?.batch_header?.payout_batch_id
        if (batchId) {
          await supabase
            .from('early_pay_requests')
            .update({ payout_status: 'success' })
            .eq('payout_id', batchId)
        }
        break
      }

      case 'PAYMENT.PAYOUTSBATCH.DENIED': {
        // Batch payout was denied
        const batchId = event.resource?.batch_header?.payout_batch_id
        const error = event.resource?.batch_header?.errors?.[0]?.message || 'Payout denied'
        if (batchId) {
          await supabase
            .from('early_pay_requests')
            .update({
              payout_status: 'failed',
              payout_error: error
            })
            .eq('payout_id', batchId)
        }
        break
      }

      case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': {
        // Individual payout item succeeded
        const itemId = event.resource?.payout_item?.sender_item_id // This is our requestId
        if (itemId) {
          await supabase
            .from('early_pay_requests')
            .update({ payout_status: 'success' })
            .eq('id', itemId)
        }
        break
      }

      case 'PAYMENT.PAYOUTS-ITEM.DENIED':
      case 'PAYMENT.PAYOUTS-ITEM.FAILED': {
        // Individual payout item failed
        const itemId = event.resource?.payout_item?.sender_item_id
        const error = event.resource?.errors?.[0]?.message || 'Payout failed'
        if (itemId) {
          await supabase
            .from('early_pay_requests')
            .update({
              payout_status: 'failed',
              payout_error: error
            })
            .eq('id', itemId)
        }
        break
      }

      case 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': {
        // Recipient hasn't claimed the payout
        const itemId = event.resource?.payout_item?.sender_item_id
        if (itemId) {
          await supabase
            .from('early_pay_requests')
            .update({
              payout_status: 'unclaimed',
              payout_error: 'Recipient has not claimed the payment'
            })
            .eq('id', itemId)
        }
        break
      }

      case 'PAYMENT.PAYOUTS-ITEM.RETURNED': {
        // Payout was returned (unclaimed for 30 days)
        const itemId = event.resource?.payout_item?.sender_item_id
        if (itemId) {
          await supabase
            .from('early_pay_requests')
            .update({
              payout_status: 'failed',
              payout_error: 'Payment returned - unclaimed for 30 days'
            })
            .eq('id', itemId)
        }
        break
      }

      default:
        console.log('Unhandled event type:', event.event_type)
    }

    return new Response(
      JSON.stringify({ received: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Webhook error:', error)
    return new Response(
      JSON.stringify({ error: 'Webhook processing failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
