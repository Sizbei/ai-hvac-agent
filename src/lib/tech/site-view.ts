/** Site page read model types (M3d spec §7.6). Client-safe. */
import type { SiteScope } from "@/lib/forms/site-scope";

export interface SitePastJob {
  readonly id: string;
  readonly referenceNumber: string;
  readonly date: string;
  readonly status: string;
  /** The job type's name, else the issue label. */
  readonly kind: string;
  /** First name only. */
  readonly leadTechnicianName: string | null;
  readonly submittedFormNames: readonly string[];
}

export interface SiteEstimate {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly totalCents: number;
  readonly optionCount: number;
  readonly thisJob: boolean;
  readonly fromFieldPulse: boolean;
}

export type SiteMembership =
  | {
      readonly state: "member";
      readonly planName: string;
      readonly startedAt: string;
      readonly currentPeriodEnd: string | null;
      readonly visitsPerYear: number;
      readonly upcoming: ReadonlyArray<{ readonly dueDate: string; readonly status: "scheduled" | "generated"; readonly thisJob: boolean }>;
    }
  | { readonly state: "none" }
  | { readonly state: "withheld" };

export interface SiteView {
  readonly scope: SiteScope;
  readonly title: string;
  readonly pastJobs: readonly SitePastJob[];
  readonly unaddressedCount: number;
  readonly openEstimates: readonly SiteEstimate[];
  readonly membership: SiteMembership;
  readonly hasCustomer: boolean;
  /** The caller leads the active visit (`isActiveLead`): only then are this job's open estimates links (spec §7.6). */
  readonly isLead: boolean;
}
