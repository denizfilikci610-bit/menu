// Vercel serverless-funktion — AI-design af visitkort (Premium-låst).
// AI'en udtrækker kortets felter ÉN gang og foreslår 5 KOMPLETTE, PÆNE design-varianter.
// Hver variant komponerer kortet med FLERE tekstbokse i forskellige zoner (fx slogan
// øverst, stort navn i midten, kontakt nederst), med klart størrelse-hierarki — kun
// SOLIDE farver (ingen gradient). Alt holder sig inden for det visitkort.html understøtter.
// Kræver login + aktivt Premium-abonnement (verificeres på serveren — fejler lukket).
//
// ENV (findes allerede på Vercel — samme som opslag-tekst):
//   DEEPSEEK_API_KEY            (påkrævet)
//   SUPABASE_URL               (påkrævet — verificér bruger + abonnement)
//   SUPABASE_SERVICE_ROLE_KEY  (HEMMELIG — slår bruger + abonnement op, omgår RLS)
//
// POST /api/visitkort-tekst   body: { emne: "<brugerens oplysninger>" }
// -> { content:{front,back}, variants:[ {label,style,fonts,front:{bgColor,ink,deco,boxes},back:{...}}, x5 ] }

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
const POSITIONS = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
const ALIGNS = ['left', 'center', 'right'];
const RADII  = [0, 10, 22];

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

  // ---------- Prompt: art-director der komponerer 5 PÆNE, rene kort ----------
  const sys =
    'Du er en prisvindende grafisk designer der laver smukke, rene danske visitkort. ' +
    'Du udtrækker kontaktoplysninger fra brugerens tekst ÉN gang, og designer derefter 5 FORSKELLIGE, gennemførte visitkort-forslag. ' +
    'Du må KUN bruge de felter, stilarter, fonte og værdier der er angivet — opfind ALDRIG andet. ' +
    'Du opfinder ALDRIG kontaktoplysninger: står de ikke i teksten, udelader du dem. Gengiv tal, e-mails og URL\'er præcis. ' +
    'KOMPOSITIONSREGLER (vigtigt — kortet må ALDRIG se rodet ud): ' +
    'Brug FLERE tekstbokse i FORSKELLIGE zoner i stedet for at proppe alt sammen i én blok. ' +
    'Et klassisk, flot layout er fx: slogan eller firma ØVERST, stort navn i MIDTEN, og kontakt/firma NEDERST. ' +
    'Giv et tydeligt størrelse-hierarki: navnet er størst (ca. 2.2–3.0), titel/firma mellem (ca. 0.9–1.2), kontaktlinjer små (ca. 0.9–1.0). ' +
    'Hvert felt må kun optræde ÉN gang. Brug luft mellem zonerne. ' +
    'Tekst i TOP- og BUND-zoner skal kunne stå på ÉN linje — hold den kort der (gerne ét kort felt pr. zone); længere tekst (fx navnet) lægges i MIDTER-zonen, som gerne må fylde to linjer. ' +
    'INGEN gradient — kun ÉN solid baggrundsfarve per side. Tekstfarve (ink) SKAL have høj kontrast til baggrunden. ' +
    'PYNT: Brug ALDRIG panel eller stribe. Kun ÉT af de 5 forslag må være to-farvet — det skal bruge en trekant (deco "corner"); de andre 4 har deco "none" (kun én farve). ' +
    'Trekanten sidder i HØJRE side, så på trekant-forslaget skal AL tekst være venstrestillet i venstre side og må ALDRIG overlappe trekanten. Trekant-forslaget har en anden baggrundsfarve på bagsiden. ' +
    'FARVER (VIGTIGT): Giv HVERT af de 5 forslag sit EGET, tydeligt forskellige farveskema — vælg ALTID eksplicitte bgColor, ink og accent for begge sider (forlad dig ALDRIG på standardfarver). Spred dem bredt: nogle lyse, nogle mørke, nogle med en mættet brand-farve som baggrund. INGEN to forslag må dele samme baggrunds- eller accentfarve, og gentag ALDRIG eksemplernes farver. Farverne skal stadig passe til branchen. Fremhæv navnet (bold) og giv firma eller titel accent-farve. ' +
    'POLERING (gør kortet smukt som et bureau-design): skriv labels (firma, evt. titel) i VERSALER (uppercase:true) med letter-spacing (lspace 0.15-0.3) og accent-farve; brug dim:true på sekundær tekst (titel/slogan/eyebrow) så navnet træder frem; sæt evt. en tynd skillestreg (en linje med type "line") mellem navn og firma. Stort navn (1.9-3.0), små labels (0.8-0.95). Centrér gerne (align center) for elegante kort.';

  // Eksempler i showcase-kvalitet (versaler+letter-spacing, dim, skillestreg, stærkt hierarki)
  const example = {
    label: 'Mørk elegant, trekant',
    style: 'moerk', titleFont: 'Fraunces', bodyFont: 'Jost', orientation: 'landscape', radius: 10, accent: '#d4a256',
    front: { bgColor: '#201d1a', ink: '#f4ead9', deco: { shape: 'corner', color: '#d4a256' }, boxes: [
      { pos: 'top-left', align: 'left', lines: [{ type: 'tagline', italic: true, dim: true, size: 0.9 }] },
      { pos: 'middle-left', align: 'left', lines: [{ type: 'name', size: 2.6, bold: true }, { type: 'title', dim: true, size: 0.95 }] },
      { pos: 'bottom-left', align: 'left', lines: [{ type: 'company', uppercase: true, lspace: 0.18, accent: true, size: 0.82 }] }
    ] },
    back: { bgColor: '#d4a256', ink: '#201d1a', deco: { shape: 'none', color: '#201d1a' }, boxes: [
      { pos: 'middle-center', align: 'center', lines: [{ type: 'phone' }, { type: 'email' }, { type: 'web' }, { type: 'address' }] }
    ] }
  };
  const example2 = {
    label: 'Minimal sort, 3 zoner',
    style: 'minimal', titleFont: 'Bebas Neue', bodyFont: 'Jost', orientation: 'landscape', radius: 0, accent: '#e8e2d4',
    front: { bgColor: '#0a0a0a', ink: '#ffffff', deco: { shape: 'none', color: '#e8e2d4' }, boxes: [
      { pos: 'top-left', align: 'left', lines: [{ type: 'company', uppercase: true, lspace: 0.3, dim: true, size: 0.78 }] },
      { pos: 'middle-left', align: 'left', lines: [{ type: 'name', uppercase: true, size: 3.0, bold: true }] },
      { pos: 'bottom-left', align: 'left', lines: [{ type: 'title', dim: true, size: 0.85 }] }
    ] },
    back: { bgColor: '#0a0a0a', ink: '#ffffff', deco: { shape: 'none', color: '#e8e2d4' }, boxes: [
      { pos: 'middle-center', align: 'center', lines: [{ type: 'web', size: 1.1 }, { type: 'email', thin: true, size: 0.9 }] }
    ] }
  };
  const example3 = {
    label: 'Klassisk med streg',
    style: 'elegant', titleFont: 'Playfair Display', bodyFont: 'EB Garamond', orientation: 'landscape', radius: 8, accent: '#b5542a',
    front: { bgColor: '#fbf6ec', ink: '#2c2620', deco: { shape: 'none', color: '#b5542a' }, boxes: [
      { pos: 'middle-left', align: 'left', lines: [{ type: 'name', size: 2.2 }, { type: 'title', dim: true, italic: true, size: 0.92 }, { type: 'line' }, { type: 'company', uppercase: true, lspace: 0.2, accent: true, size: 0.85 }] }
    ] },
    back: { bgColor: '#b5542a', ink: '#fbf6ec', deco: { shape: 'none', color: '#fbf6ec' }, boxes: [
      { pos: 'middle-left', align: 'left', lines: [{ type: 'phone' }, { type: 'email' }, { type: 'web' }] }
    ] }
  };

  // Tilfældig farve-inspiration pr. kald, så farverne skifter ved hver ny generering
  const COLOR_DIRS = ['dyb skovgrøn', 'varm terrakotta', 'marineblå', 'bordeaux', 'sennepsgul', 'støvet rosa', 'koksgrå', 'cremehvid', 'dyb sort', 'olivengrøn', 'rustrød', 'petroleumsblå', 'sandbeige', 'aubergine/plomme', 'kobber', 'salviegrøn', 'mørk chokoladebrun', 'koralrød', 'isblå', 'guld på sort'];
  const shuffled = COLOR_DIRS.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp; }
  const colorHint = shuffled.slice(0, 6).join(', ');

  const userPrompt = [
    'Brugerens oplysninger:', emne, '',
    'Hvis teksten beskriver virksomheden eller branchen, så lad det styre valg af stil, farver og fonte, så designet passer til netop den branche.',
    'TRIN 1 — udtræk indhold (samme til alle 5 forslag). Placér på RIGTIG side:',
    '- FORSIDE (front): name, title, company, tagline, custom',
    '- BAGSIDE (back): phone, email, web, address, instagram, facebook, tiktok, linkedin, custom',
    '(web, telefon, adresse og sociale medier hører KUN til på bagsiden; navn/titel/firma/slogan KUN på forsiden.)',
    '',
    'TRIN 2 — komponér 5 forskellige, pæne design. Hvert forslag må KUN bruge disse værdier:',
    'style: ' + STYLE_KEYS.join(', '),
    'titleFont: ' + FONTS_TITLE.join(', ') + '   bodyFont: ' + FONTS_BODY.join(', '),
    'orientation: landscape | portrait    radius: 0 | 10 | 22    alle farver: #rrggbb hex',
    'front og back har hver: bgColor (ÉN solid hex — INGEN gradient), ink (tekstfarve hex), deco{shape: none|corner, color:hex}, og boxes[].',
    'boxes er en liste af tekstbokse, hver: {pos: ' + POSITIONS.join('|') + ', align: left|center|right, lines: [ {type, size: 0.6-3.0, bold, italic, thin, accent, dim (nedtonet), uppercase (VERSALER), lspace: 0|0.12|0.18|0.25|0.3 (bogstavafstand)} ]}. En linje med type "line" er en tynd skillestreg.',
    'Fordel felterne på 2-3 bokse i forskellige zoner (fx top/midt/bund) — IKKE alt i én boks. Hvert felt kun én gang.',
    'PYNT-REGEL: kun ÉT forslag må have deco "corner" (trekant i højre side); på det forslag skal AL tekst være venstrestillet (pos i venstre kolonne). De andre 4 forslag har deco "none". Brug aldrig panel/stribe.',
    'FARVE-INSPIRATION til netop denne omgang (vælg de der passer til branchen, og brug FORSKELLIGE farver til hvert af de 5 forslag): ' + colorHint + '.',
    '',
    'EKSEMPLER på forslags form (efterlign den rene, polerede komposition — men design dine egne til brugeren):',
    JSON.stringify(example),
    JSON.stringify(example2),
    JSON.stringify(example3),
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
        temperature: 0.85,
        max_tokens: 3600,
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

  // ---------- Håndhæv: KUN ét to-farvet forslag (trekant), resten én-farvet ----------
  // Forhindrer at tekst overlapper to farver: panel/stribe fjernes helt, og kun det
  // ene trekant-forslag har en deco — med teksten holdt i venstre side (væk fra trekanten).
  let cornerIdx = variants.findIndex(v => v.front.deco.shape === 'corner');
  if (cornerIdx < 0) cornerIdx = 0;
  variants.forEach((v, i) => {
    if (i === cornerIdx) {
      v.front.deco = { shape: 'corner', color: v.accent };                 // trekant i højre side (accent-farve)
      v.front.boxes.forEach(b => { b.pos = toLeftCol(b.pos); b.align = 'left'; }); // tekst i venstre side, fri af trekanten
      v.back.deco = { shape: 'none', color: v.accent };
      v.back.bgColor = v.accent; v.back.ink = '';                          // variation: accent-farvet bagside
      fixContrast(v.back, STYLES[v.style]);                                // sikr læsbar tekst på den nye baggrund
    } else {
      v.front.deco = { shape: 'none', color: v.front.deco.color };         // én-farvet (ingen anden farve = intet overlap)
      v.back.deco = { shape: 'none', color: v.back.deco.color };
    }
  });

  res.status(200).json({ content, variants });
}

// ===== Validerings-hjælpere =====
function hex6(v) { return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toLowerCase() : null; }
function oneOf(v, arr, def) { return arr.indexOf(v) >= 0 ? v : def; }
function clampNum(v, min, max, def) { const n = Number(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
function cleanText(v) { if (typeof v !== 'string') return ''; return v.replace(/\s+/g, ' ').trim().slice(0, 140); }
function toLeftCol(pos) { if (typeof pos !== 'string') return 'middle-left'; if (pos.indexOf('top') === 0) return 'top-left'; if (pos.indexOf('bottom') === 0) return 'bottom-left'; return 'middle-left'; }

function valLines(lines, typeSet) {
  if (!Array.isArray(lines)) return [];
  const seen = {}; const out = [];
  lines.forEach(ln => {
    if (!ln || typeof ln !== 'object') return;
    const type = ln.type;
    if (typeSet.indexOf(type) < 0) return;
    if (type === 'line') { out.push({ type: 'line' }); return; }   // tynd skillestreg (må gentages)
    if (seen[type]) return;
    seen[type] = true;
    const o = { type, bold: !!ln.bold, italic: !!ln.italic, thin: !!ln.thin, accent: !!ln.accent, dim: !!ln.dim, uppercase: !!ln.uppercase };
    if (typeof ln.size === 'number' && isFinite(ln.size)) o.size = clampNum(ln.size, 0.4, 3.5, 1);
    o.lspace = clampNum(ln.lspace, 0, 0.4, 0);
    out.push(o);
  });
  return out.slice(0, 8);
}
function valSideDesign(sd, style, typeSet) {
  sd = sd || {};
  let boxes = Array.isArray(sd.boxes) ? sd.boxes.slice(0, 4) : [];
  boxes = boxes.map(bx => ({
    pos: oneOf((bx || {}).pos, POSITIONS, 'middle-left'),
    align: oneOf((bx || {}).align, ALIGNS, 'left'),
    lines: valLines((bx || {}).lines, typeSet)
  })).filter(bx => bx.lines.length);
  const out = {
    bgColor: hex6(sd.bgColor) || style.paper,
    ink: hex6(sd.ink) || '',
    deco: { shape: oneOf((sd.deco || {}).shape, DECO, 'none'), color: hex6((sd.deco || {}).color) || style.accent },
    boxes
  };
  fixContrast(out, style);
  return out;
}
function valVariant(v) {
  if (!v || typeof v !== 'object') return null;
  const styleKey = oneOf(v.style, STYLE_KEYS, 'elegant');
  const style = STYLES[styleKey];
  return {
    label: cleanText(v.label).slice(0, 40) || 'Forslag',
    style: styleKey,
    titleFont: oneOf(v.titleFont, FONTS_TITLE, style.titleFont),
    bodyFont: oneOf(v.bodyFont, FONTS_BODY, style.bodyFont),
    orientation: oneOf(v.orientation, ['landscape', 'portrait'], 'landscape'),
    radius: RADII.indexOf(Number(v.radius)) >= 0 ? Number(v.radius) : 10,
    accent: hex6(v.accent) || style.accent,
    accentLine: style.accentLine,
    front: valSideDesign(v.front, style, FRONT_FIELDS),
    back: valSideDesign(v.back, style, BACK_FIELDS)
  };
}

// ===== Kontrast-vagt: tekst skal altid være læsbar mod den solide baggrund =====
function hexToRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function lum(h) { const c = hexToRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function ratio(a, b) { const la = lum(a) + 0.05, lb = lum(b) + 0.05; return la > lb ? la / lb : lb / la; }
function fixContrast(side, style) {
  let ink = side.ink || (lum(side.bgColor) < 0.5 ? style.paper : style.ink);
  if (ratio(ink, side.bgColor) < 3.2) { ink = lum(side.bgColor) < 0.5 ? '#ffffff' : '#1c1c1c'; }
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
