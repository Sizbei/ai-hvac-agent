export interface CustomerRecord {
  readonly id: string;
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly propertyType: string | null;
  readonly propertySqft: number | null;
  readonly notes: string | null;
  readonly equipmentCount: number;
  readonly requestCount: number;
  readonly lastServiceDate: string | null;
  readonly createdAt: string;
}

export interface CustomerDetail extends CustomerRecord {
  /** Whether a self-service portal link is currently active for this customer.
   * Boolean only — the portal token/hash is never exposed to the client. */
  readonly portalActive: boolean;
  readonly equipment: readonly EquipmentRecord[];
  readonly serviceHistory: readonly ServiceHistoryRecord[];
  readonly customerNotes: readonly NoteRecord[];
  readonly followUps: readonly FollowUpRecord[];
}

export interface EquipmentRecord {
  readonly id: string;
  readonly equipmentType: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly installDate: string | null;
  readonly warrantyExpiration: string | null;
  readonly locationInHome: string | null;
  readonly notes: string | null;
}

export interface ServiceHistoryRecord {
  readonly id: string;
  readonly serviceRequestId: string | null;
  readonly referenceNumber: string | null;
  readonly issueType: string | null;
  readonly status: string | null;
  readonly workPerformed: string | null;
  readonly partsUsed: string | null;
  readonly cost: number | null;
  readonly technicianNotes: string | null;
  readonly followUpNeeded: boolean;
  readonly createdAt: string;
}

export interface NoteRecord {
  readonly id: string;
  readonly authorName: string | null;
  readonly content: string;
  readonly noteType: string;
  readonly createdAt: string;
}

export interface FollowUpRecord {
  readonly id: string;
  readonly assignedToName: string | null;
  readonly reason: string;
  readonly dueDate: string;
  readonly status: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export interface CreateCustomerInput {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly propertyType?: string;
  readonly propertySqft?: number;
  readonly notes?: string;
}

export interface CreateEquipmentInput {
  readonly equipmentType: string;
  readonly make?: string;
  readonly model?: string;
  readonly serialNumber?: string;
  readonly installDate?: string;
  readonly warrantyExpiration?: string;
  readonly locationInHome?: string;
  readonly notes?: string;
}

/** Patch for an existing equipment row. Any subset of fields may be present.
 * For nullable text/date columns, an explicit `null` clears the field while an
 * absent key leaves it untouched; equipmentType (NOT NULL) can only be set to a
 * new value, never cleared. */
export interface UpdateEquipmentInput {
  readonly equipmentType?: string;
  readonly make?: string | null;
  readonly model?: string | null;
  readonly serialNumber?: string | null;
  readonly installDate?: string | null;
  readonly warrantyExpiration?: string | null;
  readonly locationInHome?: string | null;
  readonly notes?: string | null;
}

export type UpdateEquipmentResult =
  | { readonly ok: true; readonly updatedFields: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "no_changes" | "invalid_type";
    };

export interface CreateNoteInput {
  readonly content: string;
  readonly noteType?: string;
}

export interface CreateFollowUpInput {
  readonly reason: string;
  readonly dueDate: string;
  readonly assignedTo?: string;
}

/**
 * Editable customer contact/property fields. Every field is optional so the
 * caller can patch a subset; `null` explicitly clears a value (e.g. removing an
 * email) while `undefined` leaves it untouched. `name` cannot be cleared — the
 * underlying column is NOT NULL — so it is `string | undefined` only.
 */
export interface UpdateCustomerInput {
  readonly name?: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly propertyType?: string | null;
  readonly propertySqft?: number | null;
  readonly notes?: string | null;
}

export type UpdateCustomerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "contact_conflict" };
