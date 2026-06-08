import Stripe from 'stripe';

export interface CustomerInfo {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  subscriptionStatus: string | null;
  currentPlan: string | null;
  balance: number; // in cents (negative = credit owed to customer)
}

export interface SubscriptionInfo {
  id: string;
  status: string;
  planName: string;
  planAmount: number; // in cents
  interval: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

export interface InvoiceInfo {
  id: string;
  status: string;
  amountDue: number; // in cents
  amountPaid: number;
  created: string;
  periodStart: string;
  periodEnd: string;
  hostedInvoiceUrl: string | null;
  // The payment intent ID — needed for issuing refunds.
  // This is the link between an invoice and Stripe's refund API.
  paymentIntentId: string | null;
}

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error(
    'STRIPE_SECRET_KEY is not set. Get one at: ' +
      'https://dashboard.stripe.com/test/apikeys',
  );
}

if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  throw new Error(
    'STRIPE_SECRET_KEY must be a test key (starts with sk_test_). ' +
      'Using a live key in development could process real charges.',
  );
}
