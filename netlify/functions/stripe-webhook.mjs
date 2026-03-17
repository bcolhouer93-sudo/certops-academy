const STRIPE_WEBHOOK_SECRET = 'whsec_0SGJlJYbITOjrYRMgyVqx7YJ23F36HUB';
const SUPABASE_URL = 'https://dfbylunacfziuejbfbqw.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmYnlsdW5hY2Z6aXVlamJmYnF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzcwMTAwOCwiZXhwIjoyMDg5Mjc3MDA4fQ.0WRGDDShfv6b4cm9yjhz0EAPsURXqnNQVrO4wPmJln4';

async function verifyStripeSignature(payload, sigHeader) {
  const parts = {};
  sigHeader.split(',').forEach(p => {
    const [k, v] = p.split('=');
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  });
  const timestamp = parts['t'] ? parts['t'][0] : null;
  const signatures = parts['v1'] || [];
  if (!timestamp || signatures.length === 0) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return signatures.includes(computed);
}

async function getCustomerEmail(customerId) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) { console.log('STRIPE_SECRET_KEY not set'); return null; }
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    headers: { 'Authorization': `Basic ${btoa(stripeKey + ':')}` }
  });
  if (res.ok) { const c = await res.json(); return c.email; }
  return null;
}

async function updateSupabasePlan(email, plan) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ plan })
  });
  return res.status;
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.text();
  const sigHeader = req.headers.get('stripe-signature');
  if (!sigHeader) return new Response('No signature', { status: 400 });

  const valid = await verifyStripeSignature(body, sigHeader);
  if (!valid) { console.log('Invalid signature'); return new Response('Invalid signature', { status: 400 }); }

  const event = JSON.parse(body);
  console.log('Stripe event:', event.type);

  if (event.type === 'customer.subscription.deleted') {
    const email = await getCustomerEmail(event.data.object.customer);
    if (email) { const s = await updateSupabasePlan(email, 'free'); console.log(`Cancelled: ${email} -> free (${s})`); }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const email = await getCustomerEmail(sub.customer);
    if (email) {
      if (sub.status === 'active' || sub.status === 'trialing') {
        const amount = sub.items?.data?.[0]?.price?.unit_amount;
        const plan = amount >= 4900 ? 'commander' : 'operator';
        const s = await updateSupabasePlan(email, plan); console.log(`Active: ${email} -> ${plan} (${s})`);
      } else {
        const s = await updateSupabasePlan(email, 'free'); console.log(`Inactive (${sub.status}): ${email} -> free (${s})`);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
