'use strict';
// Daily renewals: sandbox charges, cancel-at-period-end, lapsed postings, Stripe reconciliation, seeker digests.
// Exported runRenewals() returns counts; jobs/run.js is the CLI wrapper (systemd timer runs it daily).
const db = require('../lib/db');
const jobs = require('../lib/jobs');
const billing = require('../lib/billing');

async function runRenewals({ log = console.log } = {}) {
  const counts = { cancelled_at_period_end: 0, renewed: 0, stripe_reconciled: 0, expired_jobs: 0, stale_pending: 0, digests: null, errors: 0 };
  const now = new Date();

  // 1) Subscriptions the owner asked to end at the period end -> cancelled + job archived.
  const ending = await db.many(`SELECT * FROM subscriptions WHERE cancel_at_period_end = true AND status IN ('active','past_due') AND current_period_end <= now()`);
  for (const s of ending) {
    try {
      await db.tx(async (c) => {
        await c.query("UPDATE subscriptions SET status='cancelled', cancelled_at=COALESCE(cancelled_at, now()), cancel_at_period_end=false, updated_at=now() WHERE id=$1", [s.id]);
        await jobs.archiveJob(s.job_id, 'cancelled', c);
      });
      counts.cancelled_at_period_end++;
      log(`[renewals] subscription ${s.id} (job ${s.job_id}) cancelled at period end`);
    } catch (e) { counts.errors++; console.error('[renewals] cancel failed', s.id, e.message); }
  }

  // 2) Sandbox renewals: the "charge" always succeeds. New period starts where the old one ended
  //    (or now, if it lapsed by more than a month so the customer never pays for dead time).
  const due = await db.many(`SELECT * FROM subscriptions WHERE provider='sandbox' AND status='active' AND cancel_at_period_end=false AND current_period_end <= now()`);
  for (const s of due) {
    try {
      let period_start = new Date(s.current_period_end);
      let period_end = billing.addMonth(period_start);
      if (period_end <= now) { period_start = now; period_end = billing.addMonth(now); }
      const pay = await billing.recordPayment(s.id, { provider: 'sandbox', provider_payment_id: `sandbox_renewal_${s.id}_${period_start.toISOString().slice(0, 10)}`, period_start, period_end });
      counts.renewed++;
      log(`[renewals] renewed subscription ${s.id} (job ${s.job_id}) -> ${pay.receipt_number}, until ${period_end.toISOString()}`);
    } catch (e) { counts.errors++; console.error('[renewals] renewal failed', s.id, e.message); }
  }

  // 3) Stripe reconciliation: if a webhook was missed, pull the latest paid invoice for lapsed Stripe subscriptions.
  if (billing.mode() === 'stripe') {
    const stripe = billing.stripe();
    const lapsed = await db.many(`SELECT * FROM subscriptions WHERE provider='stripe' AND provider_subscription_id IS NOT NULL AND status IN ('active','past_due') AND current_period_end <= now()`);
    for (const s of lapsed) {
      try {
        const remote = await stripe.subscriptions.retrieve(s.provider_subscription_id, { expand: ['latest_invoice'] });
        const inv = remote.latest_invoice;
        if (remote.status === 'active' && inv && (inv.status === 'paid' || inv.paid)) {
          const before = await db.one('SELECT 1 FROM payments WHERE provider=$1 AND provider_payment_id=$2', ['stripe', inv.id]);
          await billing.handleStripeEvent({ type: 'invoice.paid', data: { object: inv } });
          if (!before) counts.stripe_reconciled++;
        } else if (['canceled', 'unpaid', 'incomplete_expired'].includes(remote.status)) {
          await billing.handleStripeEvent({ type: 'customer.subscription.deleted', data: { object: remote } });
          counts.stripe_reconciled++;
        }
        if (remote.cancel_at_period_end !== s.cancel_at_period_end) await db.query('UPDATE subscriptions SET cancel_at_period_end=$2 WHERE id=$1', [s.id, !!remote.cancel_at_period_end]);
      } catch (e) { counts.errors++; console.error('[renewals] stripe reconcile failed', s.id, e.message); }
    }
  }

  // 4) Anything still active past its paid period leaves public view.
  try {
    counts.expired_jobs = await jobs.expireLapsedJobs();
    if (counts.expired_jobs) log(`[renewals] expired ${counts.expired_jobs} lapsed job(s)`);
  } catch (e) { counts.errors++; console.error('[renewals] expireLapsedJobs failed', e.message); }

  // 5) Pending checkouts older than 7 days with no payment: leave the job in pending_payment, just report.
  const stale = await db.many(`SELECT s.id, s.job_id, s.created_at FROM subscriptions s WHERE s.status='pending' AND s.created_at < now() - interval '7 days'
                               AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.subscription_id = s.id AND p.status='paid')`);
  counts.stale_pending = stale.length;
  for (const s of stale) log(`[renewals] pending subscription ${s.id} (job ${s.job_id}) unpaid since ${new Date(s.created_at).toISOString().slice(0, 10)} — job left in pending_payment`);

  // 6) Seeker daily digests (owned by lib/matching.js; optional).
  try {
    const matching = require('../lib/matching');
    if (matching && typeof matching.sendDailyDigests === 'function') counts.digests = await matching.sendDailyDigests();
  } catch (e) { log(`[renewals] daily digests skipped: ${e.message}`); }

  return counts;
}

module.exports = { runRenewals };
