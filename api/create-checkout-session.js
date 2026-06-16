// Serverless-funktion: opretter en Stripe Checkout-betaling.
// Kører på Vercel under /api/create-checkout-session
// Din HEMMELIGE nøgle læses fra miljøvariablen STRIPE_SECRET_KEY (aldrig i koden!).
//
// Understøtter flere produkter. Prisen afgøres ALTID her på serveren,
// så den ikke kan manipuleres fra browseren. Værktøjet sender selv sin
// egen sti med, så Stripe altid kan returnere kunden til præcis den side,
// han startede fra — uanset hvad filerne hedder.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRODUCTS = {
  menukort:  { name: 'Menukort – fjern vandmærke',  amount: 9900 },
  visitkort: { name: 'Visitkort – fjern vandmærke', amount: 4900 },
  etiket:    { name: 'Etiket – fjern vandmærke',    amount: 4900 },
  klippekort:{ name: 'Klippekort – fjern vandmærke', amount: 4900 },
  sticker:   { name: 'Sticker – fjern vandmærke',   amount: 3900 },
  gavekort:  { name: 'Gavekort – fjern vandmærke',  amount: 4900 },
};

// Kun sikre stier inde på selve sitet — vi tillader ikke at sende folk til et fremmed domæne
function safeReturnPath(p){
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return '/';
  return p;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const origin = req.headers.origin || `https://${req.headers.host}`;

    // Vælg produkt ud fra anmodningen. Vi slår direkte op i PRODUCTS, så
    // hvert værktøj får PRÆCIS sit eget produkt. Et ukendt (eller manglende)
    // produkt afvises med en fejl i stedet for at falde tilbage til menukort
    // — netop dét gjorde tidligere, at etiket-køb viste menukort i Stripe.
    const key = req.body && req.body.product;
    const product = PRODUCTS[key];
    if (!product) {
      res.status(400).json({ error: 'Ukendt produkt: ' + key });
      return;
    }

    // Værktøjet sender sin egen returneringssti med (fx '/visitkort.html').
    // Hvis intet er sendt, falder vi tilbage til forsiden.
    const returnPath = safeReturnPath(req.body && req.body.returnPath);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'dkk',
            product_data: { name: product.name },
            unit_amount: product.amount, // angives i øre
          },
          quantity: 1,
        },
      ],
      // Stripe erstatter {CHECKOUT_SESSION_ID} med den rigtige id, når kunden har betalt
      success_url: `${origin}${returnPath}?betalt={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}${returnPath}?afbrudt=1`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
