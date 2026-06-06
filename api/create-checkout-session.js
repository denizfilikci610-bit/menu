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
            unit_amount: 9900,
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/?betalt={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?afbrudt=1`,
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
