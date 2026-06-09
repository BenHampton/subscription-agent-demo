// PURPoSE: Manages pending actions that require user confirmation.
//
// When the agent wants to do something destructive (refund, cancel),
// we don't execute immediately. Instead, we store the pending action
// and ask the user to confirm. When they confirm, we retrieve the
// pending action and execute it.
//
// PATTERN: Pending Action Store
// This is essentially a simple state machine:
//   1. Agent proposes action → stored as "pending"
//   2. User confirms → action executed, state cleared
//   3. User declines → state cleared, agent informed
//   4. Timeout → state cleared (prevents stale actions)
//
// STORAGE: In-memory Map for simplicity.
// In production, pending actions would live in the database (the
// conversations table, or a dedicated pending_actions table) so
// they survive server restarts and work across multiple instances.
// For a demo, in-memory is fine.

export interface PendingAction {
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  proposedAt: Date;
  conversationId: string;
  // The guardrail evaluation that triggered confirmation
  guardrailReason: string;
}

// Store
//
// Map of conversationId → pending action
// Each conversation can have at most ONE pending action at a time.
// If the agent proposes a new action before the previous one is
// confirmed, the old one is replaced (last-write-wins).
const pendingActions = new Map<string, PendingAction>();

// Pending actions expire after 10 minutes.
// If a customer walks away mid-confirmation, we don't want a
// stale refund sitting there waiting to be accidentally triggered
// in a future conversation.
const EXPIRY_MS = 10 * 60 * 1000;

// Public API
/**
 * Store a pending action for a conversation.
 */
export function setPendingAction(action: PendingAction): void {
  pendingActions.set(action.conversationId, action);
}

/**
 * Retrieve and clear a pending action for a conversation.
 * Returns null if no action is pending or if it has expired.
 *
 * IMPORTANT: This function CLEARS the pending action after
 * retrieving it. This prevents double-execution — even if the
 * user somehow sends two "yes" messages, only the first one
 * triggers the action.
 */
export function consumePendingAction(
  conversationId: string,
): PendingAction | null {
  const action = pendingActions.get(conversationId);

  if (!action) return null;

  // Check expiry
  if (Date.now() - action.proposedAt.getTime() > EXPIRY_MS) {
    pendingActions.delete(conversationId);
    return null;
  }

  // Clear after retrieval (single-use)
  pendingActions.delete(conversationId);
  return action;
}

/**
 * Cancel a pending action without executing it.
 * Called when the user says "no" or "never mind."
 */
export function cancelPendingAction(conversationId: string): boolean {
  return pendingActions.delete(conversationId);
}

/**
 * Check if a conversation has a pending action.
 * Used by the API route to know whether to show a confirmation UI.
 */
export function hasPendingAction(conversationId: string): boolean {
  const action = pendingActions.get(conversationId);
  if (!action) return false;

  // Check expiry
  if (Date.now() - action.proposedAt.getTime() > EXPIRY_MS) {
    pendingActions.delete(conversationId);
    return false;
  }

  return true;
}
