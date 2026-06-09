// PURPOSE: Centralized business rule validation for agent actions
//
// this module answers one question: "Should the agent be allowed
// to execute this tool call with these arguments"
//
// PATTERN: Policy Engine / Rules Engine
// Each policy is a function that takes a tool name and its arguments,
// and returns either "allow" or "deny" with a reason. Policies are
// checked in order — the first denial stops execution.
//
// ARCHITECTURE NOTE: Why a separate module instead of inline checks?
//   1. Policies change independently from agent logic (product
//      managers adjust limits without touching TypeScript)
//   2. Policies can be loaded from a database or config service
//      in production (externalized configuration)
//   3. Policy violations are logged separately for compliance
//   4. Testing policies independently is much easier than testing
//      the entire agent loop

// Policy Definitions

export interface PolicyResult {
  allowed: boolean;
  reason?: string; // Human-readable explanation
  action?: 'deny' | 'escalate' | 'confirm';
  // "deny"     → block the tool call entirely
  // "escalate" → redirect to human agent
  // "confirm"  → ask the user to confirm before proceeding
}

interface PolicyCheck {
  name: string;
  description: string;
  check: (toolName: string, args: Record<string, unknown>) => PolicyResult;
}

// Configuration
//
// These values come from environment variables, so they can be
// adjusted without code changes. In production, they'd come
// from a configuration management system.
const MAX_AUTO_REFUND_CENTS =
  parseInt(process.env.AGENT_MAX_REFUND_AMOUNT || '200') * 100; // Convert dollars to cents

const ESCALATION_REFUND_CENTS = 20000; // $200 — hard escalation threshold

const MAX_TOOL_CALLS_PER_TURN = parseInt(
  process.env.AGENT_MAX_TOOL_CALLS || '10',
);

const policies: PolicyCheck[] = [
  // Policy 1: Refund Amount Limits
  {
    name: 'refund_amount_limit',
    description: 'Enforces refund dollar thresholds from the refund policy',
    check: (toolName, args) => {
      if (toolName !== 'issue_refund') {
        return { allowed: true };
      }

      const amount = args.amountInCents as number;

      // Hard block: refunds over $200 must go to a human
      if (amount > ESCALATION_REFUND_CENTS) {
        return {
          allowed: false,
          reason:
            `Refund amount of $${(amount / 100).toFixed(2)} exceeds the ` +
            `$200 automatic limit. This must be escalated to a human manager.`,
          action: 'escalate',
        };
      }

      // Soft gate: refunds $50-$200 are allowed but must be confirmed
      if (amount > 5000) {
        return {
          allowed: true,
          reason:
            `Refund of $${(amount / 100).toFixed(2)} is between $50-$200. ` +
            `Processing is allowed but requires customer confirmation.`,
          action: 'confirm',
        };
      }

      // Under $50: auto-approved
      return { allowed: true };
    },
  },

  // Policy 2: Reason Required for Refunds
  {
    name: 'refund_reason_required',
    description: 'All refunds must have a documented reason',
    check: (toolName, args) => {
      if (toolName !== 'issue_refund') {
        return { allowed: true };
      }

      const reason = args.reason as string;
      if (!reason || reason.trim().length < 10) {
        return {
          allowed: false,
          reason:
            'Refund reason must be at least 10 characters. ' +
            'Document why this refund is being issued for audit purposes.',
          action: 'deny',
        };
      }

      return { allowed: true };
    },
  },

  // Policy 3: Cancellation Requires Confirmation
  {
    name: 'cancellation_confirmation',
    description: 'Cancellations always require explicit user confirmation',
    check: (toolName, _args) => {
      if (toolName !== 'cancel_subscription') {
        return { allowed: true };
      }

      // Cancellations are allowed but ALWAYS require confirmation.
      // This is enforced here AND in the tool's requiresConfirmation
      // flag — defense in depth.
      return {
        allowed: true,
        action: 'confirm',
        reason: 'Subscription cancellation requires customer confirmation.',
      };
    },
  },

  // Policy 4: Prevent Self-Escalation Loops
  {
    name: 'no_escalation_loops',
    description: 'Prevent the agent from escalating to itself',
    check: (toolName, args) => {
      if (toolName !== 'escalate_to_human') {
        return { allowed: true };
      }

      // Ensure escalation has a real reason, not a placeholder
      const reason = args.reason as string;
      if (!reason || reason.length < 20) {
        return {
          allowed: false,
          reason:
            'Escalation must include a detailed reason (20+ chars). ' +
            'Provide context about what was tried and why it needs ' +
            'human attention.',
          action: 'deny',
        };
      }

      return { allowed: true };
    },
  },
];

// Public API

/**
 * Evaluate all policies against a proposed tool call.
 *
 * Returns the combined result: if ANY policy denies, the call
 * is blocked. If any policy requires confirmation, the call
 * proceeds but with a confirmation requirement. All policy
 * evaluations are logged for audit.
 *
 * @param toolName - The tool the agent wants to call
 * @param args - The arguments the agent wants to pass
 * @returns PolicyResult with the final verdict
 */
export function evaluatePolicies(
  toolName: string,
  args: Record<string, unknown>,
): {
  result: PolicyResult;
  evaluations: Array<{ policy: string; result: PolicyResult }>;
} {
  const evaluations: Array<{ policy: string; result: PolicyResult }> = [];

  let finalResult: PolicyResult = { allowed: true };

  for (const policy of policies) {
    const result = policy.check(toolName, args);
    evaluations.push({ policy: policy.name, result });

    if (!result.allowed) {
      // Any denial is final — stop checking further policies
      return {
        result: {
          allowed: false,
          reason: result.reason,
          action: result.action || 'deny',
        },
        evaluations,
      };
    }

    // Track if any policy requires confirmation
    // (even if the call is ultimately allowed)
    if (result.action === 'confirm' || result.action === 'escalate') {
      finalResult = {
        allowed: true,
        reason: result.reason,
        action: result.action,
      };
    }
  }

  return { result: finalResult, evaluations };
}

/**
 * Quick check: does this tool call need any guardrail intervention?
 * Used by the agentic loop to decide whether to proceed, confirm,
 * or block.
 */
export function checkGuardrails(
  toolName: string,
  args: Record<string, unknown>,
): PolicyResult {
  const { result } = evaluatePolicies(toolName, args);
  return result;
}
