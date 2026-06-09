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

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-05-27.dahlia',

  // Identify our app in Stripe's logs (helpful for debugging)
  appInfo: {
    name: 'subscription-agent',
    version: '0.1.0',
  },
});

// Standard result type for all Stripe operations.
// Using a discriminated union (success/error) instead of throwing
// exceptions gives the agent structured information about failures
// that it can reason about: "The refund failed because the charge
// is older than 90 days" is actionable; a thrown exception is not.
export type StripeResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };

/**
 * Looks up a customer by email address.
 *
 * WHY EMAIL, NOT STRIPE ID?
 * Customers contact support with their email, not their Stripe
 * customer ID. The agent needs to resolve "I'm john@example.com
 * and I was charged twice" into a Stripe customer object.
 */
export async function lookupCustomerByEmail(
  email: string,
): Promise<StripeResult<CustomerInfo>> {
  try {
    const customers = await stripe.customers.list({
      email: email.toLowerCase(),
      limit: 1,
      expand: ['data.subscriptions'],
    });

    if (customers.data.length === 0) {
      return {
        success: false,
        error: `No customer found with email: ${email}`,
        code: 'customer_not_found',
      };
    }

    const customer = customers.data[0];
    const subscription = customer.subscriptions?.data[0];

    return {
      success: true,
      data: {
        id: customer.id,
        email: customer.email || email,
        name: customer.name ?? null,
        createdAt: new Date(customer.created * 1000).toISOString(),
        subscriptionStatus: subscription?.status || null,
        currentPlan:
          (subscription?.items.data[0]?.price.product as Stripe.Product)
            ?.name || null,
        balance: customer.balance,
      },
    };
  } catch (error) {
    return handleStripeError(error);
  }
}

/**
 * Gets detailed subscription information for a customer.
 */
export async function getSubscription(
  customerId: string,
): Promise<StripeResult<SubscriptionInfo>> {
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 1,
      // expand: ['data.items.data.price.product'],
    });

    if (subscriptions.data.length === 0) {
      return {
        success: false,
        error: 'No subscription found for this customer',
        code: 'subscription_not_found',
      };
    }

    const sub = await stripe.subscriptions.retrieve(subscriptions.data[0].id, {
      expand: ['items.data.price.product'],
    });
    const item = sub.items.data[0];
    const price = item?.price;
    const product = price?.product as Stripe.Product;

    return {
      success: true,
      data: {
        id: sub.id,
        status: sub.status,
        planName: product?.name || 'Unknown Plan',
        planAmount: price?.unit_amount || 0,
        interval: price?.recurring?.interval || 'month',
        // NOTE: In Stripe API 2025-03-31+, current_period_start/end
        // moved from Subscription to SubscriptionItem.
        currentPeriodStart: new Date(
          item.current_period_start * 1000,
        ).toISOString(),
        currentPeriodEnd: new Date(
          item.current_period_end * 1000,
        ).toISOString(),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      },
    };
  } catch (error) {
    return handleStripeError(error);
  }
}

/**
 * Lists recent invoices for a customer.
 */
export async function getInvoices(
  customerId: string,
  limit: number = 5,
): Promise<StripeResult<InvoiceInfo[]>> {
  try {
    // Expand payments to access PaymentIntent IDs.
    // In Stripe Basil+ (2025-03-31), payment_intent was removed from
    // the Invoice object. It's now on the InvoicePayment sub-object.
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit,
      expand: ['data.payments'],
    });

    return {
      success: true,
      data: invoices.data.map((inv) => {
        // Extract PaymentIntent ID from the Invoice Payment object
        const firstPayment = inv.payments?.data?.[0];
        const pi = firstPayment?.payment?.payment_intent;
        const paymentIntentId = typeof pi === 'string' ? pi : pi?.id || null;

        return {
          id: inv.id,
          status: inv.status || 'unknown',
          amountDue: inv.amount_due,
          amountPaid: inv.amount_paid,
          created: new Date(inv.created * 1000).toISOString(),
          periodStart: new Date(inv.period_start * 1000).toISOString(),
          periodEnd: new Date(inv.period_end * 1000).toISOString(),
          hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
          paymentIntentId,
        };
      }),
    };
  } catch (error) {
    return handleStripeError(error);
  }
}

/**
 * Issues a refund for a specific amount.
 *
 * NOTE: This function processes real refunds in Stripe (test mode).
 * The agent's guardrails (Section 9) must validate the amount
 * BEFORE calling this function. This function does NOT enforce
 * business rules — it trusts that the caller has already checked
 * refund eligibility and amount limits.
 *
 * WHY NOT ENFORCE RULES HERE?
 * Separation of concerns. This layer handles "how to talk to
 * Stripe." The guardrails layer handles "should we do this?"
 * Mixing them makes both harder to test and reason about.
 */
export async function issueRefund(
  paymentIntentId: string,
  amountInCents: number,
  reason: string,
): Promise<StripeResult<{ refundId: string; amount: number }>> {
  try {
    // Idempotency key prevents double-refunds if the request is retried
    // (e.g., by withRetry after a network timeout). Built from the inputs
    // so the same refund request always produces the same key.
    const idempotencyKey = `refund_${paymentIntentId}_${amountInCents}`;

    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: amountInCents,
        reason: 'requested_by_customer',
        metadata: {
          agent_reason: reason,
          processed_by: 'ai_agent',
        },
      },
      { idempotencyKey },
    );

    return {
      success: true,
      data: {
        refundId: refund.id,
        amount: refund.amount,
      },
    };
  } catch (error) {
    return handleStripeError(error);
  }
}

/**
 * Cancels a subscription at the end of the current billing period.
 *
 * DESIGN CHOICE: Cancel at period end, not immediately.
 * Immediate cancellation revokes access instantly — bad UX.
 * Cancelling at period end lets the customer keep access through
 * what they've already paid for, which matches our refund policy
 * ("access continues until the end of the current billing period").
 */
export async function cancelSubscription(
  subscriptionId: string,
): Promise<StripeResult<{ cancelAt: string }>> {
  try {
    // Idempotency key prevents double-cancellation on retry.
    // Safe to retry — cancelling an already-cancelled subscription
    // is a no-op in Stripe, but the key makes it explicit.
    const idempotencyKey = `cancel_${subscriptionId}`;

    const subscription = await stripe.subscriptions.update(
      subscriptionId,
      {
        cancel_at_period_end: true,
        expand: ['items'],
      },
      { idempotencyKey },
    );

    return {
      success: true,
      data: {
        // current_period_end moved to SubscriptionItem in Stripe 2025-03-31+
        cancelAt: new Date(
          subscription.items.data[0].current_period_end * 1000,
        ).toISOString(),
      },
    };
  } catch (error) {
    return handleStripeError(error);
  }
}

// ---- Error Handling ----

/**
 * Normalizes Stripe errors into agent-friendly error objects.
 *
 * WHY THIS MATTERS:
 * When the agent calls a tool and it fails, it needs to understand
 * WHY it failed so it can tell the customer something useful.
 * "An error occurred" is useless. "The refund couldn't be processed
 * because the original charge is more than 90 days old" is actionable.
 *
 * We map Stripe's error types to plain English that Claude can
 * include in its response to the customer.
 */
function handleStripeError(error: unknown): StripeResult<never> {
  if (error instanceof Stripe.errors.StripeError) {
    const errorMap: Record<string, string> = {
      card_error: 'The card was declined or has an issue',
      rate_limit_error:
        "We're experiencing high traffic. Please try again shortly",
      invalid_request_error: 'The request was invalid',
      authentication_error: "There's a configuration issue on our end",
      api_error: 'Stripe is experiencing issues. Please try again later',
    };

    return {
      success: false,
      error:
        errorMap[error.type] ||
        error.message ||
        'An unexpected billing error occurred',
      code: error.code || error.type,
    };
  }

  return {
    success: false,
    error: 'An unexpected error occurred while accessing billing',
    code: 'unknown_error',
  };
}
