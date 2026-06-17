// Vercel serverless-funktion — proxy til DeepSeek.
// API-nøglen ligger KUN her på serveren, aldrig i frontend-koden.
//
// Opsætning i Vercel: Project → Settings → Environment Variables →
//   DEEPSEEK_API_KEY = <din nøgle> (alle miljøer) → Save → Redeploy.
// Filen skal ligge i mappen /api i roden af dit repo → endepunkt: /api/opslag-tekst

const PALETTES = ['terra','cream','dark','forest','berry','navy','teal','blush','mustard','coral','sky','wine','rust','olive','ocean','lavender','peach','slate','cocoa','mint'];
const MOTIFS   = ['none','graduation','sale','coffee','food','leaf','snowflake','confetti','flower','heart','gift','sun','sparkle','scissors','dumbbell'];
const LAYOUTS  = ['centered','left'];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Kun POST er tilladt.' }); return; }

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) { res.status(500).json({ error: 'Serveren mangler DEEPSEEK_API_KEY. Tilføj den i Vercel og deploy igen.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const navn     = String(body.navn || '').slice(0, 120);
  const type     = String(body.type || '').slice(0, 120) || 'lille virksomhed';
  const emne     = String(body.emne || '').slice(0, 800);
  const platform = String(body.platform || 'facebook');
  const laengde  = String(body.laengde || 'mellem');
  const emoji    = String(body.emoji || 'med');
  let   antal    = parseInt(body.antal, 10);
  if (!(antal >= 1 && antal <= 5)) antal = 3;

  if (!emne.trim()) { res.status(400).json({ error: 'Skriv hvad opslaget skal handle om.' }); return; }

  const platMap = { facebook:'Facebook', instagram:'Instagram', linkedin:'LinkedIn' };
  const lenMap  = { kort:'kort — 1-2 sætninger', mellem:'mellemlang — 3-5 sætninger', lang:'længere — et lille afsnit' };
  const emojiInstr = emoji === 'uden' ? 'Brug IKKE emojis.' : 'Brug nogle få, passende emojis — ikke for mange.';

  const sys = 'Du er både en erfaren dansk social media-tekstforfatter OG en prisvindende grafisk designer (art director) for små danske virksomheder. ' +
    'Du skriver naturligt, varmt og letlæseligt dansk — aldrig kunstigt eller klichéfyldt. ' +
    'Som art director træffer du gennemtænkte valg om farver, motiv, layout og typografisk hierarki, så opslaget ligner noget en dygtig professionel designer har lavet — med ro, kontrast og en klar idé.';

  const user = [
    'Lav indhold OG gennemtænkte design-valg til et opslag til ' + (platMap[platform] || 'Facebook') + '.',
    '',
    'Virksomhed: ' + (navn || 'ikke oplyst'),
    'Type af virksomhed: ' + type,
    'Opslaget skal handle om: ' + emne,
    'Vælg selv den tone der passer bedst til emnet, virksomheden og platformen.',
    'Ønsket længde på billedteksten: ' + (lenMap[laengde] || lenMap.mellem),
    emojiInstr,
    '',
    'Du skal levere:',
    '1) "headline": En kort, slagkraftig overskrift til billedet (maks ca. 6 ord). Ingen hashtags/emojis.',
    '2) "emphasis": Det ENE vigtigste ord/ordpar fra headline der skal fremhæves. SKAL være kopieret præcist fra headline. Tom hvis intet skal fremhæves.',
    '3) "eyebrow": En meget kort overlinje/kicker der står lille over overskriften (maks 3-4 ord, fx "KUN FOR STUDERENDE", "NYHED", "EFTERÅR 2026", "ÅBNINGSTILBUD"). Tom hvis den ikke giver mening.',
    '4) "subline": En kort støttelinje (maks ca. 8 ord). Ingen hashtags.',
    '5) "badge": KUN ved et konkret tilbud/kampagne: en meget kort mærkat-tekst, fx "-20%", "SPAR 50%", "2 for 1". Ellers tom streng.',
    '6) "posts": ' + antal + ' forskellige forslag til billedteksten. Hvert: egen vinkel, dansk, slut med 3-6 relevante danske hashtags. Ingen pladsholdere som [navn].',
    '7) "design": Vælg palette, motiv og layout der passer bedst til emnet og stemningen.',
    '',
    'Tilladte paletter (vælg ÉN id): ' + PALETTES.join(', ') + '.',
    'Stemning: terra/rust/cocoa=varm/café/efterår, cream/peach=lys/elegant, dark/wine=premium/aften/restaurant, forest/olive/mint=natur/grøn/wellness, berry/lavender=fest/studie/skønhed, navy/slate/ocean=professionel/seriøs/ro, teal=frisk, blush=blød/skønhed/valentine, mustard=retro/tilbud, coral=bold/udsalg, sky=sommer/let.',
    '',
    'Tilladte motiver (vælg ÉN id): ' + MOTIFS.join(', ') + '.',
    'Motiv-guide: graduation=studenter/dimission, sale=rabat/udsalg, coffee=café, food=mad/menu, leaf=efterår/natur, snowflake=jul/vinter, confetti=fest/fødselsdag, flower=forår/blomster, heart=valentine, gift=gave, sun=sommer, sparkle=nyhed/lancering, scissors=frisør/salon, dumbbell=fitness, none=hvis intet passer (vælg hellere none end et dårligt match).',
    '',
    'Layout (vælg ÉN): "centered" (roligt, symmetrisk) eller "left" (redaktionelt/magasin-agtigt, venstrestillet). Vælg "left" når teksten er lidt længere eller skal virke moderne/redaktionel; "centered" til korte, slagkraftige budskaber.',
    '',
    'Eksempler: "studenterrabat" → palette berry/lavender, motif graduation, eyebrow "KUN FOR STUDERENDE", badge fx "-20%". "Black Friday" → palette coral/dark, motif sale, badge fx "-50%". "ny efterårsmenu" → palette terra/rust, motif coffee/leaf, layout left.',
    '',
    'Returnér KUN gyldig JSON i præcis dette format, uden tekst udenfor:',
    '{"headline":"...","emphasis":"...","eyebrow":"","subline":"...","badge":"","posts":["...","..."],"design":{"palette":"berry","motif":"graduation","layout":"centered"}}'
  ].join('\n');

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [ { role:'system', content: sys }, { role:'user', content: user } ],
        temperature: 1.0,
        max_tokens: 1800,
        response_format: { type: 'json_object' }
      })
    });

    if (!dsRes.ok) {
      let detail = '';
      try { detail = (await dsRes.text()).slice(0, 300); } catch (e) {}
      res.status(502).json({ error: 'DeepSeek svarede med en fejl (' + dsRes.status + ').', detail });
      return;
    }

    const data = await dsRes.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    const result = extractContent(content);
    if (!result.posts.length) { res.status(502).json({ error: 'Kunne ikke læse forslagene fra AI. Prøv igen.' }); return; }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Uventet fejl på serveren.', detail: (err && err.message) || '' });
  }
}

function extractContent(content) {
  const out = { headline:'', emphasis:'', eyebrow:'', subline:'', badge:'', posts:[], design:{ palette:'', motif:'', layout:'' } };
  if (!content) return out;

  let txt = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(txt); }
  catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} } }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (typeof obj.headline === 'string') out.headline = obj.headline.trim();
    if (typeof obj.emphasis === 'string') out.emphasis = obj.emphasis.trim();
    if (typeof obj.eyebrow === 'string')  out.eyebrow  = obj.eyebrow.trim().slice(0, 40);
    if (typeof obj.subline === 'string')  out.subline  = obj.subline.trim();
    if (typeof obj.badge === 'string')    out.badge    = obj.badge.trim().slice(0, 16);
    if (Array.isArray(obj.posts)) out.posts = obj.posts.map(String).filter(s => s.trim());
    if (obj.design && typeof obj.design === 'object') {
      if (PALETTES.indexOf(obj.design.palette) >= 0) out.design.palette = obj.design.palette;
      if (MOTIFS.indexOf(obj.design.motif) >= 0) out.design.motif = obj.design.motif;
      if (LAYOUTS.indexOf(obj.design.layout) >= 0) out.design.layout = obj.design.layout;
    }
    return out;
  }
  if (Array.isArray(obj)) { out.posts = obj.map(String).filter(s => s.trim()); return out; }
  out.posts = txt ? [txt] : [];
  return out;
}
