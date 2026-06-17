// Vercel serverless-funktion — foto-proxy.
// Streamer et Pexels-billede gennem din egen server, så billedet er "samme-origin".
// Det er nødvendigt for at "Hent som billede" (html2canvas) kan tegne fotoet uden at blive blokeret.
//
// Endepunkt: /api/opslag-foto?u=<pexels-billed-url>
// Filen skal ligge i mappen /api i roden af dit repo.

export default async function handler(req, res) {
  // ---- Søge-tilstand: /api/opslag-foto?q=<søgeord> → JSON med billedresultater ----
  const q = String((req.query && req.query.q) || '').trim();
  if (q) {
    const key = process.env.PEXELS_API_KEY;
    if (!key) { res.status(200).json({ photos: [], error: 'Billedsøgning kræver en gratis Pexels-nøgle (PEXELS_API_KEY) på serveren.' }); return; }
    try {
      const opts = { headers: { Authorization: key } };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(9000);
      const r = await fetch('https://api.pexels.com/v1/search?per_page=24&query=' + encodeURIComponent(q.slice(0, 80)), opts);
      if (!r.ok) { res.status(200).json({ photos: [], error: 'Kunne ikke søge (Pexels svarede ' + r.status + ').' }); return; }
      const j = await r.json();
      const photos = (j.photos || []).map(p => {
        const s = (p && p.src) || {};
        const disp = s.large || s.large2x || s.medium || s.original;
        const full = s.original || s.large2x || s.large;
        return disp ? { disp, full: full || disp } : null;
      }).filter(Boolean);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(200).json({ photos });
    } catch (e) { res.status(200).json({ photos: [], error: 'Uventet fejl ved billedsøgning.' }); }
    return;
  }

  // ---- Proxy-tilstand: /api/opslag-foto?u=<pexels-billed-url> ----
  const raw = String((req.query && req.query.u) || '');
  let u;
  try { u = new URL(raw); } catch (e) { res.status(400).json({ error: 'Ugyldig URL.' }); return; }

  // Tillad kun https + Pexels-billeddomæner (ingen åben proxy).
  if (u.protocol !== 'https:' || !/(^|\.)pexels\.com$/i.test(u.hostname)) {
    res.status(400).json({ error: 'Domæne ikke tilladt.' }); return;
  }

  try {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LusidioBot/1.0)' }, redirect: 'follow' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(9000);
    const r = await fetch(u.href, opts);
    if (!r.ok) { res.status(502).json({ error: 'Kunne ikke hente billedet.' }); return; }

    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) { res.status(415).json({ error: 'Ikke et billede.' }); return; }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Uventet fejl ved hentning af billede.' });
  }
}
