// PURPOSE: Populates your Stripe test account with realistic data.
//
// Run with: npm run seed:stripe
//
// This creates:
//   - 3 products (Starter, Professional, Enterprise)
//   - 3 prices (monthly pricing for each)
//   - 3 customers with different scenarios
//   - Active subscriptions for each customer

import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.dahlia',
});

async function seedStripe() {
  console.log('=== Seeding Stripe Test Data ===\n');

  // ---- Step 1: Create Products ----
  console.log('Creating products...');

  const products = [
    {
      name: 'Starter',
      description: 'Up to 5 team members, 10GB storage',
      monthlyPrice: 2900, // $29.00 in cents
    },
    {
      name: 'Professional',
      description: 'Up to 25 team members, 100GB storage',
      monthlyPrice: 7900, // $79.00
    },
    {
      name: 'Enterprise',
      description: 'Unlimited team members, 1TB storage per seat',
      monthlyPrice: 19900, // $199.00 per seat
    },
  ];

  const createdProducts: Array<{
    product: Stripe.Product;
    price: Stripe.Price;
  }> = [];

  for (const p of products) {
    // Check if product already exists
    // Stripe Search has a slight indexing delay on newly created records
    const existing = await stripe.products.search({
      query: `name:"${p.name}"`,
    });

    let product: Stripe.Product;
    let price: Stripe.Price;

    if (existing.data.length > 0) {
      product = existing.data[0];
      // Get existing price
      const prices = await stripe.prices.list({
        product: product.id,
        active: true,
        limit: 1,
      });
      price = prices.data[0];
      console.log(`  ✓ ${p.name} already exists (${product.id})`);
    } else {
      product = await stripe.products.create({
        name: p.name,
        description: p.description,
      });

      price = await stripe.prices.create({
        product: product.id,
        unit_amount: p.monthlyPrice,
        currency: 'usd',
        recurring: { interval: 'month' },
      });
      console.log(`  ✓ Created ${p.name} (${product.id})`);
    }

    createdProducts.push({ product, price });
  }

  // ---- Step 2: Create Customers ----
  console.log('\nCreating customers...');

  const customers = [
    {
      name: 'Alice Johnson',
      email: 'alice@example.com',
      planIndex: 1, // Professional
      scenario: 'Happy customer, might want to upgrade',
    },
    {
      name: 'Bob Smith',
      email: 'bob@example.com',
      planIndex: 0, // Starter
      scenario: 'Wants a refund, charged recently',
    },
    {
      name: 'Carol Williams',
      email: 'carol@example.com',
      planIndex: 2, // Enterprise
      scenario: 'Wants to cancel, might be retained',
    },
  ];

  for (const c of customers) {
    // Check if customer already exists
    const existing = await stripe.customers.list({
      email: c.email,
      limit: 1,
    });

    let customer: Stripe.Customer;

    if (existing.data.length > 0) {
      customer = existing.data[0];
      console.log(`  ✓ ${c.name} already exists (${customer.id})`);
    } else {
      customer = await stripe.customers.create({
        name: c.name,
        email: c.email,
        metadata: { scenario: c.scenario },
        // Test mode payment method (Stripe provides test tokens)
        payment_method: 'pm_card_visa',
        invoice_settings: {
          default_payment_method: 'pm_card_visa',
        },
      });

      // Create a subscription for this customer
      // In test mode with pm_card_visa, the payment processes automatically.
      // We omit payment_behavior to use the default ("error_if_incomplete"),
      // which will auto-charge the test card and create an active subscription.
      await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: createdProducts[c.planIndex].price.id }],
      });

      console.log(
        `  ✓ Created ${c.name} on ${
          createdProducts[c.planIndex].product.name
        } plan`,
      );
    }
  }

  console.log('\n=== Stripe Seed Complete ===');
  console.log('View your test data at: https://dashboard.stripe.com/test');
}

seedStripe().catch(console.error);
