/**
 * Review-platform SEAM (reviews / reputation).
 *
 * The only surface review code calls to resolve the PUBLIC review destination
 * (the Google/Yelp deep link a customer is sent to leave a public review). A real
 * platform integration drops in behind this interface when GOOGLE_REVIEW_URL is
 * configured; until then getReviewProvider() returns a deterministic MOCK so the
 * whole completion -> review-request -> public-link flow is buildable and testable
 * WITHOUT a live link (mirrors the payments provider seam).
 *
 * COMPLIANCE: the public link this returns is offered to EVERYONE who responds,
 * regardless of rating. There is no sentiment-based routing here or anywhere.
 */
export interface ReviewProvider {
  /** "mock" | "google" — recorded for traceability / debugging. */
  readonly name: string;
  /**
   * The public-review destination for an org. Returns the configured deep link,
   * or a deterministic mock placeholder when none is set.
   */
  getPublicReviewUrl(organizationId: string): string;
}

/**
 * Deterministic placeholder used when no real review URL is configured. The URL
 * is a harmless Google "write a review" search seeded by the org id — it is NOT a
 * real business listing, just a stand-in so the flow renders/links end-to-end.
 */
export class MockReviewProvider implements ReviewProvider {
  readonly name = "mock";

  getPublicReviewUrl(organizationId: string): string {
    return `https://search.google.com/local/writereview?placeid=mock-${organizationId}`;
  }
}

/** Backed by a single configured GOOGLE_REVIEW_URL deep link (same link for all
 *  orgs in this single-tenant deployment). */
export class ConfiguredReviewProvider implements ReviewProvider {
  readonly name = "google";
  constructor(private readonly url: string) {}

  getPublicReviewUrl(_organizationId: string): string {
    return this.url;
  }
}

/**
 * Resolve the active review provider. Returns the configured platform link when
 * GOOGLE_REVIEW_URL is set, else the mock. A trailing/leading-whitespace-only
 * value counts as unset.
 */
export function getReviewProvider(): ReviewProvider {
  const url = process.env.GOOGLE_REVIEW_URL?.trim();
  if (url) {
    return new ConfiguredReviewProvider(url);
  }
  // LOUD warning so an operator isn't surprised that customers are being pointed
  // at a placeholder link rather than the real business listing.
  console.warn(
    "[reviews] GOOGLE_REVIEW_URL is not set — using MockReviewProvider. Public review links point to a PLACEHOLDER, not your real listing.",
  );
  return new MockReviewProvider();
}
