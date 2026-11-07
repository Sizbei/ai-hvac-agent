/**
 * Site match (M3d spec §7.6), the pure decision over SQL reads. Addresses are
 * passed in already normalised (`normalizeAddress`, admin/location-queries).
 * Never another address of the customer; never a guessed address.
 */
export type SiteScope = "location" | "address" | "none";

export interface SiteSelf {
  readonly hasCustomer: boolean;
  readonly customerErased: boolean;
  readonly locationId: string | null;
  /** This request's normalised address, or null. */
  readonly address: string | null;
}

export interface SiteCandidate {
  readonly id: string;
  readonly locationId: string | null;
  readonly address: string | null;
}

export function siteScopeOf(self: SiteSelf): SiteScope {
  if (!self.hasCustomer || self.customerErased) return "none";
  if (self.locationId !== null) return "location";
  return self.address !== null ? "address" : "none";
}

/** The candidates (the customer's other non-cancelled requests) at this site, in input order. */
export function siteMatches(self: SiteSelf, candidates: readonly SiteCandidate[]): string[] {
  const scope = siteScopeOf(self);
  if (scope === "none") return [];
  return candidates
    .filter((c) => {
      if (c.locationId === null && c.address === null) return false;
      if (scope === "location") {
        return c.locationId === self.locationId || (c.locationId === null && self.address !== null && c.address === self.address);
      }
      return c.address !== null && c.address === self.address;
    })
    .map((c) => c.id);
}

/**
 * Membership is shown only when this request has an address, the customer has
 * at most one location, and EVERY non-cancelled request of the customer (this
 * one included unless cancelled; self is checked through `selfAddress`) has an address normalising to the same one (spec §7.6).
 */
export function membershipEvaluable(selfAddress: string | null, locationCount: number, allAddresses: readonly (string | null)[]): boolean {
  return selfAddress !== null && locationCount <= 1 && allAddresses.every((a) => a === selfAddress);
}
