/** Shared chat copy used by both the intent router and the chat route. */

/**
 * Sent when all required intake slots are collected and we want the customer to
 * confirm. Does not promise a time/schedule — the team coordinates timing later.
 */
export const CONFIRM_REPLY =
  "Great. I have everything I need. Please review the summary and tap Confirm & Submit to send it to our team.";

/**
 * Warm graceful-degradation reply. Shown instead of a raw error when a chat turn
 * cannot be completed normally — the per-session token budget or turn limit is
 * reached, or the model call fails. The customer should never see a red error
 * box for these; they get connected to a person instead. The route escalates the
 * session alongside this copy so a human picks it up.
 */
export const HANDOFF_REPLY =
  "I want to make sure you're taken care of, so let me connect you with someone on our team who can help from here. Hang tight and we'll be right with you.";
