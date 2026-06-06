// Serverless-funktion: opretter en Stripe Checkout-betaling.
// Kører på Vercel under /api/create-checkout-session
// Din HEMMELIGE nøgle læses fra miljøvariablen STRIPE_SECRET_KEY (aldrig i koden!).

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'dkk',
            product_data: { name: 'Menukort – fjern vandmærke' },
            unit_amount: 9900, // 99,00 kr. angives i øre
          },
          quantity: 1,
        },
      ],
      // Stripe erstatter {CHECKOUT_SESSION_ID} med den rigtige id, når kunden er betalt
      success_url: `${origin}/?betalt={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?afbrudt=1`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
