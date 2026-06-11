/**
 * Custom Fields CRM System
 *
 * Flexible custom field definitions and values for organizations to extend
 * the built-in CRM data model without code changes.
 */

import { customFieldTypeEnum, customFieldEntityTypeEnum } from "@/lib/db/schema";

// ── Field Definition Types ──

export type CustomFieldType = "text" | "textarea" | "select" | "multiselect" | "number" | "currency" | "date" | "checkbox";
export type CustomFieldEntityType = "customer" | "service_request" | "both";

export interface ValidationRules {
  // For text/textarea
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // For number/currency
  min?: number;
  max?: number;

  // For date
  minDate?: string; // ISO date
  maxDate?: string; // ISO date

  // For select/multiselect (should match options, but can be stricter)
  allowedValues?: string[];
}

export interface CustomFieldDefinition {
  id: string;
  organizationId: string;
  key: string;
  label: string;
  description?: string;
  entityType: CustomFieldEntityType;
  fieldType: CustomFieldType;
  options: string[];
  required: boolean;
  placeholder?: string;
  defaultValue?: unknown;
  validation?: ValidationRules;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFieldDefinitionInput {
  key: string;
  label: string;
  description?: string;
  entityType: CustomFieldEntityType;
  fieldType: CustomFieldType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: unknown;
  validation?: ValidationRules;
  displayOrder?: number;
}

export interface UpdateFieldDefinitionInput {
  label?: string;
  description?: string;
  entityType?: CustomFieldEntityType;
  fieldType?: CustomFieldType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: unknown;
  validation?: ValidationRules;
  displayOrder?: number;
  isActive?: boolean;
}

// ── Field Value Types ──

export type CustomFieldValue =
  | string // text, textarea, select, date
  | string[] // multiselect
  | number // number, currency (stored as cents)
  | boolean // checkbox
  | null;

export interface CustomFieldValueWithMeta {
  fieldKey: string;
  fieldLabel: string;
  fieldType: CustomFieldType;
  value: CustomFieldValue;
}

export interface SetFieldValueInput {
  entityType: CustomFieldEntityType;
  entityId: string;
  fieldKey: string;
  value: unknown;
}

export interface BatchSetFieldValuesInput {
  entityType: CustomFieldEntityType;
  entityId: string;
  values: Record<string, unknown>;
}

// ── Validation Result ──

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── API Response Types ──

export interface FieldDefinitionsResponse {
  fields: CustomFieldDefinition[];
}

export interface FieldValuesResponse {
  values: CustomFieldValueWithMeta[];
}
