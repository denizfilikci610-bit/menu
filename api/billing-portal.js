// Serverless-funktion: åbner Stripe Customer Portal, så kunden SELV kan
// administrere sit abonnement (skifte kort, se kvitteringer, OPSIGE).
// Kører på Vercel under /api/billing-portal
//
// ENV-VARIABLER (alle findes allerede):
//   STRIPE_SECRET_KEY           (samme som dine menukort-betalinger)
//   SUPABASE_URL                (fra månedsgrænsen/abonnement)
//   SUPABASE_SERVICE_ROLE_KEY   (HEMMELIG, samme sted)
//
// SIKKERHED: Vi stoler IKKE på et kunde-id fra browseren. Serveren tjekker
// brugerens login-token hos Supabase, finder DENNE brugers Stripe-kunde-id,
// og åbner kun DEN portal. Så ingen kan åbne en andens abonnement.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

function sbBase(){ const u = process.env.SUPABASE_URL; return u ? u.replace(/\/$/, '') : ''; }

// Bekræft login-token -> Supabase user-id.
async function userIdFromToken(req){
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc) return null;
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  try {
    const r = await fetch(base + '/auth/v1/user', { headers: { apikey: svc, Authorization: 'Bearer ' + m[1] } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) ? u.id : null;
  } catch (e) { return null; }
}

// Find brugerens gemte Stripe-kunde-id (gemt af webhook'en ved første betaling).
async function customerIdForUser(userId){
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc || !userId) return null;
  try {
    const q = base + '/rest/v1/subscriptions?user_id=eq.' + encodeURIComponent(userId) + '&select=stripe_customer_id';
    const r = await fetch(q, { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
    if (!r.ok) return null;
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0]) ? rows[0].stripe_customer_id : null;
  } catch (e) { return null; }
}

function safeReturnPath(p){
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return '/';
  return p;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const userId = await userIdFromToken(req);
    if (!userId) { res.status(401).json({ error: 'Ikke logget ind.' }); return; }

    const customerId = await customerIdForUser(userId);
    if (!customerId) { res.status(400).json({ error: 'Intet abonnement fundet.' }); return; }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const returnPath = safeReturnPath(req.body && req.body.returnPath);

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}${returnPath}`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
