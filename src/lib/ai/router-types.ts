import { issueTypeValues, urgencyValues } from "./extraction-schema";

export type IssueType = (typeof issueTypeValues)[number];
export type Urgency = (typeof urgencyValues)[number];
export type SlotName = "issueType" | "urgency" | "address" | "name" | "phone" | "email";
export type RouterAction =
  | "ANSWER" | "COLLECT_INFO" | "ESCALATE" | "SUBMIT" | "REDIRECT" | "FALLBACK_LLM";

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
