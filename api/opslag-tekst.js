// Vercel serverless-funktion — DeepSeek (tekst + art direction) + brand-hentning + foto-søgning.
// API-nøglen ligger KUN her på serveren.
//
// Opsætning i Vercel → Project → Settings → Environment Variables:
//   DEEPSEEK_API_KEY = <din DeepSeek-nøgle>      (påkrævet — teksten)
//   PEXELS_API_KEY   = <din gratis Pexels-nøgle>  (valgfri — rigtige baggrundsfotos)
//      Hent gratis på pexels.com/api → opret konto → "Your API Key".
//   Vælg alle miljøer → Save → Redeploy.
// Filen skal ligge i mappen /api → endepunkt: /api/opslag-tekst

const PALETTES = ['terra','cream','dark','forest','berry','navy','teal','blush','mustard','coral','sky','wine','rust','olive','ocean','lavender','peach','slate','cocoa','mint'];
const MOTIFS   = ['none','graduation','sale','coffee','food','leaf','snowflake','confetti','flower','heart','gift','sun','sparkle','scissors','dumbbell'];
const LAYOUTS  = ['centered','left'];
const FONTS    = ['serif','sans'];
const STYLES   = ['photo','photoband','poster'];

const PHOTO_FALLBACK = {
  graduation:'graduation celebration', sale:'shopping fashion store', coffee:'coffee shop latte',
  food:'restaurant food plate', leaf:'autumn nature leaves', snowflake:'cozy christmas winter',
  confetti:'celebration party confetti', flower:'fresh flowers bouquet', heart:'romantic candle dinner',
  gift:'gift wrapping present', sun:'summer beach sunshine', sparkle:'modern minimal studio',
  scissors:'hair salon styling', dumbbell:'gym fitness training', none:'minimal lifestyle'
};

const hex6 = h => typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h.trim());

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Kun POST er tilladt.' }); return; }

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) { res.status(500).json({ error: 'Serveren mangler DEEPSEEK_API_KEY. Tilføj den i Vercel og deploy igen.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const navn     = String(body.navn || '').slice(0, 120);
  const type     = String(body.type || '').slice(0, 120) || 'lille virksomhed';
  const website  = String(body.website || '').slice(0, 300);
  const emne     = String(body.emne || '').slice(0, 800);
  const platform = String(body.platform || 'facebook');
  const laengde  = String(body.laengde || 'mellem');
  const emoji    = String(body.emoji || 'med');
  let   antal    = parseInt(body.antal, 10);
  if (!(antal >= 1 && antal <= 5)) antal = 3;

  if (!emne.trim()) { res.status(400).json({ error: 'Skriv hvad opslaget skal handle om.' }); return; }

  // ---- Brand-profil fra hjemmeside (valgfrit) ----
  let brand = { used: false, host: '' };
  let profile = null;
  if (website.trim()) {
    try { profile = await fetchBrandProfile(website); } catch (e) { profile = null; }
    if (profile && !profile.error) { brand.host = profile.host || ''; brand.used = !!((profile.colors && profile.colors.length) || profile.title); }
  }

  const platMap = { facebook:'Facebook', instagram:'Instagram', linkedin:'LinkedIn' };
  const lenMap  = { kort:'kort — 1-2 sætninger', mellem:'mellemlang — 3-5 sætninger', lang:'længere — et lille afsnit' };
  const emojiInstr = emoji === 'uden' ? 'Brug IKKE emojis.' : 'Brug nogle få, passende emojis — ikke for mange.';

  const sys = 'Du er både en erfaren dansk social media-tekstforfatter OG en prisvindende grafisk designer/art director for små danske virksomheder. ' +
    'Du skriver naturligt, varmt dansk. Som art director vælger du komposition, foto, farver, motiv og typografi, så hvert opslag ser unikt og professionelt ud — som et rigtigt reklameopslag, ikke en skabelon.';

  const lines = [
    'Lav indhold OG gennemtænkte design-valg til et opslag til ' + (platMap[platform] || 'Facebook') + '.',
    '',
    'Virksomhed: ' + (navn || 'ikke oplyst'),
    'Type: ' + type,
    'Opslaget handler om: ' + emne,
    'Vælg selv den tone der passer. Længde på billedteksten: ' + (lenMap[laengde] || lenMap.mellem) + '. ' + emojiInstr
  ];

  if (brand.used) {
    lines.push(
      '',
      '--- BRAND fra ' + (brand.host || website) + ' — match dette look ---',
      profile.title ? 'Titel: ' + profile.title : '',
      profile.desc ? 'Beskrivelse: ' + profile.desc : '',
      (profile.colors && profile.colors.length) ? 'Brandfarver (hex): ' + profile.colors.join(', ') : '',
      (profile.fonts && profile.fonts.length) ? 'Skrifttyper: ' + profile.fonts.join(', ') : '',
      'Match brandet: sæt design.colors = {bg, ink, acc} i hex afledt af brandfarverne (mørk/rig bg, lys tekst med kontrast, accent fra brandet). design.font = "sans" hvis moderne, ellers "serif". Mangler brandfarver, lad colors være null og vælg en palette der rammer stemningen.'
    );
  }

  lines.push(
    '',
    'Lever som JSON:',
    '"posts": ' + antal + ' forskellige billedtekst-forslag på dansk, hver med 3-6 hashtags til sidst. Ingen pladsholdere som [navn].',
    '"photoQuery": 2-4 ENGELSKE søgeord til et stemnings-foto der matcher emnet (fx "latte coffee shop", "graduation celebration students", "autumn pumpkin table", "hair salon interior"). Konkret og visuelt.',
    '"variants": PRÆCIS 3 design-forslag der er TYDELIGT FORSKELLIGE fra hinanden i komposition, farve OG skrift — så brugeren kan vælge mellem 3 retninger. Samme budskab, men hvert forslag sit helt eget look.',
    '',
    'Hvert variant-objekt: {headline, emphasis, eyebrow, subline, badge, design:{style, palette, colors, motif, layout, font}}.',
    ' - headline: kort, slagkraftig (maks ca. 6 ord). emphasis: det vigtigste ord/ordpar fra headline (kopieret præcist). eyebrow: kort overlinje (maks 3-4 ord) eller tom. subline: kort støttelinje (maks ca. 8 ord). badge: kun ved konkret tilbud ("-20%") ellers tom.',
    ' - Gør de 3 markant forskellige, fx: (A) fuldt foto + elegant serif, centreret. (B) foto + bånd + fed moderne sans, venstrestillet. (C) ren typografi-plakat med en stærk farve + motiv. Variér ALTID style, palette og font mellem de tre.',
    '',
    'design.style — KOMPOSITION:',
    ' "photo" = fuldt baggrundsfoto med tekst ovenpå (flottest til steder, mad, produkter, mennesker, stemning, events).',
    ' "photoband" = foto øverst + farvet felt med tekst nederst (rent, moderne).',
    ' "poster" = intet foto, ren typografi på farve (til rene tilbud/beskeder, eller stærkt grafisk look).',
    'Mindst ét forslag bør være "photo".',
    '',
    'Tilladte paletter (vælg ÉN id, bruges når colors er null): ' + PALETTES.join(', ') + '.',
    'Tilladte motiver (lille grafisk element, vælg ÉN — eller "none"): ' + MOTIFS.join(', ') + '.',
    'Layout: "centered" eller "left". Font: "serif" (elegant/varm) eller "sans" (fed/moderne).',
    (brand.used ? 'BRAND: mindst ét forslag (gerne 2) skal bruge brandets farver via design.colors = {bg, ink, acc} i hex.' : ''),
    '',
    'Returnér KUN gyldig JSON i præcis dette format:',
    '{"posts":["...","..."],"photoQuery":"...","variants":[{"headline":"...","emphasis":"...","eyebrow":"","subline":"...","badge":"","design":{"style":"photo","palette":"forest","colors":null,"motif":"none","layout":"centered","font":"serif"}},{"headline":"...","emphasis":"...","eyebrow":"","subline":"...","badge":"","design":{"style":"photoband","palette":"mustard","colors":null,"motif":"sale","layout":"left","font":"sans"}},{"headline":"...","emphasis":"...","eyebrow":"","subline":"...","badge":"","design":{"style":"poster","palette":"berry","colors":null,"motif":"sparkle","layout":"centered","font":"serif"}}]}'
  );

  const user = lines.join('\n');

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [ { role:'system', content: sys }, { role:'user', content: user } ], temperature: 1.0, max_tokens: 1800, response_format: { type: 'json_object' } })
    });

    if (!dsRes.ok) {
      let detail = ''; try { detail = (await dsRes.text()).slice(0, 300); } catch (e) {}
      res.status(502).json({ error: 'DeepSeek svarede med en fejl (' + dsRes.status + ').', detail }); return;
    }

    const data = await dsRes.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    const result = extractContent(content);
    if (!result.variants.length || !result.posts.length) { res.status(502).json({ error: 'Kunne ikke læse forslagene fra AI. Prøv igen.' }); return; }

    // ---- Hent fotos (valgfrit, hvis Pexels-nøgle) ----
    const firstMotif = result.variants[0].design.motif;
    const query = result.photoQuery || PHOTO_FALLBACK[firstMotif] || (type + ' lifestyle');
    const ph = await fetchPhotos(query);
    result.photos = ph.map(o => o.disp);
    result.photosHi = ph.map(o => o.full);
    result.brand = brand;

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Uventet fejl på serveren.', detail: (err && err.message) || '' });
  }
}

// ---- Pexels foto-søgning ----
async function fetchPhotos(query) {
  const k = process.env.PEXELS_API_KEY;
  if (!k || !query) return [];
  try {
    const opts = { headers: { Authorization: k } };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(7000);
    const r = await fetch('https://api.pexels.com/v1/search?per_page=14&query=' + encodeURIComponent(query), opts);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.photos || []).slice(0, 12).map(p => {
      const s = p && p.src || {};
      const disp = s.large2x || s.large || s.original;
      const full = s.original || s.large2x || s.large;
      return disp ? { disp, full: full || disp } : null;
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ---- Brand-profil fra hjemmeside ----
export async function fetchBrandProfile(rawUrl) {
  let url = String(rawUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let u; try { u = new URL(url); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (/^(localhost$|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1)/.test(host)) return null;

  let html = '';
  try {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LusidioBot/1.0; +https://lusidio.com)' }, redirect: 'follow' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(7000);
    const r = await fetch(u.href, opts);
    if (!r.ok) return { error: true, host };
    html = (await r.text()).slice(0, 400000);
  } catch (e) { return { error: true, host }; }

  const pick = re => { const m = html.match(re); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  const title = pick(/<title[^>]*>([^<]{1,160})<\/title>/i);
  const desc  = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,300})["']/i);
  const themeColor = pick(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]{1,140}?)<\/h[12]>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6);
  const fonts = [...new Set([...html.matchAll(/font-family\s*:\s*([^;}<]+)/gi)].map(m => m[1].split(',')[0].replace(/['"]/g, '').trim()).filter(f => f && f.length < 40 && !/^(inherit|initial|unset|sans-serif|serif|monospace|cursive|system-ui|ui-|var\(|-apple)/i.test(f)))].slice(0, 6);

  const counts = {};
  const addHex = h => { h = h.toLowerCase(); counts[h] = (counts[h] || 0) + 1; };
  [...html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].forEach(m => { let h = m[1]; if (h.length === 3) h = h.split('').map(c => c + c).join(''); addHex('#' + h); });
  [...html.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)].forEach(m => { addHex('#' + [m[1], m[2], m[3]].map(n => Math.min(255, +n).toString(16).padStart(2, '0')).join('')); });
  const sl = hex => { const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; const s = mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn)); return { s, l }; };
  let colors = Object.entries(counts).map(([hex, c]) => ({ hex, c, ...sl(hex) })).filter(o => o.s > 0.12 && o.l > 0.07 && o.l < 0.93).sort((a, b) => b.c - a.c).slice(0, 8).map(o => o.hex);
  if (themeColor) { const t = themeColor.startsWith('#') ? themeColor : ('#' + themeColor); if (hex6(t)) colors.unshift(t.toLowerCase()); }
  colors = [...new Set(colors)].slice(0, 8);
  return { host, url: u.href, title, desc, headings, fonts, colors };
}

function extractContent(content) {
  const out = { posts:[], photoQuery:'', variants:[], photos:[], photosHi:[], brand:{ used:false, host:'' } };
  if (!content) return out;
  let txt = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;

  if (Array.isArray(obj.posts)) out.posts = obj.posts.map(String).filter(s => s.trim());
  if (typeof obj.photoQuery === 'string') out.photoQuery = obj.photoQuery.trim().slice(0, 80);

  function cleanDesign(d) {
    const out = { palette:'', colors:null, motif:'', layout:'', font:'', style:'' };
    if (!d || typeof d !== 'object') return out;
    if (PALETTES.indexOf(d.palette) >= 0) out.palette = d.palette;
    if (MOTIFS.indexOf(d.motif) >= 0) out.motif = d.motif;
    if (LAYOUTS.indexOf(d.layout) >= 0) out.layout = d.layout;
    if (FONTS.indexOf(d.font) >= 0) out.font = d.font;
    if (STYLES.indexOf(d.style) >= 0) out.style = d.style;
    if (d.colors && typeof d.colors === 'object' && hex6(d.colors.bg) && hex6(d.colors.ink) && hex6(d.colors.acc)) {
      out.colors = { bg: d.colors.bg.trim().toLowerCase(), ink: d.colors.ink.trim().toLowerCase(), acc: d.colors.acc.trim().toLowerCase() };
    }
    return out;
  }
  function cleanVariant(v) {
    if (!v || typeof v !== 'object') return null;
    const headline = typeof v.headline === 'string' ? v.headline.trim() : '';
    if (!headline) return null;
    return {
      headline,
      emphasis: typeof v.emphasis === 'string' ? v.emphasis.trim() : '',
      eyebrow:  typeof v.eyebrow === 'string' ? v.eyebrow.trim().slice(0, 40) : '',
      subline:  typeof v.subline === 'string' ? v.subline.trim() : '',
      badge:    typeof v.badge === 'string' ? v.badge.trim().slice(0, 16) : '',
      design:   cleanDesign(v.design)
    };
  }

  if (Array.isArray(obj.variants)) {
    obj.variants.slice(0, 3).forEach(v => { const c = cleanVariant(v); if (c) out.variants.push(c); });
  }
  // fallback: gammelt enkelt-format
  if (!out.variants.length && typeof obj.headline === 'string') {
    const c = cleanVariant(obj); if (c) out.variants.push(c);
    if (typeof obj.design === 'object' && obj.design && typeof obj.design.photoQuery === 'string' && !out.photoQuery) out.photoQuery = obj.design.photoQuery.trim().slice(0, 80);
  }
  return out;
}
