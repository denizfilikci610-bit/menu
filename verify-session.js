// Serverless-funktion: spørger Stripe, om en betaling rent faktisk er gennemført.
// Kører på Vercel under /api/verify-session?session_id=cs_...
// Det er HER låsen bliver sikker: svaret kommer fra Stripe, ikke fra browseren.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  try {
    const id = req.query.session_id;
    if (!id) {
      res.status(400).json({ paid: false, error: 'Mangler session_id' });
      return;
    }

    const session = await stripe.checkout.sessions.retrieve(id);
    const paid = !!session && session.payment_status === 'paid';

    res.status(200).json({ paid });
  } catch (err) {
    // Ukendt/ugyldig id eller fejl → behandl som ikke betalt
    res.status(200).json({ paid: false, error: err.message });
  }
};
