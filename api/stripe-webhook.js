// =============================================================================
//  api/stripe-webhook.js
//  Stripe -> Supabase: aktiverer/fornyer/deaktiverer Premium-abonnementet.
// =============================================================================
//
//  ENV-VARIABLER (Vercel -> Project -> Settings -> Environment Variables):
//    STRIPE_SECRET_KEY          = sk_test_...  (TEST)  eller  sk_live_...  (LIVE)   [HEMMELIG]
//    SUPABASE_URL               = https://<projekt>.supabase.co        (findes allerede fra maaneds-graensen)
//    SUPABASE_SERVICE_ROLE_KEY  = <service-role / secret-noegle>        (findes allerede, HEMMELIG)
//
//  TABEL (koer EN gang i Supabase -> SQL):
//    alter table public.subscriptions add column if not exists stripe_customer_id text;
//
//  SAADAN VERIFICERES en besked:
//    I stedet for signatur-/raw-body-tjek HENTER vi den aegte event direkte fra Stripe
//    (GET /v1/events/<id> med den hemmelige noegle). En forfalsket besked findes ikke hos
//    Stripe og bliver afvist. Vi bruger ALTID Stripes egne data — aldrig POST-bodyens.
//
//  STRIPE-WEBHOOK (Stripe -> Developers -> Webhooks -> Add endpoint):
//    URL:   https://DIT-DOMAENE/api/stripe-webhook
//    Events: checkout.session.completed
//            customer.subscription.created
//            customer.subscription.updated
//            customer.subscription.deleted
// =============================================================================

function sbBase() { const u = process.env.SUPABASE_URL; return u ? u.replace(/\/$/, '') : ''; }

// Opret/opdatér abonnements-raekken. Kun de felter vi sender bliver roert (resten staar urort).
async function upsertSub(userId, fields) {
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc || !userId) return;
  const row = Object.assign({ user_id: userId, updated_at: new Date().toISOString() }, fields);
  try {
    await fetch(base + '/rest/v1/subscriptions', {
      method: 'POST',
      headers: {
        apikey: svc,
        Authorization: 'Bearer ' + svc,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(row)
    });
  } catch (e) {}
}

// Find Supabase-bruger ud fra Stripe-kunde-id (gemt ved foerste betaling).
async function userByCustomer(customerId) {
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc || !customerId) return null;
  try {
    const q = base + '/rest/v1/subscriptions?stripe_customer_id=eq.' + encodeURIComponent(customerId) + '&select=user_id';
    const r = await fetch(q, { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
    if (!r.ok) return null;
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0]) ? rows[0].user_id : null;
  } catch (e) { return null; }
}

async function stripeGet(path, sk) {
  try {
    const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + sk } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Kun POST.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const eventId = body && body.id;
  if (!eventId || typeof eventId !== 'string' || eventId.indexOf('evt_') !== 0) {
    res.status(400).json({ error: 'Ugyldig event.' }); return;
  }

  const sk = process.env.STRIPE_SECRET_KEY;
  // Hvis noeglen ikke er sat endnu: svar 200 saa Stripe ikke spammer med gen-forsoeg under opsaetning.
  if (!sk) { res.status(200).json({ received: true, note: 'STRIPE_SECRET_KEY mangler' }); return; }

  // --- Verificér ved at hente den aegte event fra Stripe ---
  const evt = await stripeGet('events/' + encodeURIComponent(eventId), sk);
  if (!evt || !evt.type) { res.status(400).json({ error: 'Kunne ikke verificere event.' }); return; }

  const type = evt.type;
  const obj = (evt.data && evt.data.object) || {};

  try {
    if (type === 'checkout.session.completed') {
      // Foerste betaling: her har vi BAADE bruger-id (client_reference_id) OG kunde-id.
      const userId = obj.client_reference_id || null;     // = Supabase user_id (sat i Opgrader-linket)
      const customerId = obj.customer || null;
      let status = 'active', end = null;
      if (obj.subscription) {
        const sub = await stripeGet('subscriptions/' + encodeURIComponent(obj.subscription), sk);
        if (sub) {
          if (sub.status && sub.status !== 'active' && sub.status !== 'trialing') status = 'inactive';
          if (sub.current_period_end) end = new Date(sub.current_period_end * 1000).toISOString();
        }
      }
      if (userId) await upsertSub(userId, { status: status, stripe_customer_id: customerId, current_period_end: end });

    } else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
      // Fornyelse / aendring: find brugeren via kunde-id.
      const userId = await userByCustomer(obj.customer);
      if (userId) {
        const active = (obj.status === 'active' || obj.status === 'trialing');
        const end = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
        await upsertSub(userId, { status: active ? 'active' : 'inactive', current_period_end: end });
      }

    } else if (type === 'customer.subscription.deleted') {
      // Opsagt / stoppet: fjern adgang.
      const userId = await userByCustomer(obj.customer);
      if (userId) await upsertSub(userId, { status: 'inactive' });
    }
  } catch (e) { /* stille fejl — Stripe proever igen ved behov */ }

  res.status(200).json({ received: true });
}
