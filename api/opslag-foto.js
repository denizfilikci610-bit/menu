// Vercel serverless-funktion — foto-proxy.
// Streamer et Pexels-billede gennem din egen server, så billedet er "samme-origin".
// Det er nødvendigt for at "Hent som billede" (html2canvas) kan tegne fotoet uden at blive blokeret.
//
// Endepunkt: /api/opslag-foto?u=<pexels-billed-url>
// Filen skal ligge i mappen /api i roden af dit repo.

export default async function handler(req, res) {
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
