// Vercel serverless-funktion — AI-udfyldning af visitkort (Premium-låst).
// Bruger DeepSeek til at udtrække visitkortets felter + foreslå stil, men KUN
// inden for de værdier visitkort.html allerede understøtter. Funktionen kræver
// login + et aktivt Premium-abonnement (verificeres på serveren, så gratis-
// brugere ikke kan kalde endpointet udenom).
//
// ENV-VARIABLER (findes allerede på Vercel — samme som opslag-tekst):
//   DEEPSEEK_API_KEY            (påkrævet — teksten/designet)
//   SUPABASE_URL               (påkrævet — verificér bruger + abonnement)
//   SUPABASE_SERVICE_ROLE_KEY  (HEMMELIG — slår bruger + abonnement op, omgår RLS)
//
// Endepunkt: POST /api/visitkort-tekst   body: { emne: "<brugerens oplysninger>" }

// Whitelists — SKAL matche visitkort.html (STYLES, FONTS_TITLE, FONTS_BODY, FRONT_TYPES, CONTACT_TYPES)
const STYLES      = ['elegant', 'moderne', 'minimal', 'moerk'];
const FONTS_TITLE = ['Fraunces', 'Playfair Display', 'Bebas Neue', 'Montserrat', 'Jost', 'EB Garamond'];
const FONTS_BODY  = ['Jost', 'EB Garamond', 'Montserrat', 'Fraunces', 'Playfair Display'];
const FRONT_FIELDS = ['name', 'title', 'company', 'tagline', 'custom'];
const BACK_FIELDS  = ['phone', 'email', 'web', 'address', 'instagram', 'facebook', 'tiktok', 'linkedin', 'custom'];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const KEY = process.env.DEEPSEEK_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'DEEPSEEK_API_KEY mangler på serveren.' }); return; }

  // ---------- Adgang: login + Premium (server-side gate) ----------
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!token) { res.status(401).json({ error: 'Log ind for at bruge AI.' }); return; }
  if (!SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ error: 'Supabase er ikke konfigureret på serveren.' }); return; }

  // Hvem er brugeren? (brugerens eget JWT verificeres af Supabase Auth)
  let user = null;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY }
    });
    if (ur.ok) user = await ur.json();
  } catch (e) { /* falder igennem til 401 nedenfor */ }
  if (!user || !user.id) { res.status(401).json({ error: 'Din session er udløbet — log ind igen.' }); return; }

  // Har brugeren et aktivt abonnement?
  let isPaid = false;
  try {
    const sr = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=status,current_period_end`,
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (sr.ok) {
      const rows = await sr.json();
      const sub = Array.isArray(rows) ? rows[0] : null;
      if (sub && sub.status === 'active') {
        const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : null;
        isPaid = (!end || end > Date.now());
      }
    }
  } catch (e) { /* lader isPaid være false */ }
  if (!isPaid) { res.status(402).json({ error: 'AI-udfyldning kræver et aktivt Premium-abonnement.', needPremium: true }); return; }

  // ---------- Input ----------
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const emne = String(body.emne || '').slice(0, 1000).trim();
  if (!emne) { res.status(400).json({ error: 'Skriv dine oplysninger først.' }); return; }

  // ---------- Prompt — pin de tilladte værdier direkte ind ----------
  const sys =
    'Du er en assistent der udfylder et dansk visitkort. Du udtrækker kontaktoplysninger fra brugerens tekst og vælger en passende stil. ' +
    'Du må KUN bruge de felter, stilarter og fonte der er angivet. ' +
    'Du opfinder ALDRIG oplysninger (navn, telefon, e-mail, adresse, hjemmeside, sociale medier): hvis en oplysning ikke står i teksten, lader du feltet være tomt (""). ' +
    'Gengiv tal, e-mailadresser og URL\'er præcis som de står i teksten.';

  const userPrompt = [
    'Brugerens oplysninger:',
    emne,
    '',
    'Udfyld visitkortet. Placér felterne på den RIGTIGE side:',
    '- FORSIDE (front): name, title, company, tagline, custom',
    '- BAGSIDE (back): phone, email, web, address, instagram, facebook, tiktok, linkedin, custom',
    '(web, telefon, adresse og sociale medier hører KUN til på bagsiden; navn/titel/firma/slogan KUN på forsiden.)',
    '',
    'Vælg også et design der passer til branchen:',
    'design.style: én af: ' + STYLES.join(', '),
    'design.titleFont (navne-/titelfont): én af: ' + FONTS_TITLE.join(', '),
    'design.bodyFont (brødtekst-font): én af: ' + FONTS_BODY.join(', '),
    'design.orientation: én af: landscape, portrait',
    'design.accent: valgfri brand-farve som #rrggbb hex hvis brugeren nævner en farve, ellers null (så bruges stilens egen farve)',
    '',
    'LEVÉR KUN ÉT JSON-objekt i præcis denne form (udfyldte felter med tekst, ukendte felter som ""):',
    '{"front":{"name":"","title":"","company":"","tagline":"","custom":""},"back":{"phone":"","email":"","web":"","address":"","instagram":"","facebook":"","tiktok":"","linkedin":"","custom":""},"design":{"style":"elegant","titleFont":"Fraunces","bodyFont":"EB Garamond","orientation":"landscape","accent":null}}'
  ].join('\n');

  // ---------- Kald DeepSeek ----------
  let aiJson = null;
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.3,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }]
      })
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: 'AI-tjenesten svarede ikke. Prøv igen.', detail: detail.slice(0, 200) });
      return;
    }
    const data = await r.json();
    const txt = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    aiJson = parseJson(txt);
  } catch (e) {
    res.status(502).json({ error: 'Kunne ikke kontakte AI-tjenesten. Prøv igen.' });
    return;
  }
  if (!aiJson) { res.status(502).json({ error: 'AI gav et ugyldigt svar. Prøv igen.' }); return; }

  // ---------- Validér/klem output mod whitelists (den rigtige garanti) ----------
  const out = { front: {}, back: {}, design: {} };
  const inF = aiJson.front || {}, inB = aiJson.back || {};
  FRONT_FIELDS.forEach(k => { out.front[k] = cleanText(inF[k]); });
  BACK_FIELDS.forEach(k => { out.back[k] = cleanText(inB[k]); });
  const d = aiJson.design || {};
  out.design.style = STYLES.indexOf(d.style) >= 0 ? d.style : 'elegant';
  out.design.titleFont = FONTS_TITLE.indexOf(d.titleFont) >= 0 ? d.titleFont : '';
  out.design.bodyFont = FONTS_BODY.indexOf(d.bodyFont) >= 0 ? d.bodyFont : '';
  out.design.orientation = (d.orientation === 'portrait') ? 'portrait' : 'landscape';
  out.design.accent = (typeof d.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.accent)) ? d.accent.toLowerCase() : null;

  res.status(200).json(out);
}

function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
}

function parseJson(txt) {
  if (!txt) return null;
  let s = String(txt).trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (e) { /* prøv at finde første {...} */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* giv op */ } }
  return null;
}
