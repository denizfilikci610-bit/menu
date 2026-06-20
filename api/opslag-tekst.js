// Vercel serverless-funktion — DeepSeek (tekst + stil/layout-valg) + brand-hentning + foto-søgning.
// API-nøglen ligger KUN her på serveren.
//
// Opsætning i Vercel → Settings → Environment Variables:
//   DEEPSEEK_API_KEY = <din DeepSeek-nøgle>       (påkrævet — teksten/designet)
//   PEXELS_API_KEY   = <din gratis Pexels-nøgle>   (valgfri — rigtige baggrundsfotos, hent på pexels.com/api)
//   GEMINI_API_KEY   = <din gratis Gemini-nøgle>   (valgfri — "match en stil": ser det uploadede billede og KOPIERER layoutet. Uden den bruges palet/heuristik som før.)
//   VISION_MODEL     = gemini-2.5-flash            (valgfri — kan sættes til fx gemini-3.5-flash for skarpere layout-aflæsning)
//   VISION_REFINE    = 1                           (valgfri — 1/standard = ekstra selv-rettende runde for tættere layout-kopi (2 kald pr. billede). Sæt 0 for kun ét kald.)
//   VISION_BASE_URL  = (tom)                        (valgfri — lad være med at sætte den for Gemini. Standard er Geminis native API med håndhævet JSON. Sæt kun hvis du vil bruge en ANDEN OpenAI-kompatibel vision-udbyder.)
//   SUPABASE_URL                = https://<projekt>.supabase.co   (til maaneds-graensen: 3 opslag/login-bruger/maaned)
//   SUPABASE_SERVICE_ROLE_KEY   = <din HEMMELIGE service-role/secret-noegle>  (HEMMELIG — kun her i Vercel, ALDRIG i frontend)
//                                                 Er de ikke sat, springes maaneds-graensen over og endpointet koerer frit.
// Vælg alle miljøer → Save → Redeploy. Filen ligger i mappen /api → endepunkt: /api/opslag-tekst

const PALETTES = ['terra','cream','dark','forest','berry','navy','teal','blush','mustard','coral','sky','wine','rust','olive','ocean','lavender','peach','slate','cocoa','mint','charcoal','sand','plum','sage','ruby','denim','midnight','clay'];
const MOTIFS   = ['none','graduation','sale','coffee','food','leaf','snowflake','confetti','flower','heart','gift','sun','sparkle','scissors','dumbbell'];
// Komplette visuelle udtryk (frontend gengiver hver). AI vælger ÉN der passer til branchen.
const STYLES   = ['retro','rustik','skandi','brutal','editorial','cafe','duotone','gradient','stamp','neon','pop','lux','fresh','mono','noir','vogue','impact','candy','terminal','press','bloom','deco','zen','sunset'];
// Opsætninger (frontend gengiver hver). AI vælger ÉN.
const LAYOUTS  = ['hero-bl','hero-center','hero-top','hero-tr','spotlight','hero-left','hero-right','band-top','band-bottom','band-mid','split-left','split-right','split-h-top','split-h-bottom','sidebar-r','card-bottom','card-center','corner','postcard','framed','poster','type','quote','ticket','minimal','duo-v','duo-h','grid-4','showcase','collage-3','mosaic','filmstrip','triptych'];

const PHOTO_FALLBACK = {
  graduation:'graduation celebration', sale:'shopping fashion store', coffee:'coffee shop latte',
  food:'restaurant food plate', leaf:'autumn nature leaves', snowflake:'cozy christmas winter',
  confetti:'celebration party confetti', flower:'fresh flowers bouquet', heart:'romantic candle dinner',
  gift:'gift wrapping present', sun:'summer beach sunshine', sparkle:'modern minimal studio',
  scissors:'hair salon styling', dumbbell:'gym fitness training', none:'minimal lifestyle interior'
};

const hex6 = h => typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h.trim());

// ---- Maaneds-graense: tael AI-genereringer pr. login-bruger pr. kalendermaaned i Supabase. ----
// Haandhaeves server-side med service-role-noeglen (gaar uden om RLS). Fail-safe: mangler URL/noegle,
// er token anonym/ugyldig, eller fejler et kald -> saa taelles der ikke, og generering blokeres ALDRIG.
// SUPABASE_SERVICE_ROLE_KEY er HEMMELIG: kun som Environment Variable i Vercel, ALDRIG i frontend.
const MONTHLY_LIMIT = 3;
const PAID_LIMIT = 100;   // betalende: "ubegraenset" med hoejt internt loft (beskytter DeepSeek-regningen)
function currentPeriod() { return new Date().toISOString().slice(0, 7); }   // 'YYYY-MM' (UTC) -> nulstilles den 1.
function sbBase() { const u = process.env.SUPABASE_URL; return u ? u.replace(/\/$/, '') : ''; }
async function getUserId(req) {
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc) return null;
  const auth = String(req.headers['authorization'] || req.headers['Authorization'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  try {
    const r = await fetch(base + '/auth/v1/user', { headers: { apikey: svc, Authorization: 'Bearer ' + m[1] } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) ? u.id : null;
  } catch (e) { return null; }
}
async function getUsage(userId, period) {
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc) return -1;
  try {
    const q = base + '/rest/v1/usage_counters?user_id=eq.' + encodeURIComponent(userId) + '&period=eq.' + encodeURIComponent(period) + '&select=count';
    const r = await fetch(q, { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
    if (!r.ok) return -1;
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && Number.isFinite(Number(rows[0].count))) return Number(rows[0].count);
    return 0;
  } catch (e) { return -1; }
}
async function bumpUsage(userId, period, newCount) {
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc) return;
  try {
    await fetch(base + '/rest/v1/usage_counters', {
      method: 'POST',
      headers: { apikey: svc, Authorization: 'Bearer ' + svc, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, period: period, count: newCount, updated_at: new Date().toISOString() })
    });
  } catch (e) { /* best-effort */ }
}

async function isPaidUser(userId) {
  const base = sbBase(), svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc || !userId) return false;
  try {
    const q = base + '/rest/v1/subscriptions?user_id=eq.' + encodeURIComponent(userId) + '&select=status,current_period_end';
    const r = await fetch(q, { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
    if (!r.ok) return false;
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && rows[0].status === 'active') {
      const end = rows[0].current_period_end ? new Date(rows[0].current_period_end).getTime() : null;
      return (!end || end > Date.now());
    }
    return false;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Kun POST er tilladt.' }); return; }
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) { res.status(500).json({ error: 'Serveren mangler DEEPSEEK_API_KEY. Tilføj den i Vercel og deploy igen.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // Frit design (scene-motor): helt egen prompt + skema
  if (String(body.mode || '').toLowerCase() === 'scene') { return handleSceneRequest(body, res, key); }

  const navn     = String(body.navn || '').slice(0, 120);
  const type     = String(body.type || '').slice(0, 120) || 'lille virksomhed';
  let website    = String(body.website || '').slice(0, 300);
  const emne     = String(body.emne || '').slice(0, 800);
  if (!website.trim()) { const wm = emne.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:dk|com|net|org|eu|nu|io|shop|store|se|no)\b/i); if (wm) website = wm[0]; }
  const platform = String(body.platform || 'facebook');
  const laengde  = String(body.laengde || 'mellem');
  const emoji    = String(body.emoji || 'med');
  let   antal    = parseInt(body.antal, 10);
  if (!(antal >= 1 && antal <= 5)) antal = 3;

  if (!emne.trim()) { res.status(400).json({ error: 'Skriv hvad opslaget skal handle om.' }); return; }

  // ---- Maaneds-graense: max 3 AI-opslag pr. login-bruger pr. kalendermaaned (server-haandhaevet, fail-safe). ----
  const usagePeriod = currentPeriod();
  const usageUserId = await getUserId(req);          // null = anonym/ugyldig/ikke konfigureret -> tael ikke (fri generering)
  const usagePaid = usageUserId ? await isPaidUser(usageUserId) : false;
  const monthlyLimit = usagePaid ? PAID_LIMIT : MONTHLY_LIMIT;
  let usageUsed = 0;
  if (usageUserId) {
    usageUsed = await getUsage(usageUserId, usagePeriod);   // -1 = fejl -> tael ikke (bloker aldrig)
    if (usageUsed >= 0 && usageUsed >= monthlyLimit) {
      res.status(429).json({ error: usagePaid ? 'Du har nået din grænse for denne måned. Skriv til os, hvis du har brug for mere.' : ('Du har brugt dine ' + MONTHLY_LIMIT + ' gratis opslag denne måned. Der kommer nye den 1. — eller opgrader for ubegrænset.'), limitReached: true, usage: { used: usageUsed, limit: monthlyLimit, remaining: 0 } });
      return;
    }
  }

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
  const platGuide = {
    facebook: 'PLATFORM Facebook: alsidigt og fællesskabsorienteret. Vælg stil og layout efter branchen; teksten må gerne være informativ.',
    instagram: 'PLATFORM Instagram: visuelt og energisk — FOTOET er i fokus. Vælg et stærkt fotolayout (hero-bl/hero-center/spotlight/framed/card-bottom/duo-v/collage-3/mosaic/showcase), en fed/farverig stil (impact/candy/pop/sunset/neon/retro/bloom/gradient/duotone/brutal) og en levende palette. Hold teksten KORT og fængende: kort overskrift, kort eller tom underlinje.',
    linkedin: 'PLATFORM LinkedIn: rent, professionelt og troværdigt. Vælg en afdæmpet stil (skandi/editorial/mono/vogue/zen/deco/lux/noir/terminal/press), en dæmpet/korporat palette (navy/slate/denim/midnight/charcoal/sage/forest/ocean/cocoa/cream) og et roligt layout (poster/minimal/split-left/card-bottom/sidebar-r/band-bottom/quote). INGEN skrigende farver eller pynt. Teksten må gerne være lidt længere og indsigtsfuld.'
  };

  const sys = 'Du er en erfaren dansk social media-tekstforfatter OG art director for små danske virksomheder. ' +
    'Du gør to ting: (1) du følger brugerens brief HELT TROFAST og bygger opslaget om præcis det de beder om, og ' +
    '(2) du komponerer frit et flot, professionelt udtryk ved at vælge stil, layout, farver og foto — og du varierer bevidst, så forskellige emner og brancher får tydeligt forskellige udtryk. Du skriver naturligt, varmt dansk.';

  const lines = [
    'Lav et opslag til ' + (platMap[platform] || 'Facebook') + '.',
    '',
    'Brugeren har skrevet ÉN fri besked der både fortæller hvem virksomheden er OG hvad opslaget skal handle om. Læs den grundigt og find SELV: virksomhedens navn (hvis nævnt), branche/type, og hvad opslaget skal handle om. Tilpas stil, farver og foto til den branche du udleder.',
    '',
    'BRUGERENS BESKED: ' + emne,
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
    (platGuide[platform] || platGuide.facebook),
    'Vælg ÉT design.style — det visuelle udtryk der passer bedst til branche og budskab:',
    '  retro = varm 70er, fed; rustik = kraftpapir/håndlavet, café/bageri/gård; skandi = luftig minimal, klinik/rådgivning;',
    '  brutal = sort/hvid fed, ungt/streetwear; editorial = elegant magasin, mode/interiør; cafe = mørk kridttavle, café/restaurant/bar;',
    '  duotone = foto med to-farve + fed tekst, event/musik; gradient = moderne farveforløb, app/tech; stamp = vintage stempel, håndværk/øl/kaffe;',
    '  neon = mørk med glød, natteliv/gaming; pop = friske farver/runde, leg/børn/slik; lux = sort+guld premium, smykker/skønhed/restaurant;',
    '  fresh = ren blå/grøn sans, sundhed/professionel; mono = monokrom høj kontrast, stilrent/B2B.',
    'Vælg ÉT design.layout (opsætning): ' + LAYOUTS.join(', ') + '.',
    '  Ét foto: hero-bl/hero-center/hero-top/hero-tr/hero-left/hero-right/spotlight (tekst på foto), band-top/band-bottom/band-mid (farvefelt+foto), split-left/split-right/split-h-top/split-h-bottom (halvt foto), sidebar-r/card-bottom/card-center/corner (tekst i felt på foto), postcard, framed.',
    '  Uden foto: poster, type, quote, ticket (kupon), minimal.',
    '  FLERE fotos: duo-v/duo-h (2 fotos), collage-3/mosaic/filmstrip/triptych (3 fotos), grid-4/showcase (4 fotos). Vælg KUN disse hvis emnet passer til flere billeder (fx menu, galleri, før/efter, kollektion, events).',
    'Vælg en palette ELLER konkrete farver, et motiv, og et foto-søgeord — alt skal passe til stil + branche.',
    '',
    '=== LEVÉR SOM JSON ===',
    '"headline": kort, slagkraftig overskrift om briefens emne (maks ca. 6 ord). Ingen hashtags/emojis.',
    '"emphasis": det vigtigste ord/ordpar fra headline (kopieret PRÆCIST som i headline). Tom hvis intet.',
    '"eyebrow": meget kort overlinje (maks 3-4 ord, fx "NYHED", "KUN I JUNI"). Tom hvis ligegyldig.',
    '"subline": kort støttelinje (maks ca. 9 ord) — gerne hvor tilbuddet/detaljen nævnes.',
    '"badge": tilbuddet kort med tallet uændret, ellers tom.',
    '"brandName": virksomhedens navn PRÆCIST som det skal stå på opslaget — find det i beskeden. Tom streng "" hvis intet navn er nævnt.',
    '"posts": ' + antal + ' forskellige danske billedtekster, hver med 3-6 hashtags til sidst. Ingen pladsholdere.',
    '"design": { "style": <én af: ' + STYLES.join(', ') + '>, "layout": <én af layouts>, "palette": <én af: ' + PALETTES.join(', ') + '>, "colors": null ELLER {bg,ink,acc} i hex, "motif": <én af: ' + MOTIFS.join(', ') + '>, "photoQuery": "2-4 engelske, konkrete, visuelle søgeord der matcher briefens emne" }',
    '',
    'Returnér KUN gyldig JSON i præcis dette format:',
    '{"headline":"...","emphasis":"...","eyebrow":"","subline":"...","badge":"","brandName":"","posts":["...","..."],"design":{"style":"editorial","layout":"hero-bl","palette":"berry","colors":null,"motif":"none","photoQuery":"..."}}'
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

    if (usageUserId && usageUsed >= 0) {               // tael KUN vellykkede genereringer, kun login-brugere
      usageUsed = usageUsed + 1;
      await bumpUsage(usageUserId, usagePeriod, usageUsed);
      result.usage = { used: usageUsed, limit: monthlyLimit, remaining: Math.max(0, monthlyLimit - usageUsed) };
    }
    result.paid = usagePaid;

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
  const out = { headline:'', emphasis:'', eyebrow:'', subline:'', badge:'', brandName:'', posts:[], design:{ style:'', layout:'', palette:'', colors:null, motif:'', photoQuery:'' }, photos:[], photosHi:[], brand:{ used:false, host:'' } };
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
  if (typeof obj.brandName === 'string') out.brandName = obj.brandName.trim().slice(0, 40);
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

// ============================================================
//  FRIT DESIGN — scene-motor (brugeren beskriver, AI tegner)
// ============================================================
const SCENE_FONTS = ['fraunces','playfair','dmserif','anton','bebas','archivo','oswald','poppins','montserrat','grotesk','caveat','mono2','cormorant','lora','baskerville','abril','slab','inter','worksans','manrope','dmsans','outfit','sora','quicksand','barlow','teko','righteous','dancing','pacifico','lobster'];
const SCENE_ICONS = ['coffee','food','leaf','flower','heart','gift','sun','sparkle','snowflake','confetti','scissors','dumbbell','graduation','sale','star'];

function numClamp(v, a, b, d) { const n = parseFloat(v); return isFinite(n) ? Math.max(a, Math.min(b, n)) : d; }
function safeColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 40);
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\([0-9.,\s%]+\)$/i.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s;
  return null;
}
function safeFill(v) {
  if (typeof v === 'string') return safeColor(v);
  if (v && typeof v === 'object') {
    const type = v.type === 'radial' ? 'radial' : 'linear';
    const stops = Array.isArray(v.stops) ? v.stops.map(safeColor).filter(Boolean).slice(0, 6) : [];
    if (stops.length < 2) return null;
    const out = { type, stops };
    if (type === 'linear') out.angle = numClamp(v.angle, 0, 360, 180);
    else { out.cx = numClamp(v.cx, 0, 100, 50); out.cy = numClamp(v.cy, 0, 100, 40); }
    return out;
  }
  return null;
}

// Forsøg at redde en AFKORTET JSON (afbrudt midt i): luk åbne strenge/arrays/objekter, klip evt. sidste halve element væk.
function repairTruncatedJson(txt) {
  const s = String(txt || '').indexOf('{');
  if (s < 0) return null;
  const body = String(txt).slice(s);
  function closeUp(str) {
    let inStr = false, esc = false; const stack = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else { if (ch === '"') inStr = true; else if (ch === '{') stack.push('}'); else if (ch === '[') stack.push(']'); else if (ch === '}' || ch === ']') stack.pop(); }
    }
    let out = str;
    if (inStr) out += '"';
    out = out.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '').replace(/:\s*$/, ': null');
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
    return out;
  }
  try { return JSON.parse(closeUp(body)); } catch (e) {}
  // klip til sidste komplette '}' og luk resten
  const lb = body.lastIndexOf('}');
  if (lb > 0) { try { return JSON.parse(closeUp(body.slice(0, lb + 1))); } catch (e2) {} }
  return null;
}

function extractScene(content) {
  let txt = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(txt); } catch (e) {
    const s = txt.indexOf('{');
    if (s >= 0) {
      let depth = 0, inStr = false, escd = false, end = -1;
      for (let i = s; i < txt.length; i++) {
        const ch = txt[i];
        if (inStr) { if (escd) escd = false; else if (ch === '\\') escd = true; else if (ch === '"') inStr = false; }
        else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } } }
      }
      if (end > s) { try { obj = JSON.parse(txt.slice(s, end + 1)); } catch (e2) {} }
      if (!obj) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e3) {} } }
      if (!obj) { obj = repairTruncatedJson(txt); }
    }
  }
  if (!obj || typeof obj !== 'object') return { scene: null, photoQuery: '' };
  const sc = (obj.scene && typeof obj.scene === 'object') ? obj.scene : obj;
  const out = { ar: numClamp(sc.ar, 0.4, 4, 1), bg: '#1c1a17', els: [] };
  const bg = safeFill(sc.bg); if (bg) out.bg = bg;
  const els = Array.isArray(sc.els) ? sc.els : [];
  els.slice(0, 60).forEach(e => {
    if (!e || typeof e !== 'object') return;
    const t = ['text','image','rect','ellipse','line','icon','path'].indexOf(e.t) >= 0 ? e.t : 'rect';
    const o = { t, x: numClamp(e.x, -60, 160, 0), y: numClamp(e.y, -60, 160, 0), w: numClamp(e.w, 0.5, 220, 20), h: numClamp(e.h, 0.5, 220, 12) };
    if (e.z != null) o.z = Math.round(numClamp(e.z, 0, 999, 1));
    if (e.rot != null && e.rot !== 0) o.rot = numClamp(e.rot, -180, 180, 0);
    if (e.op != null) o.op = numClamp(e.op, 0, 1, 1);
    if (e.shadow === true) o.shadow = true;
    const fill = safeFill(e.fill); if (fill) o.fill = fill;
    const stroke = safeColor(e.stroke); if (stroke) { o.stroke = stroke; o.sw = numClamp(e.sw, 0.1, 30, 1); }
    if (e.r != null) o.r = numClamp(e.r, 0, 90, 0);
    if (t === 'text') {
      o.str = String(e.str == null ? '' : e.str).replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
      o.font = SCENE_FONTS.indexOf(e.font) >= 0 ? e.font : 'grotesk';
      o.fs = numClamp(e.fs, 0.5, 60, 7);
      o.fw = Math.round(numClamp(e.fw, 100, 900, 600));
      o.color = safeColor(e.color) || '#ffffff';
      o.align = ['l','c','r'].indexOf(e.align) >= 0 ? e.align : 'l';
      o.va = ['t','m','b'].indexOf(e.va) >= 0 ? e.va : 'm';
      if (e.lh != null) o.lh = numClamp(e.lh, 0.7, 3, 1.06);
      if (e.ls != null) o.ls = numClamp(e.ls, -0.1, 1, 0);
      if (e.up === true) o.up = true;
      if (e.italic === true) o.italic = true;
      if (e.pad != null) o.pad = numClamp(e.pad, 0, 30, 0);
    } else if (t === 'image') {
      o.src = e.src === 'upload' ? 'upload' : 'photo';
      o.fit = e.fit === 'contain' ? 'contain' : 'cover';
    } else if (t === 'icon') {
      o.icon = SCENE_ICONS.indexOf(e.icon) >= 0 ? e.icon : 'sparkle';
      const col = safeColor(e.color); if (col) o.color = col; else if (!o.fill) o.color = '#ffffff';
    } else if (t === 'path') {
      o.d = String(e.d || '').replace(/[^0-9a-zA-Z\s,.\-]/g, ' ').slice(0, 4000);
      if (typeof o.fill !== 'string') { if (!o.stroke) o.fill = '#ffffff'; else delete o.fill; }
    }
    out.els.push(o);
  });
  const pq = typeof obj.photoQuery === 'string' ? obj.photoQuery.trim().slice(0, 80) : '';
  return { scene: out.els.length ? out : null, photoQuery: pq };
}

const SCENE_FEWSHOT = '{"scene":{"ar":1,"bg":{"type":"linear","stops":["#103a2e","#07221a"],"angle":155},"els":[{"t":"rect","x":-4,"y":-4,"w":58,"h":108,"fill":"#0c4a39","op":0.5,"z":0},{"t":"image","x":50,"y":0,"w":50,"h":100,"src":"photo","fit":"cover","z":1},{"t":"rect","x":50,"y":0,"w":50,"h":100,"fill":{"type":"linear","stops":["#07221a00","#07221acc"],"angle":90},"z":2},{"t":"text","x":8,"y":12,"w":40,"h":7,"str":"NYÅBNING I HILLERØD","font":"bebas","fs":3.6,"color":"#e9c987","up":true,"ls":0.18,"va":"t","z":4},{"t":"text","x":8,"y":21,"w":44,"h":30,"str":"Smag forskellen","font":"fraunces","fs":12.5,"fw":900,"color":"#fdf6ea","lh":1.0,"va":"t","z":4},{"t":"rect","x":8,"y":53,"w":14,"h":0.9,"fill":"#e9c987","z":4},{"t":"text","x":8,"y":58,"w":40,"h":16,"str":"Frisk kaffe, hjemmebag og en plads i solen — hver morgen fra kl. 7.","font":"grotesk","fs":3.3,"fw":500,"color":"#cfe0d7","lh":1.35,"va":"t","z":4},{"t":"ellipse","x":66,"y":62,"w":26,"h":26,"fill":"#e9c987","z":5,"shadow":true},{"t":"text","x":66,"y":62,"w":26,"h":26,"str":"−20%","font":"anton","fs":6.5,"color":"#07221a","align":"c","va":"m","z":6},{"t":"icon","x":8,"y":88,"w":6,"h":6,"icon":"coffee","fill":"#e9c987","z":4},{"t":"text","x":16,"y":88,"w":34,"h":6,"str":"CAFÉ BELLA","font":"montserrat","fs":2.8,"fw":700,"color":"#b9cabf","up":true,"ls":0.14,"va":"m","z":4}]},"photoQuery":"coffee cup latte wooden table"}';

const SCENE_SYS = [
  'Du er en prisvindende art director der laver opslag til sociale medier i topkvalitet. Du svarer KUN med ét JSON-objekt der beskriver et komplet, professionelt design som en "scene", som motoren gengiver PRÆCIST. Tænk som en rigtig designer: ét stærkt fokuspunkt, klart hierarki, gennemtænkt komposition og en sammenhængende palet. Brugeren har fuld frihed — følg deres ønske nøjagtigt.',
  '',
  'KOORDINATSYSTEM:',
  '- x, y, w, h er PROCENT af lærredet (0-100). x,y = elementets øverste venstre hjørne. w = bredde, h = højde.',
  '- fs (skriftstørrelse), sw (stregbredde), r (radius), pad er i "cqw" = procent af lærredets BREDDE. fs:10 ≈ teksthøjde 10% af bredden.',
  '- z = lag (højere = forrest). rot = grader. op = 0-1. shadow:true = blød skygge.',
  '',
  'OUTPUT (KUN dette JSON, ingen markdown, ingen forklaring):',
  '{ "scene": { "ar": <height/width: 1=kvadrat, 1.25=stående 4:5, 1.7778=story 9:16>, "bg": <"#hex" ELLER {"type":"linear","stops":["#hex","#hex"],"angle":<grader>} ELLER {"type":"radial","stops":[...],"cx":50,"cy":40}>, "els": [ <element>, ... ] }, "photoQuery": <"2-4 konkrete engelske søgeord hvis designet bruger et foto, ellers \\"\\""> }',
  '',
  'ELEMENT-TYPER (alle har x,y,w,h + valgfri z, rot, op, shadow):',
  '- text:  {"t":"text","str":...,"font":<id>,"fs":<cqw>,"fw":<400-900>,"color":"#hex","align":"l|c|r","va":"t|m|b","lh":<fx 1.05>,"ls":<em fx 0.04>,"up":<true=VERSALER>,"italic":<bool>,"fill":<valgfri baggrund til badge/label>,"r":<radius>,"pad":<cqw>}',
  '- image: {"t":"image","src":"photo","fit":"cover|contain","r":<radius>}  // stock-foto fra photoQuery',
  '- rect:  {"t":"rect","fill":<"#hex"/gradient>,"r":<radius>,"stroke":"#hex","sw":<cqw>}  // streger = lav h',
  '- ellipse: {"t":"ellipse","fill":...}  // cirkel: sæt w og h ens',
  '- icon:  {"t":"icon","icon":<id>,"fill":"#hex"}',
  '- path:  {"t":"path","d":<SVG path i 0..100 viewBox>,"fill":<"#hex"/"none">,"stroke":"#hex","sw":<cqw>}  // enhver vektorform',
  '',
  'FONT-ID: seriffer: fraunces, playfair, dmserif, cormorant, lora, baskerville, abril; slab: slab; sans: poppins, montserrat, grotesk, inter, worksans, manrope, dmsans, outfit, sora, quicksand; fede/smalle display: anton, bebas, archivo, oswald, barlow, teko, righteous; håndskrift/script: caveat, dancing, pacifico, lobster; monospace: mono2.',
  'IKON-ID: coffee, food, leaf, flower, heart, gift, sun, sparkle, snowflake, confetti, scissors, dumbbell, graduation, sale, star.',
  '',
  'TYPOGRAFI (vigtigt):',
  '- Par ÉN display-skrift (overskrift) med ÉN ren sans (brødtekst). Bland aldrig to seriffer. caveat kun til små accenter.',
  '- Størrelsesforhold: overskrift fs 11-18, underoverskrift 4.5-7, brødtekst 3-4.5, eyebrow/brand 2.8-3.8. Overskriften skal være 3-5× større end brødteksten.',
  '- lh: display 0.95-1.06, brødtekst 1.3-1.45. Versaler (up:true) til eyebrow/brand/badge med ls 0.12-0.22.',
  '',
  'STØRRELSE SÅ TEKST PASSER (undgå overløb): et tekstfelt med bredde w rummer ca. (w / (fs × 0.55)) tegn pr. linje. Vælg fs og w så overskriften brydes til højst 2-3 linjer INDEN FOR sit felt, og giv feltet nok højde (h). Lange ord skal kunne være der. Hellere lidt mindre fs end overløb.',
  '',
  'KOMPOSITION & FARVE:',
  '- Vælg en arketype der passer: (a) split — farveblok + foto side om side; (b) plakat — centreret, stor typografi; (c) fuldt foto + mørk gradient i bunden + tekst ovenpå; (d) magasin — stor overskrift øverst, små metaoplysninger; (e) tilbud — kæmpe tal/badge. Udfør den rent.',
  '- Palet: én dominerende baggrund, 1-2 accentfarver, og næsten-hvid eller næsten-sort til tekst. Brug accenten til ÉN ting (badge eller ét nøgleord).',
  '- KONTRAST er et krav: lys tekst på mørk flade, mørk tekst på lys flade. Skal et foto ligge bag tekst, så læg en mørk gradient/scrim-rect (fx fill {"type":"linear","stops":["#00000000","#000000cc"]}) imellem, så teksten kan læses.',
  '- Brug HELE lærredet med god luft (hold ca. 6-9% sikkerhedsmargin til vigtig tekst). Baggrunde/former må gerne bløde ud over kanten (negativ x/y eller w/h>100).',
  '- Typisk 5-9 elementer. Klar visuel balance — ikke alt klumpet i midten.',
  '',
  'UNDGÅ: mikroskopisk tekst, alt centreret og ens stort, lav kontrast, tekst der overlapper eller flyder ud over sit felt, ren #000000/#ffffff medmindre bevidst, mere end 9 elementer.',
  '',
  'EKSEMPEL på et stærkt svar (kvadrat, café-nyåbning) — match dette kvalitetsniveau, men lav noget originalt der passer til opgaven:',
  SCENE_FEWSHOT,
  '',
  'Hvis en STIL-REFERENCE er givet: gengiv dens VISUELLE udtryk — palet (brug de angivne hex og farveroller), komposition/opbygning, kontrastniveau, og medie-look (fladt grafisk vs fotografisk) — men lav en ORIGINAL komposition med brugerens eget indhold. Det handler om at ramme STILEN, ikke kun farverne. Er der vedhæftet et referencebillede, så studér dets layout, billedbrug og typografi og match dem.',
  'Får du et LAYOUT MED KOORDINATER (foto-område, farveblokke, tekstzoner): placér dine elementer PRÆCIST på de angivne felter (x,y,w,h i %), så opslagets opbygning matcher referencen — foto hvor fotoet er, overskrift i den første tekstzone, osv. Dette vægter HØJERE end dine egne placeringsvaner. Brug stadig brugerens eget indhold, tekst og palet til at fylde felterne.',
  'Hvis en FORRIGE SCENE er givet: ÆNDR den så det nye ønske opfyldes, men behold ALT andet uændret (samme elementer/positioner/farver medmindre ønsket ændrer dem). Returnér hele den opdaterede scene.',
  'Svar KUN med JSON.'
].join('\n');

async function callDeepSeekScene(key, messages) {
  return fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 3600, response_format: { type: 'json_object' } })
  });
}

function buildStyleLines(sr) {
  if (!sr || typeof sr !== 'object') return [];
  const out = [];
  const pal = Array.isArray(sr.palette) ? sr.palette.map(p => (typeof p === 'string' ? p : (p && p.hex))).map(safeColor).filter(Boolean).slice(0, 8) : [];
  out.push('MATCH DENNE UPLOADEDE STIL — gengiv dens VISUELLE udtryk (komposition, medie-look og stemning), ikke kun farverne. Lav en ORIGINAL komposition i SAMME stil:');
  if (pal.length) out.push('- Palet (brug disse hex): ' + pal.join(', '));
  const r = sr.roles || {};
  const roleBits = [];
  if (safeColor(r.bg)) roleBits.push('baggrund ≈ ' + safeColor(r.bg));
  if (safeColor(r.accent)) roleBits.push('accent (brug til ÉT element) ≈ ' + safeColor(r.accent));
  if (safeColor(r.lightText)) roleBits.push('tekst ≈ ' + safeColor(r.lightText));
  if (roleBits.length) out.push('- Farveroller: ' + roleBits.join(', '));
  if (sr.styleBrief) out.push('- Visuel stil: ' + String(sr.styleBrief).slice(0, 320));
  const bits = [];
  if (sr.composition) bits.push('komposition: ' + String(sr.composition).slice(0, 60));
  if (sr.medium) bits.push('medie-udtryk: ' + String(sr.medium).slice(0, 40));
  if (sr.density) bits.push(String(sr.density).slice(0, 40));
  if (sr.theme) bits.push('tema ' + String(sr.theme).slice(0, 20));
  if (sr.contrast) bits.push(String(sr.contrast).slice(0, 24));
  if (sr.temperature) bits.push(String(sr.temperature).slice(0, 16) + ' tone');
  if (bits.length) out.push('- ' + bits.join('; '));
  if (Array.isArray(sr.descriptors) && sr.descriptors.length) out.push('- Stemning: ' + sr.descriptors.map(d => String(d).slice(0, 24)).slice(0, 8).join(', '));
  out.push('- Ram samme kompositionsprincip, kontrastniveau og medie-udtryk (fladt grafisk vs fotografisk) som referencen — ikke kun paletten.');
  return out;
}

function buildLayoutLines(L) {
  if (!L || typeof L !== 'object') return [];
  const cl = v => Math.max(0, Math.min(100, numClamp(v, 0, 100, 0)));
  const ok = r => r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && isFinite(v)) && r.w > 1 && r.h > 1;
  const fmt = r => 'x ' + cl(r.x) + ', y ' + cl(r.y) + ', b ' + cl(r.w) + ', h ' + cl(r.h);
  const aw = { l: 'venstrestillet', c: 'centreret', r: 'højrestillet' };
  const hasAny = ok(L.photo) || ok(L.block) || (Array.isArray(L.zones) && L.zones.some(ok));
  if (!hasAny) return [];
  const out = [];
  out.push('LAYOUT FRA REFERENCEN — gengiv DENNE placering så opslaget matcher referencens opbygning (alt i % af lærred, x,y = øverste venstre hjørne):');
  if (ok(L.photo)) out.push('- Foto-/billedområde: ' + fmt(L.photo) + ' → læg et image-element (src "photo") her i samme størrelse og placering.');
  if (ok(L.block)) { const col = safeColor(L.blockColor); out.push('- Farveblok' + (col ? (' (' + col + ')') : '') + ': ' + fmt(L.block) + ' → en rect i denne farve her.'); }
  if (Array.isArray(L.zones)) L.zones.filter(ok).slice(0, 4).forEach((z, i) => { out.push('- Tekstzone ' + (i + 1) + ' (' + (aw[z.align] || 'venstrestillet') + '): ' + fmt(z) + ' → ' + (i === 0 ? 'læg overskriften her' : 'læg tekst her') + '.'); });
  out.push('- Hold dig SÅ TÆT som muligt på disse felter (placering og størrelse). Fyld dem med brugerens egen tekst, foto og farver. Det er layoutet/placeringen der skal matche referencen.');
  return out;
}

const SCENE_VISION_SYS = [
  'Du er en præcis LAYOUT-TRACER. Du får et referencebillede og skal gengive dets opbygning så NØJAGTIGT som muligt som ét JSON-objekt ("scene"), som motoren tegner præcist. Du redesigner IKKE og forbedrer IKKE — du KOPIERER referencens layout, typografi og farver 1:1. MEN du gengiver ALDRIG teksten/ordene der står i billedet; alt tekstindhold kommer fra brugeren. Svar KUN med JSON.',
  '',
  'KOORDINATSYSTEM: x, y, w, h = PROCENT af lærredet (0-100). x,y = elementets øverste venstre hjørne. fs, sw, r, pad er i cqw = procent af lærredets BREDDE. z = lag. rot = grader. op = 0-1. shadow:true = blød skygge.',
  '',
  'OUTPUT (kun dette JSON): { "scene": { "ar": <højde/bredde — sæt til den oplyste billed-ratio>, "bg": <"#hex" ELLER {"type":"linear","stops":["#hex","#hex"],"angle":<grader>} ELLER {"type":"radial","stops":[...],"cx":50,"cy":40}>, "els": [ <element>, ... ] }, "photoQuery": <"engelske søgeord til et foto der ligner referencens, ellers \\"\\""> }',
  '',
  'ELEMENT-TYPER (alle med x,y,w,h + valgfri z,rot,op,shadow):',
  '- text:  {"t":"text","str":...,"font":<id>,"fs":<cqw>,"fw":<400-900>,"color":"#hex","align":"l|c|r","va":"t|m|b","lh":<fx 1.05>,"ls":<em>,"up":<true=VERSALER>,"italic":<bool>,"fill":<valgfri baggrund>,"r":<radius>,"pad":<cqw>}',
  '- image: {"t":"image","src":"photo","fit":"cover|contain","r":<radius>}  (foto-/billedområde)',
  '- rect:  {"t":"rect","fill":<"#hex"/gradient>,"r":<radius>,"stroke":"#hex","sw":<cqw>}  (farveflade/panel, eller streg = lav h)',
  '- ellipse: {"t":"ellipse","fill":...}  (cirkel/badge: w og h ens)',
  '- icon:  {"t":"icon","icon":<id>,"fill":"#hex"}',
  '- path:  {"t":"path","d":<SVG path i 0..100 viewBox>,"fill":...,"stroke":"#hex","sw":<cqw>}  (brug den til vilkårlige former/grafik referencen har, som de andre ikke dækker)',
  'FONT-ID (vælg den NÆRMESTE til referencens skrift — du har frit valg blandt alle): seriffer: fraunces, playfair, dmserif, cormorant, lora, baskerville, abril; slab-serif: slab; sans: poppins, montserrat, grotesk, inter, worksans, manrope, dmsans, outfit, sora, quicksand; smalle/fede display: anton, bebas, archivo, oswald, barlow, teko, righteous; håndskrift/script: caveat, dancing, pacifico, lobster; monospace: mono2.',
  'IKON-ID: coffee, food, leaf, flower, heart, gift, sun, sparkle, snowflake, confetti, scissors, dumbbell, graduation, sale, star.',
  '',
  'TRACING-REGLER (følg dem nøje):',
  '1. Sæt scene.ar til den oplyste billed-ratio, så lærredet får SAMME form som billedet.',
  '2. Mål hvert elements position og størrelse så præcist du kan, målt mod billedets kanter, og oversæt direkte til procent (0-100). Vær omhyggelig med x/y/w/h og fs.',
  '3. Gengiv ALT du ser, i rækkefølge: baggrund (farve/gradient + retning) → derefter top mod bund, venstre mod højre.',
  '4. Foto-/billedområder → image med SAMME boks. Farveflader/paneler → rect med samme boks og farve. Tekstblokke → text med samme position, størrelse, justering, vægt og VERSALER hvis relevant. Cirkler/badges → ellipse (+ tekst ovenpå). Streger → tynd rect. Logoer/symboler → nærmeste ikon, ellers udelad.',
  '5. Læs farver direkte fra billedet (hex) og match dem. Vælg den skrifttype fra listen der ligner referencens mest.',
  '6. Tilføj IKKE elementer der ikke er der. Fjern IKKE elementer der er der. Flyt IKKE rundt og centrér ikke "pænere". Kopiér tro.',
  '7. Brug så mange elementer som nødvendigt for at matche (intet kunstigt loft) og frit valg af former, gradienter og skrifttyper.',
  '8. KOPIÉR ALDRIG ordene fra billedet. Referencen er KUN skabelon for layout, skrifttype, størrelse, vægt, farve og placering — IKKE for tekstindhold. For hver tekstblok: behold dens position/størrelse/skrifttype/justering, men udfyld den med BRUGERENS eget indhold (overskrift, undertekst, brand m.m. fra oplysningerne ovenfor). Har du ikke passende brugertekst til en blok, så skriv en KORT, generisk tekst der passer til brugerens emne/branche — aldrig de konkrete ord der står i billedet.',
  '',
  'Svar KUN med scene-JSON, ingen markdown, ingen forklaring.'
].join('\n');

async function callGeminiVision(key, model, baseUrl, messages, temp, jsonMode) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const payload = { model, messages, temperature: (typeof temp === 'number' ? temp : 0.3), max_tokens: 6500 };
  if (jsonMode) payload.response_format = { type: 'json_object' };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(payload)
  });
}

// JSON-tilstand som standard (så modellen ikke svarer med prosa).
// Genforsøg ved forbigående 503/429; falder tilbage uden response_format hvis modellen afviser det (400).
async function callGeminiVisionRetry(key, model, baseUrl, messages, temp) {
  let r = await callGeminiVision(key, model, baseUrl, messages, temp, true);
  if (r && (r.status === 503 || r.status === 429)) {
    await new Promise(res => setTimeout(res, 1300));
    r = await callGeminiVision(key, model, baseUrl, messages, temp, true);
  }
  if (r && r.status === 400) {
    r = await callGeminiVision(key, model, baseUrl, messages, temp, false);
  }
  return r;
}

// Geminis EGEN (native) API med håndhævet JSON-output (responseMimeType). Her KAN modellen ikke svare med prosa.
// thinkingBudget:0 slår "tænkning" fra på 2.5-flash, så HELE token-budgettet går til selve JSON'en (ingen afkortning).
async function callGeminiNative(key, model, sysText, userText, imageDataUrl, temp, withThinkingOff) {
  const m = String(imageDataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
  const mime = m ? m[1] : 'image/jpeg';
  const data = m ? m[2] : '';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const gc = { temperature: (typeof temp === 'number' ? temp : 0.2), maxOutputTokens: 16384, responseMimeType: 'application/json' };
  if (withThinkingOff !== false) gc.thinkingConfig = { thinkingBudget: 0 };
  const bodyObj = {
    systemInstruction: { parts: [{ text: sysText }] },
    contents: [{ role: 'user', parts: [ { text: userText }, { inlineData: { mimeType: mime, data } } ] }],
    generationConfig: gc
  };
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(bodyObj) });
}

async function callGeminiNativeRetry(key, model, sysText, userText, imageDataUrl, temp) {
  let r = await callGeminiNative(key, model, sysText, userText, imageDataUrl, temp, true);
  // Op til to genforsøg ved forbigående overbelastning/kvote (Google 503/429)
  if (r && (r.status === 503 || r.status === 429)) {
    await new Promise(res => setTimeout(res, 1300));
    r = await callGeminiNative(key, model, sysText, userText, imageDataUrl, temp, true);
  }
  if (r && (r.status === 503 || r.status === 429)) {
    await new Promise(res => setTimeout(res, 2600));
    r = await callGeminiNative(key, model, sysText, userText, imageDataUrl, temp, true);
  }
  // Hvis modellen ikke kender thinkingConfig (400), prøv uden
  if (r && r.status === 400) {
    r = await callGeminiNative(key, model, sysText, userText, imageDataUrl, temp, false);
  }
  return r;
}

// Samlet vision-kald. Standard = native Gemini (håndhævet JSON). Hvis VISION_BASE_URL er sat til en
// anden udbyder, bruges OpenAI-kompatibelt format i stedet. Returnerer { status, text, engine }.
const VISION_ENGINE_VERSION = 'v8';
async function visionComplete(key, model, baseUrl, sysText, userText, imageDataUrl, temp) {
  const customBase = String(baseUrl || '').trim();
  if (!customBase) {
    const r = await callGeminiNativeRetry(key, model, sysText, userText, imageDataUrl, temp);
    if (!r || !r.ok) return { status: r ? r.status : 0, text: '', engine: 'native' };
    let d = {}; try { d = await r.json(); } catch (e) {}
    const parts = (d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    const text = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    return { status: 200, text, engine: 'native' };
  }
  const messages = [ { role: 'system', content: sysText }, { role: 'user', content: [ { type: 'text', text: userText }, { type: 'image_url', image_url: { url: imageDataUrl } } ] } ];
  const r = await callGeminiVisionRetry(key, model, customBase, messages, temp);
  if (!r || !r.ok) return { status: r ? r.status : 0, text: '', engine: 'compat' };
  let d = {}; try { d = await r.json(); } catch (e) {}
  const c = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  return { status: 200, text: typeof c === 'string' ? c : JSON.stringify(c), engine: 'compat' };
}

async function handleSceneRequest(body, res, key) {
  const navn = String(body.navn || '').slice(0, 120);
  const type = String(body.type || '').slice(0, 120);
  const emne = String(body.emne || '').slice(0, 800);
  const brief = String(body.brief || '').slice(0, 1500);
  const ratio = numClamp(body.ratio, 0.4, 4, 1);
  const content = (body.content && typeof body.content === 'object') ? body.content : {};
  const sr = (body.styleRef && typeof body.styleRef === 'object') ? body.styleRef : null;
  let styleImage = '';
  if (typeof body.styleImage === 'string' && /^data:image\/(png|jpe?g|webp);base64,/i.test(body.styleImage) && body.styleImage.length < 800000) styleImage = body.styleImage;
  let prevScene = null;
  if (body.prevScene && typeof body.prevScene === 'object') { try { prevScene = JSON.parse(JSON.stringify(body.prevScene)); } catch (e) {} }
  if (!brief.trim() && !prevScene && !sr && !styleImage) { res.status(400).json({ error: 'Beskriv hvad du vil have tegnet, eller upload en stil-reference.' }); return; }

  const lines = [];
  if (navn) lines.push('Brand/afsender: ' + navn + (type ? (' — ' + type) : ''));
  if (emne) lines.push('Opslagets emne: ' + emne);
  if (content.headline) lines.push('Hovedbudskab/overskrift som teksten ønsker: ' + String(content.headline).slice(0, 200));
  if (content.subline) lines.push('Støttetekst: ' + String(content.subline).slice(0, 300));
  if (content.badge) lines.push('Evt. badge-tekst: ' + String(content.badge).slice(0, 40));
  lines.push('Format ar (height/width): ' + ratio + (ratio < 1.1 ? ' = kvadrat 1:1' : ratio > 1.5 ? ' = story 9:16' : ' = stående 4:5'));
  lines.push('');
  if (brief.trim()) lines.push('BRUGERENS DESIGN-ØNSKE — følg det PRÆCIST: ' + brief);
  else lines.push('Lav et stærkt, originalt opslag om emnet i den angivne stil.');
  const styleLines = buildStyleLines(sr);
  if (styleLines.length) { lines.push(''); styleLines.forEach(l => lines.push(l)); }
  const layoutLines = buildLayoutLines(sr && sr.layout);
  if (layoutLines.length) { lines.push(''); layoutLines.forEach(l => lines.push(l)); }
  if (styleImage) { lines.push(''); lines.push('Et referencebillede er vedhæftet — match dets æstetik, komposition og typografi-stemning.'); }
  if (prevScene) { lines.push(''); lines.push('FORRIGE SCENE (ret KUN det brugeren beder om, behold alt andet uændret):'); lines.push(JSON.stringify(prevScene).slice(0, 6500)); }
  const user = lines.join('\n');

  const sysMsg = { role: 'system', content: SCENE_SYS };
  const textMessages = [ sysMsg, { role: 'user', content: user } ];
  const visionKey = process.env.GEMINI_API_KEY || process.env.VISION_API_KEY || '';
  const visionModel = process.env.VISION_MODEL || 'gemini-2.5-flash';
  const visionBase = process.env.VISION_BASE_URL || '';

  try {
    let parsed = null;
    let via = 'tekst';
    let visionNote = '';
    if (!visionKey) visionNote = 'ingen GEMINI_API_KEY på serveren [' + VISION_ENGINE_VERSION + ']';
    else if (!styleImage) visionNote = 'intet/ugyldigt billede modtaget — for stort? [' + VISION_ENGINE_VERSION + ']';
    // 1) VISION-FØRST: lad Gemini SE billedet og kopiere layoutet (native API med håndhævet JSON-svar)
    if (styleImage && visionKey) {
      const jsonOnly = ' Svar UDELUKKENDE med ren JSON: start med { og slut med }. Ingen forklaring, ingen markdown, ingen beskrivelse, ingen tekst udenom.';
      try {
        const visionUser = user + '\n\nKOPIÉR LAYOUTET, TYPOGRAFIEN OG FARVERNE fra det vedhæftede referencebillede så NØJAGTIGT som muligt. Sæt scene.ar til ' + ratio + ' (billedets forhold). Placér og størrelsessæt hvert element så det matcher billedet (x, y, w, h, fs), match farver, skrifttype-stil og justering. VIGTIGT: brug KUN billedet som layout-/stil-skabelon — gengiv ALDRIG ordene/teksten der står i billedet. Udfyld alle tekstblokke med BRUGERENS egen tekst/brand herover (eller en kort generisk tekst der passer til emnet), men behold referencens positioner, størrelser og skrifttype.' + jsonOnly;
        const r1 = await visionComplete(visionKey, visionModel, visionBase, SCENE_VISION_SYS, visionUser, styleImage, 0.15);
        const tag = ' [' + r1.engine + ' ' + VISION_ENGINE_VERSION + ']';
        if (r1.text) {
          const vp = extractScene(r1.text);
          if (vp.scene) { parsed = vp; via = 'vision'; visionNote = 'ok'; }
          else { const snip = String(r1.text).replace(/\s+/g, ' ').trim().slice(0, 180); visionNote = 'svar kunne ikke læses som JSON' + tag + ' · svar-start: «' + snip + '»'; }
        } else {
          visionNote = 'Gemini HTTP ' + r1.status + tag;
        }
        // 1b) SELV-RETTENDE RUNDE: sammenlign resultatet med billedet og ret afvigelser (slå fra med VISION_REFINE=0)
        if (parsed && parsed.scene && process.env.VISION_REFINE !== '0') {
          try {
            const prevJson = JSON.stringify({ scene: parsed.scene }).slice(0, 12000);
            const refineUser = 'Her er dit forrige forsøg på at kopiere referencen som scene-JSON:\n' + prevJson + '\n\nSammenlign det NØJE med det vedhæftede referencebillede og RET alt der ikke matcher: elementernes position (x,y), størrelse (w,h,fs), justering, skrifttype, farver, baggrund — og tilføj manglende eller fjern overflødige elementer. BEHOLD brugerens tekst i blokkene — gengiv ALDRIG ordene fra billedet. scene.ar skal være ' + ratio + '.' + jsonOnly;
            const r2 = await visionComplete(visionKey, visionModel, visionBase, SCENE_VISION_SYS, refineUser, styleImage, 0.1);
            if (r2.text) { const rp = extractScene(r2.text); if (rp.scene) { parsed = rp; via = 'vision+ret'; } }
          } catch (e) { /* behold runde 1 */ }
        }
      } catch (e) { visionNote = 'vision-kald fejlede: ' + ((e && e.message) || 'ukendt'); }
    }
    // 2) FALLBACK: DeepSeek (tekst) med stil- og layout-beskrivelsen
    if (!parsed) {
      const dsRes = await callDeepSeekScene(key, textMessages);
      if (!dsRes.ok) { let detail = ''; try { detail = (await dsRes.text()).slice(0, 300); } catch (e) {} res.status(502).json({ error: 'DeepSeek svarede med en fejl (' + dsRes.status + ').', detail }); return; }
      const data = await dsRes.json();
      const txt = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      parsed = extractScene(txt);
    }
    if (!parsed || !parsed.scene) { res.status(502).json({ error: 'Kunne ikke tegne designet. Prøv en lidt anden beskrivelse.' }); return; }
    const result = { scene: parsed.scene, photos: [], photosHi: [], photoQuery: parsed.photoQuery, via, visionNote };
    if (parsed.photoQuery && parsed.scene.els.some(e => e.t === 'image')) {
      const ph = await fetchPhotos(parsed.photoQuery);
      result.photos = ph.map(o => o.disp); result.photosHi = ph.map(o => o.full);
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Uventet fejl på serveren.', detail: (err && err.message) || '' });
  }
}
