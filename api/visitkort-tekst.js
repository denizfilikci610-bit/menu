// Vercel serverless-funktion — AI-design af visitkort (Premium-låst).
// AI'en udtrækker kortets felter ÉN gang og foreslår 5 KOMPLETTE design-varianter
// (farver/gradient/tekstfarve per side, pynt, hjørner, typografi, komposition, fonte,
// orientation, accent) — men KUN inden for de værdier visitkort.html understøtter.
// Kræver login + aktivt Premium-abonnement (verificeres på serveren — fejler lukket).
//
// ENV (findes allerede på Vercel — samme som opslag-tekst):
//   DEEPSEEK_API_KEY            (påkrævet)
//   SUPABASE_URL               (påkrævet — verificér bruger + abonnement)
//   SUPABASE_SERVICE_ROLE_KEY  (HEMMELIG — slår bruger + abonnement op, omgår RLS)
//
// POST /api/visitkort-tekst   body: { emne: "<brugerens oplysninger>" }
// -> { content:{front,back}, variants:[ {label,style,fonts,colors,deco,emphasis,layout}, x5 ] }

// ===== Whitelists — SKAL matche visitkort.html =====
const STYLES = {
  elegant: { accent: '#b5542a', paper: '#fbf6ec', ink: '#2c2620', titleFont: 'Fraunces',   bodyFont: 'EB Garamond', accentLine: true  },
  moderne: { accent: '#1f5f5b', paper: '#ffffff', ink: '#1c1c1c', titleFont: 'Montserrat',  bodyFont: 'Jost',        accentLine: true  },
  minimal: { accent: '#111111', paper: '#ffffff', ink: '#111111', titleFont: 'Jost',        bodyFont: 'Jost',        accentLine: false },
  moerk:   { accent: '#d4a256', paper: '#201d1a', ink: '#f4ead9', titleFont: 'Fraunces',    bodyFont: 'Jost',        accentLine: true  }
};
const STYLE_KEYS  = ['elegant', 'moderne', 'minimal', 'moerk'];
const FONTS_TITLE = ['Fraunces', 'Playfair Display', 'Bebas Neue', 'Montserrat', 'Jost', 'EB Garamond'];
const FONTS_BODY  = ['Jost', 'EB Garamond', 'Montserrat', 'Fraunces', 'Playfair Display'];
const FRONT_FIELDS = ['name', 'title', 'company', 'tagline', 'custom'];
const BACK_FIELDS  = ['phone', 'email', 'web', 'address', 'instagram', 'facebook', 'tiktok', 'linkedin', 'custom'];
const DECO  = ['none', 'corner', 'panel', 'stripe'];
const DIRS  = ['to right', 'to bottom', 'to bottom right'];
const POSITIONS = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
const ALIGNS = ['left', 'center', 'right'];
const RADII  = [0, 10, 22];
const EMPH_TYPES = ['name', 'title', 'company', 'tagline', 'phone', 'email', 'web', 'address'];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const KEY = process.env.DEEPSEEK_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'DEEPSEEK_API_KEY mangler på serveren.' }); return; }

  // ---------- Adgang: login + Premium (server-side gate, fejler lukket) ----------
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!token) { res.status(401).json({ error: 'Log ind for at bruge AI.' }); return; }
  if (!SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ error: 'Supabase er ikke konfigureret på serveren.' }); return; }

  let user = null;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY } });
    if (ur.ok) user = await ur.json();
  } catch (e) { /* -> 401 */ }
  if (!user || !user.id) { res.status(401).json({ error: 'Din session er udløbet — log ind igen.' }); return; }

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
  } catch (e) { /* isPaid forbliver false */ }
  if (!isPaid) { res.status(402).json({ error: 'AI-udfyldning kræver et aktivt Premium-abonnement.', needPremium: true }); return; }

  // ---------- Input ----------
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const emne = String(body.emne || '').slice(0, 1000).trim();
  if (!emne) { res.status(400).json({ error: 'Skriv dine oplysninger først.' }); return; }

  // ---------- Prompt: art-director der laver 5 forskellige design ----------
  const sys =
    'Du er en prisvindende grafisk designer der laver danske visitkort. ' +
    'Du udtrækker kontaktoplysninger fra brugerens tekst ÉN gang, og designer derefter 5 FORSKELLIGE, komplette og smukke visitkort-forslag. ' +
    'Du må KUN bruge de felter, stilarter, fonte og værdier der er angivet — opfind ALDRIG andet. ' +
    'Du opfinder ALDRIG kontaktoplysninger (navn, telefon, e-mail, adresse, hjemmeside, sociale medier): står de ikke i teksten, er feltet tomt (""). Gengiv tal, e-mails og URL\'er præcis. ' +
    'DESIGNREGLER: de 5 forslag skal være tydeligt forskellige (fx elegant lys, mørk/dristig, minimalistisk, farverig gradient, klassisk). ' +
    'Tekstfarve (ink) SKAL have høj kontrast til baggrunden, så teksten altid er let at læse. Vælg farver der passer til branchen. Brug gerne gradient-baggrund og pynt til at give kortet liv. ' +
    'Fremhæv navnet (stort/fed) og giv firma eller titel accent-farve for et professionelt hierarki.';

  const example = {
    label: 'Mørk & elegant',
    style: 'moerk', titleFont: 'Fraunces', bodyFont: 'Jost', orientation: 'landscape', radius: 10, accent: '#d4a256',
    front: { bg: { mode: 'grad', c1: '#201d1a', c2: '#2e2a25', dir: 'to bottom right' }, ink: '#f4ead9', deco: { shape: 'corner', color: '#d4a256' } },
    back:  { bg: { mode: 'solid', c1: '#d4a256', c2: '#d4a256', dir: 'to right' }, ink: '#201d1a', deco: { shape: 'none', color: '#201d1a' } },
    emphasis: { name: { size: 2.4, bold: true }, title: { accent: true }, company: { italic: true } },
    layout: { front: { pos: 'middle-left', align: 'left' }, back: { pos: 'middle-center', align: 'center' } }
  };
  const example2 = {
    label: 'Lys minimal',
    style: 'minimal', titleFont: 'Bebas Neue', bodyFont: 'Jost', orientation: 'landscape', radius: 0, accent: '#1f5f5b',
    front: { bg: { mode: 'solid', c1: '#ffffff', c2: '#ffffff', dir: 'to right' }, ink: '#111111', deco: { shape: 'stripe', color: '#1f5f5b' } },
    back:  { bg: { mode: 'solid', c1: '#ffffff', c2: '#ffffff', dir: 'to right' }, ink: '#111111', deco: { shape: 'none', color: '#1f5f5b' } },
    emphasis: { name: { size: 2.8, bold: true }, company: { accent: true } },
    layout: { front: { pos: 'bottom-left', align: 'left' }, back: { pos: 'middle-center', align: 'center' } }
  };

  const userPrompt = [
    'Brugerens oplysninger:', emne, '',
    'TRIN 1 — udtræk indhold (samme til alle 5 forslag). Placér på RIGTIG side:',
    '- FORSIDE (front): name, title, company, tagline, custom',
    '- BAGSIDE (back): phone, email, web, address, instagram, facebook, tiktok, linkedin, custom',
    '(web, telefon, adresse og sociale medier hører KUN til på bagsiden; navn/titel/firma/slogan KUN på forsiden.)',
    '',
    'TRIN 2 — lav 5 forskellige design-forslag. Hvert forslag må KUN bruge disse værdier:',
    'style: ' + STYLE_KEYS.join(', '),
    'titleFont: ' + FONTS_TITLE.join(', '),
    'bodyFont: ' + FONTS_BODY.join(', '),
    'orientation: landscape | portrait    radius: 0 | 10 | 22',
    'accent / alle farver: #rrggbb hex',
    'front og back har hver: bg{mode: solid|grad, c1:hex, c2:hex, dir: "to right"|"to bottom"|"to bottom right"}, ink:hex (tekstfarve), deco{shape: none|corner|panel|stripe, color:hex}',
    'emphasis (valgfri vægtning pr. felt name/title/company/tagline/phone/email/web/address): {size: 0.6-3.0, bold:true, italic:true, accent:true}',
    'layout.front og layout.back: {pos: ' + POSITIONS.join('|') + ', align: left|center|right}',
    '',
    'EKSEMPLER på ét forslags form (efterlign kvaliteten, men lav dine egne til brugeren):',
    JSON.stringify(example),
    JSON.stringify(example2),
    '',
    'LEVÉR KUN ÉT JSON-objekt i præcis denne form:',
    '{"content":{"front":{"name":"","title":"","company":"","tagline":"","custom":""},"back":{"phone":"","email":"","web":"","address":"","instagram":"","facebook":"","tiktok":"","linkedin":"","custom":""}},"variants":[ <5 forslag som eksemplerne ovenfor> ]}'
  ].join('\n');

  // ---------- Kald DeepSeek ----------
  let aiJson = null;
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.6,
        max_tokens: 3200,
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

  // ---------- Validér mod whitelists (den rigtige garanti) ----------
  const content = { front: {}, back: {} };
  const inC = aiJson.content || {};
  const inF = inC.front || {}, inB = inC.back || {};
  FRONT_FIELDS.forEach(k => { content.front[k] = cleanText(inF[k]); });
  BACK_FIELDS.forEach(k => { content.back[k] = cleanText(inB[k]); });

  const rawVariants = Array.isArray(aiJson.variants) ? aiJson.variants.slice(0, 5) : [];
  const variants = rawVariants.map(valVariant).filter(Boolean);
  if (!variants.length) { res.status(502).json({ error: 'AI gav ingen brugbare forslag. Prøv igen.' }); return; }

  res.status(200).json({ content, variants });
}

// ===== Validerings-hjælpere =====
function hex6(v) { return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toLowerCase() : null; }
function oneOf(v, arr, def) { return arr.indexOf(v) >= 0 ? v : def; }
function clampNum(v, min, max, def) { const n = Number(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
function cleanText(v) { if (typeof v !== 'string') return ''; return v.replace(/\s+/g, ' ').trim().slice(0, 140); }

function valSide(sd, style) {
  sd = sd || {};
  const bg = sd.bg || {};
  return {
    bg: { mode: oneOf(bg.mode, ['solid', 'grad'], 'solid'), c1: hex6(bg.c1) || style.paper, c2: hex6(bg.c2) || style.accent, dir: oneOf(bg.dir, DIRS, 'to bottom right') },
    ink: hex6(sd.ink) || '',
    deco: { shape: oneOf((sd.deco || {}).shape, DECO, 'none'), color: hex6((sd.deco || {}).color) || style.accent }
  };
}
function valEmphasis(em) {
  em = em || {}; const out = {};
  EMPH_TYPES.forEach(t => {
    const e = em[t]; if (!e || typeof e !== 'object') return;
    const o = {};
    if (e.size != null) o.size = clampNum(e.size, 0.4, 3.5, 1);
    if (e.bold) o.bold = true;
    if (e.italic) o.italic = true;
    if (e.accent) o.accent = true;
    if (Object.keys(o).length) out[t] = o;
  });
  return out;
}
function valLayout(lay) {
  lay = lay || {};
  const side = s => { s = s || {}; return { pos: oneOf(s.pos, POSITIONS, 'middle-left'), align: oneOf(s.align, ALIGNS, 'left') }; };
  return { front: side(lay.front), back: side(lay.back) };
}
function valVariant(v) {
  if (!v || typeof v !== 'object') return null;
  const styleKey = oneOf(v.style, STYLE_KEYS, 'elegant');
  const style = STYLES[styleKey];
  const front = valSide(v.front, style); fixContrast(front, style);
  const back = valSide(v.back, style); fixContrast(back, style);
  return {
    label: cleanText(v.label).slice(0, 40) || 'Forslag',
    style: styleKey,
    titleFont: oneOf(v.titleFont, FONTS_TITLE, style.titleFont),
    bodyFont: oneOf(v.bodyFont, FONTS_BODY, style.bodyFont),
    orientation: oneOf(v.orientation, ['landscape', 'portrait'], 'landscape'),
    radius: RADII.indexOf(Number(v.radius)) >= 0 ? Number(v.radius) : 10,
    accent: hex6(v.accent) || style.accent,
    accentLine: style.accentLine,
    front, back,
    emphasis: valEmphasis(v.emphasis),
    layout: valLayout(v.layout)
  };
}

// ===== Kontrast-vagt: sørg for at tekst altid er læsbar mod baggrunden =====
function hexToRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function lum(h) { const c = hexToRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function ratio(a, b) { const la = lum(a) + 0.05, lb = lum(b) + 0.05; return la > lb ? la / lb : lb / la; }
function blend(a, b) { const ra = hexToRgb(a), rb = hexToRgb(b); return '#' + ra.map((x, i) => ('0' + Math.round((x + rb[i]) / 2).toString(16)).slice(-2)).join(''); }
function fixContrast(side, style) {
  const effBg = side.bg.mode === 'grad' ? blend(side.bg.c1, side.bg.c2) : side.bg.c1;
  let ink = side.ink || (lum(effBg) < 0.5 ? style.paper : style.ink);
  if (ratio(ink, effBg) < 3.2) { ink = lum(effBg) < 0.5 ? '#ffffff' : '#1c1c1c'; }
  side.ink = ink; // altid eksplicit, læsbar tekstfarve
}

function parseJson(txt) {
  if (!txt) return null;
  let s = String(txt).trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (e) { /* find første {...} */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* giv op */ } }
  return null;
}
