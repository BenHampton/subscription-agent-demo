// PURPOSE: Tools that interact with Stripe's billing API

import { RegisteredTool } from '@/lib/agent/types';
import { z } from 'zod';
import {
  lookupCustomerByEmail,
  getSubscription,
  getInvoices,
  issueRefund,
  cancelSubscription,
} from '@/lib/services/stripe';

// ---- Zod Schemas for Argument Validation ----
// Each schema matches the input_schema defined in the tool's
// Anthropic definition. Zod validates at runtime what JSON Schema
// validates at the API level — belt AND suspenders.

const LookupArgs = z.object({
  email: z.string().email('Invalid email format'),
});

const CustomerIdArgs = z.object({
  customerId: z.string().startsWith('cus_', 'Must be a Stripe customer ID'),
});

const InvoiceArgs = z.object({
  customerId: z.string().startsWith('cus_'),
  limit: z.number().min(1).max(10).optional().default(5),
});

const RefundArgs = z.object({
  paymentIntentId: z.string().startsWith('pi_', 'Must be a payment intent ID'),
  amountInCents: z
    .number()
    .positive('Amount must be positive')
    .max(20000, 'Refunds over $200 must be escalated'),
  reason: z.string().min(1, 'Reason is required'),
});

const CancelArgs = z.object({
  subscriptionId: z.string().startsWith('sub_', 'Must be a subscription ID'),
});

// Read Tools (no confirmation needed)

export const lookupCustomerTool: RegisteredTool = {
  definition: {
    name: 'lookup_customer',
    description:
      'Look up a customer by their email address. Returns their ' +
      'account details, current subscription plan, and account ' +
      'balance. Use this as the FIRST step when a customer ' +
      'contacts support — you need their customer ID for all ' +
      'other billing operations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: {
          type: 'string',
          description: "The customer's email address (case-insensitive).",
        },
      },
      required: ['email'],
    },
  },
  handler: async (args, context) => {
    const parsed = LookupArgs.safeParse(args);
    if (!parsed.success)
      return JSON.stringify({
        success: false,
        error: parsed.error.issues[0].message,
      });
    const result = await lookupCustomerByEmail(parsed.data.email);
    return JSON.stringify(result);
  },
  requiresConfirmation: false,
  category: 'billing',
};

export const getSubscriptionTool: RegisteredTool = {
  definition: {
    name: 'get_subscription',
    description:
      'Get detailed subscription information for a customer, ' +
      'including their current plan name, price, billing interval, ' +
      'current period dates, and whether cancellation is pending. ' +
      "Requires the customer's Stripe ID (get it from " +
      'lookup_customer first).',
    input_schema: {
      type: 'object' as const,
      properties: {
        customerId: {
          type: 'string',
          description:
            "The Stripe customer ID (starts with 'cus_'). " +
            'Get this from the lookup_customer tool.',
        },
      },
      required: ['customerId'],
    },
  },
  handler: async (args, context) => {
    const parsed = CustomerIdArgs.safeParse(args);
    if (!parsed.success)
      return JSON.stringify({
        success: false,
        error: parsed.error.issues[0].message,
      });
    const result = await getSubscription(parsed.data.customerId);
    return JSON.stringify(result);
  },
  requiresConfirmation: false,
  category: 'billing',
};

export const getInvoicesTool: RegisteredTool = {
  definition: {
    name: 'get_invoices',
    description:
      'List recent invoices for a customer, showing amounts, ' +
      'dates, and payment status. Useful for investigating ' +
      'billing disputes, double charges, or providing payment ' +
      'history. Returns the 5 most recent invoices by default.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customerId: {
          type: 'string',
          description: "The Stripe customer ID (starts with 'cus_').",
        },
        limit: {
          type: 'number',
          description: 'Number of invoices to return (1-10, default 5).',
        },
      },
      required: ['customerId'],
    },
  },
  handler: async (args, context) => {
    const parsed = InvoiceArgs.safeParse(args);
    if (!parsed.success)
      return JSON.stringify({
        success: false,
        error: parsed.error.issues[0].message,
      });
    const result = await getInvoices(parsed.data.customerId, parsed.data.limit);
    return JSON.stringify(result);
  },
  requiresConfirmation: false,
  category: 'billing',
};

// Write Tools (confirmation required)

export const issueRefundTool: RegisteredTool = {
  definition: {
    name: 'issue_refund',
    description:
      'Issue a refund to a customer. IMPORTANT RULES: ' +
      '(1) Refunds up to $50 can be processed automatically. ' +
      '(2) Refunds between $50-$200 require documenting the reason. ' +
      '(3) Refunds over $200 MUST be escalated to a human manager — ' +
      'do NOT call this tool for amounts over $200. ' +
      '(4) Always verify refund eligibility by searching the ' +
      'knowledge base BEFORE calling this tool. ' +
      '(5) Always confirm the refund with the customer before ' +
      'processing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        paymentIntentId: {
          type: 'string',
          description:
            "The payment intent ID to refund (starts with 'pi_'). " +
            'Get this from the invoice details.',
        },
        amountInCents: {
          type: 'number',
          description:
            'The refund amount in cents (e.g., 2900 for $29.00). ' +
            'Must not exceed $200 (20000 cents).',
        },
        reason: {
          type: 'string',
          description:
            'The reason for the refund. Be specific — this is ' +
            'logged for audit purposes.',
        },
      },
      required: ['paymentIntentId', 'amountInCents', 'reason'],
    },
  },
  handler: async (args, context) => {
    const parsed = RefundArgs.safeParse(args);
    if (!parsed.success)
      return JSON.stringify({
        success: false,
        error: parsed.error.issues[0].message,
      });
    const result = await issueRefund(
      parsed.data.paymentIntentId,
      parsed.data.amountInCents,
      parsed.data.reason,
    );
    return JSON.stringify(result);
  },
  // CRITICAL: This tool changes real data — requires confirmation
  requiresConfirmation: true,
  category: 'billing',
};

export const cancelSubscriptionTool: RegisteredTool = {
  definition: {
    name: 'cancel_subscription',
    description:
      "Cancel a customer's subscription at the end of the current " +
      'billing period. The customer retains access until the period ' +
      'ends. This action can be reversed before the period ends. ' +
      "Before cancelling, ALWAYS: (1) Ask the customer if they're " +
      'sure, (2) Check if a discount or plan change might retain ' +
      'them, (3) Confirm they understand access continues until ' +
      'the period end date.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subscriptionId: {
          type: 'string',
          description:
            "The Stripe subscription ID (starts with 'sub_'). " +
            'Get this from get_subscription.',
        },
      },
      required: ['subscriptionId'],
    },
  },
  handler: async (args, context) => {
    const parsed = CancelArgs.safeParse(args);
    if (!parsed.success)
      return JSON.stringify({
        success: false,
        error: parsed.error.issues[0].message,
      });
    const result = await cancelSubscription(parsed.data.subscriptionId);
    return JSON.stringify(result);
  },
  requiresConfirmation: true,
  category: 'billing',
};

// Escalation Tool

export const escalateToHumanTool: RegisteredTool = {
  definition: {
    name: 'escalate_to_human',
    description:
      'Escalate the conversation to a human support agent. Use ' +
      "this when: (1) The customer's issue is outside your " +
      'capabilities, (2) A refund exceeds $200, (3) The customer ' +
      'explicitly asks to speak to a human, (4) You are not ' +
      'confident in your ability to resolve the issue. Include ' +
      'a detailed summary so the human agent has full context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description:
            'Why this is being escalated. Be specific about ' +
            'what was tried and why it needs human attention.',
        },
        summary: {
          type: 'string',
          description:
            'A comprehensive summary of the conversation so far, ' +
            'including customer details, what they want, what ' +
            "you've already checked, and any relevant data.",
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description:
            "Urgency level. 'urgent' for billing errors actively " +
            "affecting the customer, 'high' for frustrated " +
            "customers or complex issues, 'medium' for standard " +
            "escalations, 'low' for feature requests.",
        },
      },
      required: ['reason', 'summary', 'priority'],
    },
  },
  handler: async (args, context) => {
    // In production, this would create a ticket in Zendesk/Jira,
    // send a Slack notification, or page an on-call agent.
    // For our demo, we log it and return a confirmation.
    console.log('🚨 ESCALATION:', {
      reason: args.reason,
      summary: args.summary,
      priority: args.priority,
    });

    return JSON.stringify({
      success: true,
      ticketId: `ESC-${Date.now()}`,
      message: 'Conversation escalated to human support team.',
      estimatedWait: args.priority === 'urgent' ? '5 minutes' : '2 hours',
    });
  },
  requiresConfirmation: false, // Escalation is always safe to do
  category: 'escalation',
};
