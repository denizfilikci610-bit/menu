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
    res.status(200).json({ paid: false, error: err.message });
  }
};
