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
  readonly createdAt: string;
  readonly updatedAt: string;
}

// Request detail (includes decrypted PII + transcript)
export interface AdminRequestDetail extends AdminRequest {
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly address: string | null;
  readonly scheduledDate: string | null;
  readonly completedAt: string | null;
  readonly assignedTo: string | null;
  readonly transcript: readonly TranscriptMessage[];
  readonly notes: readonly RequestNote[];
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

export interface DashboardStats {
  readonly pending: number;
  readonly assignedToday: number;
  readonly inProgress: number;
  readonly completedToday: number;
}

export interface RequestFilters {
  readonly status?: string;
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
