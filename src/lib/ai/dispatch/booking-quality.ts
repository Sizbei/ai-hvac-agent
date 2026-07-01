/**
 * Pre-assign booking-quality gate (Probook parity: "clean every booking before
 * it's assigned to a technician"). Pure + deterministic — no I/O, no PII: it takes
 * presence flags + an optional distance and reports whether the booking is clean
 * enough to AUTO-dispatch, or should go to a human to clean up first.
 *
 * A dirty booking (no address, no way to reach the customer, no issue, or clearly
 * out of the service area) must never be silently auto-assigned to a tech.
 */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

export interface BookingQualityInput {
  /** The request has a stored service address. */
  readonly hasAddress: boolean;
  /** The request has at least one contact method (phone or email). */
  readonly hasContact: boolean;
  /** The request has a classified issue type. */
  readonly hasIssueType: boolean;
  /** Straight-line km from the service address to the business base, when the job
   * has been geocoded; null/undefined when coords aren't known yet. */
  readonly distanceKm?: number | null;
}

export interface BookingQualityResult {
  readonly clean: boolean;
  readonly issues: readonly string[];
}

// A geocoded address beyond this multiple of the service radius is out of area.
const OUT_OF_AREA_FACTOR = 1.25;

/** Assess whether a booking is clean enough to auto-dispatch. Pure. */
export function assessBookingQuality(
  input: BookingQualityInput,
): BookingQualityResult {
  const issues: string[] = [];
  if (!input.hasAddress) issues.push("no service address");
  if (!input.hasContact) issues.push("no contact method");
  if (!input.hasIssueType) issues.push("no issue type");
  if (
    input.distanceKm != null &&
    input.distanceKm >
      BUSINESS_BASE_LOCATION.serviceRadiusKm * OUT_OF_AREA_FACTOR
  ) {
    issues.push(`${input.distanceKm.toFixed(0)}km outside the service area`);
  }
  return { clean: issues.length === 0, issues };
}
