/** Slim record used on the customer list page — excludes heavy/unused fields. */
/** A page of the customers list plus the total match count and the distinct
 * property types (for the filter dropdown, which can't be derived client-side
 * once the list is server-paginated). */
export interface CustomerListPage {
  readonly customers: readonly CustomerListRecord[];
  readonly total: number;
  readonly propertyTypes: readonly string[];
}

export interface CustomerListRecord {
  readonly id: string;
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly propertyType: string | null;   // used for the property-type filter dropdown
  readonly equipmentCount: number;
  readonly requestCount: number;
  readonly lastServiceDate: string | null;
  readonly createdAt: string;
  readonly customerType: string;
  readonly membershipStatus: string;
  readonly fieldpulseCustomerId: string | null;
  readonly archivedAt: string | null;
}

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
  readonly customerType: string;
  readonly membershipStatus: string;
  readonly fieldpulseCustomerId: string | null;
  readonly archivedAt: string | null;
}

export interface CustomerDetail extends CustomerRecord {
  /** Whether a self-service portal link is currently active for this customer.
   * Boolean only — the portal token/hash is never exposed to the client. */
  readonly portalActive: boolean;
  readonly fieldpulseCustomFields: readonly { readonly name: string; readonly value: string }[] | null;
  readonly equipment: readonly EquipmentRecord[];
  readonly serviceHistory: readonly ServiceHistoryRecord[];
  readonly customerNotes: readonly NoteRecord[];
  readonly followUps: readonly FollowUpRecord[];
  /** Whether this customer is tax-exempt (from FP is_tax_exempt). Null for native rows. */
  readonly isTaxExempt: boolean | null;
  /** Decrypted billing address (from FP billing_address_encrypted), when it differs
   * from the service address. Null for native rows or when not present. */
  readonly billingAddress: string | null;
  /** FieldPulse spillover data for the detail panel; null when not a FP customer or empty. */
  readonly fieldpulseData: Record<string, unknown> | null;
}

export interface EquipmentRecord {
  readonly id: string;
  readonly equipmentType: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly installDate: string | null;
  // warrantyExpiration is the single authoritative expiry the proactive
  // reminder sweep keys off.
  readonly warrantyExpiration: string | null;
  // Warranty-tracking fields (parity stage).
  readonly warrantyType: string | null;
  readonly warrantyProvider: string | null;
  readonly locationInHome: string | null;
  readonly notes: string | null;
  readonly fieldpulseAssetId: string | null;
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
  readonly fieldpulseCommentId: string | null;
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
  readonly warrantyType?: string;
  readonly warrantyProvider?: string;
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
  readonly warrantyType?: string | null;
  readonly warrantyProvider?: string | null;
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
