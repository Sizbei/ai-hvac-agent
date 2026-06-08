/**
 * Admin API request/response types.
 *
 * These types are used by admin route handlers and the admin query module.
 * All interfaces use readonly properties for immutability.
 */

// Request list item (includes decrypted customer name for list display)
export interface AdminRequest {
  readonly id: string;
  readonly status: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly description: string;
  readonly referenceNumber: string;
  readonly customerName: string | null;
  readonly assignedToName: string | null;
  readonly isAfterHours: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// Request detail (includes decrypted PII + transcript)
export interface AdminRequestDetail extends AdminRequest {
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly address: string | null;
  readonly scheduledDate: string | null;
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  readonly holdReason: string | null;
  readonly followUpDate: string | null;
  readonly isAfterHours: boolean;
  readonly afterHoursSurcharge: number;
  readonly completedAt: string | null;
  readonly assignedTo: string | null;
  readonly transcript: readonly TranscriptMessage[];
  readonly notes: readonly RequestNote[];
  // ── ServiceTitan-style intake details (all nullable; PII-free) ──
  readonly intake: RequestIntakeDetails;
}

// Comprehensive intake fields gathered by the chat/voice agent. Surfaced in the
// admin request detail so dispatch sees everything the customer told us.
export interface RequestIntakeDetails {
  readonly jobType: string | null;
  readonly systemType: string | null;
  readonly equipmentBrand: string | null;
  readonly equipmentAgeBand: string | null;
  readonly propertyType: string | null;
  readonly ownerOccupant: string | null;
  readonly underWarranty: string | null;
  readonly accessNotes: string | null;
  readonly systemDownStatus: string | null;
  readonly problemDuration: string | null;
  readonly vulnerableOccupants: boolean | null;
  readonly preferredWindow: string | null;
  readonly contactPreference: string | null;
  readonly smsConsent: boolean | null;
  readonly leadSource: string | null;
}

export interface TranscriptMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly createdAt: string;
}

// Internal staff note on a request (never shown to the customer).
export interface RequestNote {
  readonly id: string;
  readonly content: string;
  readonly authorName: string | null;
  readonly createdAt: string;
}

export interface TechnicianRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly createdAt: string;
}

/** A staff member (admin or technician) for the user-management surface.
 * Unlike TechnicianRecord this carries the role so admins can manage both
 * kinds of user from one screen. */
export interface StaffRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "technician";
  readonly isActive: boolean;
  readonly createdAt: string;
}

export interface CreateStaffInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly role: "admin" | "technician";
}

/** Patch for an existing staff member. Any subset may be present; an empty
 * patch is a no-op. Password reset is a separate, explicit operation. */
export interface UpdateStaffInput {
  readonly name?: string;
  readonly role?: "admin" | "technician";
  readonly isActive?: boolean;
}

export interface DashboardStats {
  readonly pending: number;
  readonly assignedToday: number;
  readonly inProgress: number;
  readonly completedToday: number;
}

export interface RequestFilters {
  readonly status?: string;
  /** Case-insensitive reference-number search (prefix match). Customer names
   * are AES-encrypted and therefore NOT SQL-searchable, so reference number is
   * the searchable key callers quote on the phone. */
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface CreateTechnicianInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export interface UpdateTechnicianInput {
  readonly name?: string;
  readonly email?: string;
  readonly isActive?: boolean;
}
