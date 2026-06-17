// Vercel serverless-funktion — proxy til DeepSeek.
// API-nøglen ligger KUN her på serveren, aldrig i frontend-koden.
//
// Opsætning i Vercel:
//   Project → Settings → Environment Variables →
//   Name:  DEEPSEEK_API_KEY
//   Value: <din nøgle fra platform.deepseek.com>
//   (vælg alle miljøer: Production, Preview, Development) → Save → Redeploy.
//
// Filen skal ligge i mappen  /api  i roden af dit repo, så bliver den
// automatisk til endepunktet  /api/opslag-tekst

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Kun POST er tilladt.' });
    return;
  }

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Serveren mangler DEEPSEEK_API_KEY. Tilføj den i Vercel og deploy igen.' });
    return;
  }

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

  if (!emne.trim()) {
    res.status(400).json({ error: 'Skriv hvad opslaget skal handle om.' });
    return;
  }

  const toneMap = {
    varm: 'varm, hyggelig og imødekommende',
    professionel: 'professionel, klar og troværdig',
    sjov: 'sjov, legende og uformel',
    skarp: 'kort, skarp og direkte'
  };
  const platMap = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn' };
  const lenMap  = {
    kort: 'kort — 1-2 sætninger',
    mellem: 'mellemlang — 3-5 sætninger',
    lang: 'længere — et lille afsnit'
  };
  const emojiInstr = emoji === 'uden'
    ? 'Brug IKKE emojis.'
    : 'Brug nogle få, passende emojis — ikke for mange.';

  const sys = 'Du er en erfaren dansk social media-tekstforfatter for små danske virksomheder. ' +
    'Du skriver naturligt, varmt og letlæseligt dansk — aldrig kunstigt, klichéfyldt eller pompøst. ' +
    'Du tilpasser tone og længde til platformen, og du skriver opslag, der får almindelige mennesker til at stoppe op og reagere.';

  const user = [
    'Lav indhold til et opslag til ' + (platMap[platform] || 'Facebook') + '.',
    '',
    'Virksomhed: ' + (navn || 'ikke oplyst'),
    'Type af virksomhed: ' + type,
    'Opslaget skal handle om: ' + emne,
    'Ønsket tone: ' + (toneMap[tone] || toneMap.varm),
    'Ønsket længde på billedteksten: ' + (lenMap[laengde] || lenMap.mellem),
    emojiInstr,
    '',
    'Du skal levere TO ting:',
    '1) En kort, fængende OVERSKRIFT til selve billedet (maks ca. 6 ord) og en kort UNDERLINJE (maks ca. 8 ord). Overskriften skal kunne stå stort på et opslag og fange øjet. Brug ikke hashtags eller emojis i overskrift/underlinje.',
    '2) ' + antal + ' forskellige forslag til selve billedteksten (det man skriver under opslaget).',
    '',
    'Krav til billedteksterne:',
    '- Skriv udelukkende på dansk.',
    '- Hvert forslag skal have sin egen vinkel — ikke bare små variationer af det samme.',
    '- Afslut hvert forslag med 3-6 relevante danske hashtags.',
    '- Ingen pladsholdere som [navn] eller [dato] — skriv færdig, brugbar tekst.',
    '',
    'Returnér KUN gyldig JSON i præcis dette format, uden noget tekst udenfor JSON:',
    '{"headline": "kort overskrift", "subline": "kort underlinje", "posts": ["billedtekst 1", "billedtekst 2"]}'
  ].join('\n');

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ],
        temperature: 1.0,
        max_tokens: 1700,
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
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content || '';

    const result = extractContent(content);
    if (!result.posts.length) {
      res.status(502).json({ error: 'Kunne ikke læse forslagene fra AI. Prøv igen.' });
      return;
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Uventet fejl på serveren.', detail: (err && err.message) || '' });
  }
}

// Trækker headline, subline og posts ud af modellens svar — robust over for markdown-fences og lidt rod.
function extractContent(content) {
  const out = { headline: '', subline: '', posts: [] };
  if (!content) return out;

  let txt = String(content).trim();
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let obj = null;
  try { obj = JSON.parse(txt); }
  catch (e) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} }
  }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (typeof obj.headline === 'string') out.headline = obj.headline.trim();
    if (typeof obj.subline === 'string') out.subline = obj.subline.trim();
    if (Array.isArray(obj.posts)) out.posts = obj.posts.map(String).filter(s => s.trim());
    return out;
  }
  if (Array.isArray(obj)) { out.posts = obj.map(String).filter(s => s.trim()); return out; }

  // sidste udvej: hele teksten som ét forslag
  out.posts = txt ? [txt] : [];
  return out;
}
