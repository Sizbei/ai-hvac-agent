/**
 * Pure: what the customer chat offers once a session leaves active intake.
 *
 * The server refuses new messages for an escalated / abandoned session
 * (`isTerminalState` in the chat route) and for a submitted one, so the input
 * stays locked there. The customer must still see why, and how to reach a
 * person: an escalated chat shows a persistent panel with the org's phone as a
 * `tel:` link, and "Talk to a human" turns into that call link instead of
 * going dead. An emergency escalation with no org phone on file falls back to
 * the generic safety line.
 */
import type { SessionState } from "@/lib/ai/state-machine";
import { telHref } from "@/lib/portal/portal-notice";

/**
 * Always shown first in the emergency panel, phone on file or not: the safety
 * call comes before ours (round-2 UX N-P1-5). A UI constant, not frozen
 * prompt text.
 */
export const EMERGENCY_GENERIC_GUIDANCE =
  "If you smell gas, leave now and call 911 or your gas company from outside.";

export type ChatEndPanelKind = "emergency" | "handoff";

export interface ChatEndPanel {
  readonly kind: ChatEndPanelKind;
  readonly title: string;
  readonly body: string;
  /** The 911 / gas company safety line, set for every emergency panel. */
  readonly guidance: string | null;
}

/**
 * - `dialog`: the normal confirm-then-escalate dialog.
 * - `call`: a `tel:` link to the org (the chat is already with a person).
 * - `show-panel`: scroll to and focus the end panel (escalated, no phone).
 * - `disabled`: nothing useful to offer (submitted/abandoned with no phone).
 */
export type TalkToHumanAction = "dialog" | "call" | "show-panel" | "disabled";

export interface ChatEndActions {
  readonly panel: ChatEndPanel | null;
  readonly inputDisabled: boolean;
  /** Why the input is locked, shown next to it. Null while the chat is open. */
  readonly inputNote: string | null;
  readonly talkToHuman: TalkToHumanAction;
  /** The org phone as displayed, when it yields a usable `tel:` link. */
  readonly phone: string | null;
  readonly callHref: string | null;
}

export interface ChatEndInput {
  readonly status: SessionState;
  /** The session's captured urgency (from the polled extraction), if any. */
  readonly urgency: string | null | undefined;
  /** The org's business phone, if configured. */
  readonly phone: string | null | undefined;
}

export function chatEndActions({
  status,
  urgency,
  phone,
}: ChatEndInput): ChatEndActions {
  const display = phone?.trim() ?? "";
  const callHref = display ? telHref(display) : null;
  const callPhone = callHref ? display : null;

  if (status === "escalated") {
    const emergency = urgency === "emergency";
    const panel: ChatEndPanel = emergency
      ? {
          kind: "emergency",
          title: "We've flagged this as an emergency",
          body: callPhone
            ? `Once you're safe, call us at ${callPhone} with your address and a callback number.`
            : "Our team has been alerted and will follow up.",
          guidance: EMERGENCY_GENERIC_GUIDANCE,
        }
      : {
          kind: "handoff",
          title: "A person from our team will follow up",
          body: callPhone
            ? `Need us sooner? Call ${callPhone}.`
            : "They'll reach out as soon as they can.",
          guidance: null,
        };
    return {
      panel,
      inputDisabled: true,
      inputNote: "This chat is closed so our team can take over.",
      talkToHuman: callHref ? "call" : "show-panel",
      phone: callPhone,
      callHref,
    };
  }

  if (status === "submitted" || status === "abandoned") {
    return {
      panel: null,
      inputDisabled: true,
      inputNote:
        status === "submitted"
          ? "Your request is in. Start a new conversation to ask something else."
          : "This chat has ended. Start a new conversation to keep going.",
      talkToHuman: callHref ? "call" : "disabled",
      phone: callPhone,
      callHref,
    };
  }

  return {
    panel: null,
    inputDisabled: false,
    inputNote: null,
    talkToHuman: "dialog",
    phone: callPhone,
    callHref,
  };
}
