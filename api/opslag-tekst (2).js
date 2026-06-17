// Vercel serverless-funktion — proxy til DeepSeek.
// API-nøglen ligger KUN her på serveren, aldrig i frontend-koden.
//
// Opsætning i Vercel:
//   Project → Settings → Environment Variables →
//   Name:  DEEPSEEK_API_KEY
//   Value: <din nøgle fra platform.deepseek.com>
//   (vælg alle miljøer) → Save → Redeploy.
//
// Filen skal ligge i mappen  /api  i roden af dit repo → endepunkt: /api/opslag-tekst

const PALETTES = ['terra','cream','dark','forest','berry','navy','teal','blush','mustard','coral','sky','wine'];
const MOTIFS   = ['none','graduation','sale','coffee','food','leaf','snowflake','confetti','flower','heart','gift','sun','sparkle','scissors','dumbbell'];

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
  const tone     = String(body.tone || 'varm');
  const platform = String(body.platform || 'facebook');
  const laengde  = String(body.laengde || 'mellem');
  const emoji    = String(body.emoji || 'med');
  let   antal    = parseInt(body.antal, 10);
  if (!(antal >= 1 && antal <= 5)) antal = 3;

  if (!emne.trim()) { res.status(400).json({ error: 'Skriv hvad opslaget skal handle om.' }); return; }

  const toneMap = { varm:'varm, hyggelig og imødekommende', professionel:'professionel, klar og troværdig', sjov:'sjov, legende og uformel', skarp:'kort, skarp og direkte' };
  const platMap = { facebook:'Facebook', instagram:'Instagram', linkedin:'LinkedIn' };
  const lenMap  = { kort:'kort — 1-2 sætninger', mellem:'mellemlang — 3-5 sætninger', lang:'længere — et lille afsnit' };
  const emojiInstr = emoji === 'uden' ? 'Brug IKKE emojis.' : 'Brug nogle få, passende emojis — ikke for mange.';

  const sys = 'Du er både en erfaren dansk social media-tekstforfatter OG en dygtig grafisk designer (art director) for små danske virksomheder. ' +
    'Du skriver naturligt, varmt og letlæseligt dansk — aldrig kunstigt eller klichéfyldt. ' +
    'Som art director vælger du farver og et grafisk motiv, der passer til opslagets emne og stemning, så det ligner noget en professionel designer har lavet.';

  const user = [
    'Lav indhold OG et grafisk design-valg til et opslag til ' + (platMap[platform] || 'Facebook') + '.',
    '',
    'Virksomhed: ' + (navn || 'ikke oplyst'),
    'Type af virksomhed: ' + type,
    'Opslaget skal handle om: ' + emne,
    'Ønsket tone: ' + (toneMap[tone] || toneMap.varm),
    'Ønsket længde på billedteksten: ' + (lenMap[laengde] || lenMap.mellem),
    emojiInstr,
    '',
    'Du skal levere:',
    '1) "headline": En kort, slagkraftig overskrift til selve billedet (maks ca. 6 ord). Ingen hashtags/emojis i overskriften.',
    '2) "emphasis": Det ENE vigtigste ord eller korte ordpar fra headline, som skal fremhæves. Det SKAL være kopieret præcist fra headline (samme stavning). Hvis intet skal fremhæves, lad den være tom.',
    '3) "subline": En kort støttelinje (maks ca. 8 ord). Ingen hashtags.',
    '4) "badge": KUN hvis opslaget er et tilbud/en kampagne: en meget kort tekst til et lille mærkat, fx "-20%", "SPAR 50%", "NYHED" eller "TILBUD". Ellers tom streng.',
    '5) "posts": ' + antal + ' forskellige forslag til billedteksten (det man skriver under opslaget). Hvert forslag: egen vinkel, dansk, og afslut med 3-6 relevante danske hashtags. Ingen pladsholdere som [navn].',
    '6) "design": Vælg den palette og det motiv der passer bedst til emnet og stemningen.',
    '',
    'Tilladte paletter (vælg ÉN id): ' + PALETTES.join(', ') + '.',
    'Vejledning: terra=varm/café/efterår, cream=elegant/minimal, dark=premium/aften, forest=natur/wellness, berry=fest/studie/skønhed, navy=professionel/seriøs, teal=frisk/moderne, blush=blød/skønhed/valentine, mustard=retro/tilbud, coral=bold/udsalg, sky=sommer/let, wine=restaurant/premium.',
    '',
    'Tilladte motiver (vælg ÉN id): ' + MOTIFS.join(', ') + '.',
    'Vejledning: graduation=studenter/dimission/eksamen, sale=rabat/tilbud/udsalg, coffee=café/kaffe, food=mad/menu/restaurant, leaf=efterår/natur, snowflake=jul/vinter, confetti=fest/fødselsdag/åbning, flower=forår/blomster, heart=valentine/kærlighed, gift=gave/gavekort, sun=sommer/ferie, sparkle=nyhed/lancering, scissors=frisør/salon, dumbbell=fitness/træning, none=hvis intet passer.',
    '',
    'Eksempler: "studenterrabat" → palette berry eller navy, motif graduation, badge fx "-20%". "Black Friday udsalg" → palette coral eller mustard, motif sale, badge fx "-50%". "julefrokost" → palette dark eller forest, motif snowflake. "ny efterårsmenu på caféen" → palette terra, motif coffee eller leaf.',
    '',
    'Returnér KUN gyldig JSON i præcis dette format, uden tekst udenfor:',
    '{"headline":"...","emphasis":"...","subline":"...","badge":"","posts":["...","..."],"design":{"palette":"berry","motif":"graduation"}}'
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
  const out = { headline:'', emphasis:'', subline:'', badge:'', posts:[], design:{ palette:'', motif:'' } };
  if (!content) return out;

  let txt = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(txt); }
  catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} } }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (typeof obj.headline === 'string') out.headline = obj.headline.trim();
    if (typeof obj.emphasis === 'string') out.emphasis = obj.emphasis.trim();
    if (typeof obj.subline === 'string') out.subline = obj.subline.trim();
    if (typeof obj.badge === 'string') out.badge = obj.badge.trim().slice(0, 16);
    if (Array.isArray(obj.posts)) out.posts = obj.posts.map(String).filter(s => s.trim());
    if (obj.design && typeof obj.design === 'object') {
      if (PALETTES.indexOf(obj.design.palette) >= 0) out.design.palette = obj.design.palette;
      if (MOTIFS.indexOf(obj.design.motif) >= 0) out.design.motif = obj.design.motif;
    }
    return out;
  }
  if (Array.isArray(obj)) { out.posts = obj.map(String).filter(s => s.trim()); return out; }
  out.posts = txt ? [txt] : [];
  return out;
}
