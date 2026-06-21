# Lusidio

Lav flotte **menukort, visitkort, fødevareetiketter og mere** på få minutter — uden grafiker og uden designprogrammer. Skriv dine oplysninger, vælg en stil, og hent en printklar PDF.

## Indhold

Projektet består af en statisk HTML-frontend i roden og serverless-funktioner i `/api`, der kører på Vercel.

### Sider

| Fil | Beskrivelse |
| --- | --- |
| `index.html` | Forside / landingsside |
| `menukort.html` | Menukort-værktøj |
| `menukort-galleri.html` | Galleri med menukort-eksempler |
| `visitkort.html` | Visitkort-værktøj |
| `etiket.html` | Fødevareetiketter |
| `gavekort.html` | Gavekort |
| `klippekort.html` | Klippekort |
| `sticker.html` | Stickers |
| `opslag-tekst.html` | Opslag til sociale medier (AI-genereret tekst og design) |
| `cookies.html` | Cookiepolitik |

### API (Vercel serverless-funktioner)

| Endepunkt | Beskrivelse |
| --- | --- |
| `api/create-checkout-session.js` | Opretter en Stripe Checkout-betaling (prisen afgøres på serveren) |
| `api/verify-session.js` | Verificerer, om en Stripe-session er betalt |
| `api/billing-portal.js` | Åbner Stripe Customer Portal, så kunden selv kan administrere sit abonnement |
| `api/stripe-webhook.js` | Stripe → Supabase: aktiverer/fornyer/deaktiverer Premium-abonnement |
| `api/opslag-tekst.js` | DeepSeek-tekst og -design + brand-hentning + fotosøgning |
| `api/opslag-foto.js` | Foto-proxy, der streamer Pexels-billeder som samme-origin |

## Miljøvariabler

Funktionerne læser hemmelige nøgler fra miljøvariabler (sættes i Vercel → Settings → Environment Variables — aldrig i koden):

| Variabel | Bruges til |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe-betalinger og abonnement |
| `SUPABASE_URL` | Månedsgrænse / abonnementsstatus |
| `SUPABASE_SERVICE_ROLE_KEY` | Skriveadgang til Supabase (hemmelig) |
| `DEEPSEEK_API_KEY` | Tekst og design til opslag |
| `PEXELS_API_KEY` | Baggrundsfotos (valgfri) |
| `GEMINI_API_KEY` | "Match en stil" — aflæser uploadet layout (valgfri) |

## Udvikling

Frontenden er ren HTML og kan åbnes direkte i en browser. API-funktionerne kører på Vercels Node-runtime; afhængigheder installeres med:

```bash
npm install
```
