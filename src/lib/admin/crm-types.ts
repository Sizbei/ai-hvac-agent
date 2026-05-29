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

export interface CreateNoteInput {
  readonly content: string;
  readonly noteType?: string;
}

export interface CreateFollowUpInput {
  readonly reason: string;
  readonly dueDate: string;
  readonly assignedTo?: string;
}
