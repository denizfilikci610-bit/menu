// Vercel serverless-funktion — DeepSeek (tekst + stil/layout-valg) + brand-hentning + foto-søgning.
// API-nøglen ligger KUN her på serveren.
//
// Opsætning i Vercel → Settings → Environment Variables:
//   DEEPSEEK_API_KEY = <din DeepSeek-nøgle>       (påkrævet — teksten)
//   PEXELS_API_KEY   = <din gratis Pexels-nøgle>   (valgfri — rigtige baggrundsfotos, hent på pexels.com/api)
// Vælg alle miljøer → Save → Redeploy. Filen ligger i mappen /api → endepunkt: /api/opslag-tekst

const PALETTES = ['terra','cream','dark','forest','berry','navy','teal','blush','mustard','coral','sky','wine','rust','olive','ocean','lavender','peach','slate','cocoa','mint'];
const MOTIFS   = ['none','graduation','sale','coffee','food','leaf','snowflake','confetti','flower','heart','gift','sun','sparkle','scissors','dumbbell'];
// Komplette visuelle udtryk (frontend gengiver hver). AI vælger ÉN der passer til branchen.
const STYLES   = ['retro','rustik','skandi','brutal','editorial','cafe','duotone','gradient','stamp','neon','pop','lux','fresh','mono'];
// Opsætninger (frontend gengiver hver). AI vælger ÉN.
const LAYOUTS  = ['hero-bl','hero-center','hero-tr','band-bottom','band-top','split-left','split-right','card-bottom','poster','type','quote','framed'];

const PHOTO_FALLBACK = {
  graduation:'graduation celebration', sale:'shopping fashion store', coffee:'coffee shop latte',
  food:'restaurant food plate', leaf:'autumn nature leaves', snowflake:'cozy christmas winter',
  confetti:'celebration party confetti', flower:'fresh flowers bouquet', heart:'romantic candle dinner',
  gift:'gift wrapping present', sun:'summer beach sunshine', sparkle:'modern minimal studio',
  scissors:'hair salon styling', dumbbell:'gym fitness training', none:'minimal lifestyle interior'
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

  const sys = 'Du er en erfaren dansk social media-tekstforfatter OG art director for små danske virksomheder. ' +
    'Du gør to ting: (1) du følger brugerens brief HELT TROFAST og bygger opslaget om præcis det de beder om, og ' +
    '(2) du komponerer frit et flot, professionelt udtryk ved at vælge stil, layout, farver og foto — og du varierer bevidst, så forskellige emner og brancher får tydeligt forskellige udtryk. Du skriver naturligt, varmt dansk.';

  const lines = [
    'Lav et opslag til ' + (platMap[platform] || 'Facebook') + ' for en ' + type + '.',
    '',
    'Virksomhed: ' + (navn || 'ikke oplyst'),
    'Branche/type: ' + type,
    'BRIEF (det opslaget SKAL handle om): ' + emne,
    '',
    '=== TROFASTHED (vigtigst) ===',
    'Byg opslaget om præcis det briefen siger. Hvis briefen nævner et produkt, en vare, en ydelse eller et emne, SKAL det være i fokus (overskrift + foto).',
    'Tal, procenter, priser, datoer, klokkeslæt, navne og tekst i "anførselstegn" gengives PRÆCIST og må ALDRIG ændres, rundes eller opfindes.',
    'Find et evt. tilbud i briefen (fx "21% rabat", "spar 50", "2 for 1", "199 kr", "tilbud", "udsalg") og sæt det kort i "badge" med tallet uændret (fx "21% RABAT", "−21%", "SPAR 50%", "199 KR").',
    'Du må gøre overskrift og underlinje skarpe og sælgende, men KUN ud fra fakta i briefen — opfind aldrig nye tilbud, tal, datoer eller løfter.',
    'Eksempel: brief "jeg vil have et skønhedsprodukt i fokus, 21% rabat på skønhedsprodukter" → overskrift om skønhedsproduktet, badge "21% RABAT", photoQuery om skønhedsprodukt/kosmetik.',
    '',
    'Tone og længde på billedteksten: ' + (lenMap[laengde] || lenMap.mellem) + '. ' + emojiInstr
  ];

  if (brand.used) {
    lines.push(
      '',
      '--- BRAND fra ' + (brand.host || website) + ' — match dette look ---',
      profile.title ? 'Titel: ' + profile.title : '',
      profile.desc ? 'Beskrivelse: ' + profile.desc : '',
      (profile.colors && profile.colors.length) ? 'Brandfarver (hex): ' + profile.colors.join(', ') : '',
      'Match brandet: sæt design.colors = {bg, ink, acc} i hex afledt af brandfarverne (mørk/rig bg, lys tekst med god kontrast, accent fra brandet). Mangler brandfarver, lad colors være null.'
    );
  }

  lines.push(
    '',
    '=== KOMPOSITION (vælg frit, og variér efter branche) ===',
    'Vælg ÉT design.style — det visuelle udtryk der passer bedst til branche og budskab:',
    '  retro = varm 70er, fed; rustik = kraftpapir/håndlavet, café/bageri/gård; skandi = luftig minimal, klinik/rådgivning;',
    '  brutal = sort/hvid fed, ungt/streetwear; editorial = elegant magasin, mode/interiør; cafe = mørk kridttavle, café/restaurant/bar;',
    '  duotone = foto med to-farve + fed tekst, event/musik; gradient = moderne farveforløb, app/tech; stamp = vintage stempel, håndværk/øl/kaffe;',
    '  neon = mørk med glød, natteliv/gaming; pop = friske farver/runde, leg/børn/slik; lux = sort+guld premium, smykker/skønhed/restaurant;',
    '  fresh = ren blå/grøn sans, sundhed/professionel; mono = monokrom høj kontrast, stilrent/B2B.',
    'Vælg ÉT design.layout (opsætning): ' + LAYOUTS.join(', ') + '. (hero* = foto m. tekst; band* = farvefelt + foto; split* = halvt foto; card = tekstkort; poster/type/quote = uden foto; framed = ramme.)',
    'Vælg en palette ELLER konkrete farver, et motiv, og et foto-søgeord — alt skal passe til stil + branche.',
    '',
    '=== LEVÉR SOM JSON ===',
    '"headline": kort, slagkraftig overskrift om briefens emne (maks ca. 6 ord). Ingen hashtags/emojis.',
    '"emphasis": det vigtigste ord/ordpar fra headline (kopieret PRÆCIST som i headline). Tom hvis intet.',
    '"eyebrow": meget kort overlinje (maks 3-4 ord, fx "NYHED", "KUN I JUNI"). Tom hvis ligegyldig.',
    '"subline": kort støttelinje (maks ca. 9 ord) — gerne hvor tilbuddet/detaljen nævnes.',
    '"badge": tilbuddet kort med tallet uændret, ellers tom.',
    '"posts": ' + antal + ' forskellige danske billedtekster, hver med 3-6 hashtags til sidst. Ingen pladsholdere.',
    '"design": { "style": <én af: ' + STYLES.join(', ') + '>, "layout": <én af layouts>, "palette": <én af: ' + PALETTES.join(', ') + '>, "colors": null ELLER {bg,ink,acc} i hex, "motif": <én af: ' + MOTIFS.join(', ') + '>, "photoQuery": "2-4 engelske, konkrete, visuelle søgeord der matcher briefens emne" }',
    '',
    'Returnér KUN gyldig JSON i præcis dette format:',
    '{"headline":"...","emphasis":"...","eyebrow":"","subline":"...","badge":"","posts":["...","..."],"design":{"style":"editorial","layout":"hero-bl","palette":"berry","colors":null,"motif":"none","photoQuery":"..."}}'
  );

  const user = lines.join('\n');

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [ { role:'system', content: sys }, { role:'user', content: user } ], temperature: 1.0, max_tokens: 1700, response_format: { type: 'json_object' } })
    });

    if (!dsRes.ok) {
      let detail = ''; try { detail = (await dsRes.text()).slice(0, 300); } catch (e) {}
      res.status(502).json({ error: 'DeepSeek svarede med en fejl (' + dsRes.status + ').', detail }); return;
    }

    const data = await dsRes.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    const result = extractContent(content);
    if (!result.posts.length || !result.headline) { res.status(502).json({ error: 'Kunne ikke læse forslaget fra AI. Prøv igen.' }); return; }

    const query = result.design.photoQuery || PHOTO_FALLBACK[result.design.motif] || (type + ' lifestyle');
    const ph = await fetchPhotos(query);
    result.photos = ph.map(o => o.disp);
    result.photosHi = ph.map(o => o.full);
    result.brand = brand;

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Uventet fejl på serveren.', detail: (err && err.message) || '' });
  }
}

// ---- Pexels foto-søgning (returnerer visnings- + højopløst URL) ----
async function fetchPhotos(query) {
  const k = process.env.PEXELS_API_KEY;
  if (!k || !query) return [];
  try {
    const opts = { headers: { Authorization: k } };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(7000);
    const r = await fetch('https://api.pexels.com/v1/search?per_page=15&query=' + encodeURIComponent(query), opts);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.photos || []).slice(0, 12).map(p => {
      const s = (p && p.src) || {};
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

  const counts = {};
  const addHex = h => { h = h.toLowerCase(); counts[h] = (counts[h] || 0) + 1; };
  [...html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].forEach(m => { let h = m[1]; if (h.length === 3) h = h.split('').map(c => c + c).join(''); addHex('#' + h); });
  [...html.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)].forEach(m => { addHex('#' + [m[1], m[2], m[3]].map(n => Math.min(255, +n).toString(16).padStart(2, '0')).join('')); });
  const sl = hex => { const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; const s = mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn)); return { s, l }; };
  let colors = Object.entries(counts).map(([hex, c]) => ({ hex, c, ...sl(hex) })).filter(o => o.s > 0.12 && o.l > 0.07 && o.l < 0.93).sort((a, b) => b.c - a.c).slice(0, 8).map(o => o.hex);
  if (themeColor) { const t = themeColor.startsWith('#') ? themeColor : ('#' + themeColor); if (hex6(t)) colors.unshift(t.toLowerCase()); }
  colors = [...new Set(colors)].slice(0, 8);
  return { host, url: u.href, title, desc, colors };
}

function extractContent(content) {
  const out = { headline:'', emphasis:'', eyebrow:'', subline:'', badge:'', posts:[], design:{ style:'', layout:'', palette:'', colors:null, motif:'', photoQuery:'' }, photos:[], photosHi:[], brand:{ used:false, host:'' } };
  if (!content) return out;
  let txt = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;

  if (typeof obj.headline === 'string') out.headline = obj.headline.trim();
  if (typeof obj.emphasis === 'string') out.emphasis = obj.emphasis.trim();
  if (typeof obj.eyebrow === 'string')  out.eyebrow  = obj.eyebrow.trim().slice(0, 40);
  if (typeof obj.subline === 'string')  out.subline  = obj.subline.trim();
  if (typeof obj.badge === 'string')    out.badge    = obj.badge.trim().slice(0, 18);
  if (Array.isArray(obj.posts)) out.posts = obj.posts.map(String).filter(s => s.trim());
  const d = obj.design && typeof obj.design === 'object' ? obj.design : {};
  if (STYLES.indexOf(d.style) >= 0) out.design.style = d.style;
  if (LAYOUTS.indexOf(d.layout) >= 0) out.design.layout = d.layout;
  if (PALETTES.indexOf(d.palette) >= 0) out.design.palette = d.palette;
  if (MOTIFS.indexOf(d.motif) >= 0) out.design.motif = d.motif;
  if (typeof d.photoQuery === 'string') out.design.photoQuery = d.photoQuery.trim().slice(0, 80);
  if (d.colors && typeof d.colors === 'object' && hex6(d.colors.bg) && hex6(d.colors.ink) && hex6(d.colors.acc)) {
    out.design.colors = { bg: d.colors.bg.trim().toLowerCase(), ink: d.colors.ink.trim().toLowerCase(), acc: d.colors.acc.trim().toLowerCase() };
  }
  return out;
}
