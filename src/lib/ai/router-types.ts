import { issueTypeValues, urgencyValues } from "./extraction-schema";

export type IssueType = (typeof issueTypeValues)[number];
export type Urgency = (typeof urgencyValues)[number];
export type SlotName = "issueType" | "urgency" | "address" | "name" | "phone" | "email";
export type RouterAction =
  | "ANSWER" | "COLLECT_INFO" | "ESCALATE" | "SUBMIT" | "REDIRECT" | "FALLBACK_LLM"
  // An account-specific question that needs a live, customer-scoped data read
  // (membership / next visit / balance / appointment / reschedule). The router
  // only RECOGNIZES it and surfaces the intentId; the chat route enforces the
  // identity gate and dispatches to the account-tools. For an UNIDENTIFIED
  // session the route treats this exactly like FALLBACK_LLM (no leak).
  | "ACCOUNT_LOOKUP"
  // A deterministic ambiguity probe (CHATBOT-PLAN Step 16): the message matched
  // a small, common ambiguity (e.g. "it's not working" — not cooling vs not
  // heating) where a crisp clarifying question beats punting to the LLM. The
  // router carries the question as `reply`; the chat route serves it as a canned
  // reply (it's not FALLBACK_LLM/COLLECT_INFO/SUBMIT, so useCannedReply serves
  // it). LOWEST precedence — emergency/compound/known-intent all win first.
  | "CLARIFY";

export interface KnowledgeBaseEntry {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  /** Lowercased trigger keywords/phrases. Multi-word phrases are weighted higher by the router. */
  readonly triggerKeywords: readonly string[];
  /** Phrases that, if present, SUPPRESS this entry from matching (e.g. "no gas smell", "gas furnace"). */
  readonly negationGuards?: readonly string[];
  /** For emergency entries: at least one of these qualifier tokens MUST co-occur, else do not match. */
  readonly requiredQualifiers?: readonly string[];
  readonly action: RouterAction;
  readonly cannedResponse: string;
  readonly infoNeeded: readonly SlotName[];
  readonly issueTypeMapping: IssueType | null;
  readonly urgencyHint: Urgency | null;
  readonly notes?: string;
}
