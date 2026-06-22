/**
 * Custom Field Definitions CRUD
 *
 * Functions for managing custom field definitions per organization.
 */

import { db } from "@/lib/db";
import { customFieldDefinitions } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  CustomFieldDefinition,
  CreateFieldDefinitionInput,
  UpdateFieldDefinitionInput,
} from "./types";
import { validateFieldKey, validateFieldOptions } from "./validation";

/**
 * Creates a new custom field definition for an organization.
 *
 * @param organizationId - The organization ID
 * @param input - Field definition data
 * @returns The created field definition
 * @throws Error if validation fails or key conflicts
 */
export async function createFieldDefinition(
  organizationId: string,
  input: CreateFieldDefinitionInput,
): Promise<CustomFieldDefinition> {
  // Validate key format
  const keyValidation = validateFieldKey(input.key);
  if (!keyValidation.valid) {
    throw new Error(keyValidation.error);
  }

  // Validate options for select/multiselect
  const optionsValidation = validateFieldOptions(input.fieldType, input.options || []);
  if (!optionsValidation.valid) {
    throw new Error(optionsValidation.error);
  }

  // Check for existing active field with same key
  const existing = await db.query.customFieldDefinitions.findFirst({
    where: and(
      eq(customFieldDefinitions.organizationId, organizationId),
      eq(customFieldDefinitions.key, input.key),
      eq(customFieldDefinitions.isActive, true),
    ),
  });

  if (existing) {
    throw new Error(`Field with key "${input.key}" already exists`);
  }

  // Create the field definition
  const [created] = await db
    .insert(customFieldDefinitions)
    .values({
      organizationId,
      key: input.key,
      label: input.label,
      description: input.description,
      entityType: input.entityType,
      fieldType: input.fieldType,
      options: input.options || [],
      required: input.required ?? false,
      placeholder: input.placeholder,
      defaultValue: input.defaultValue,
      validation: input.validation,
      displayOrder: input.displayOrder ?? 0,
    })
    .returning();

  return created as CustomFieldDefinition;
}

/**
 * Gets field definitions for an organization, optionally filtered by entity type.
 *
 * @param organizationId - The organization ID
 * @param entityType - Optional entity type filter
 * @param activeOnly - Whether to return only active fields (default: true)
 * @returns Array of field definitions ordered by display_order
 */
export async function getFieldDefinitions(
  organizationId: string,
  entityType?: "customer" | "service_request",
  activeOnly = true,
): Promise<CustomFieldDefinition[]> {
  const conditions = [eq(customFieldDefinitions.organizationId, organizationId)];

  if (activeOnly) {
    conditions.push(eq(customFieldDefinitions.isActive, true));
  }

  const fields = await db.query.customFieldDefinitions.findMany({
    where: and(...conditions),
    orderBy: [asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.createdAt)],
  });

  // Filter for entityType = "both" if specific type requested
  const filtered = entityType
    ? fields.filter(
        (f) => f.entityType === entityType || f.entityType === "both",
      )
    : fields;

  return filtered as CustomFieldDefinition[];
}

/**
 * Gets a single field definition by ID.
 *
 * @param id - Field definition ID
 * @returns The field definition or null
 */
export async function getFieldDefinitionById(
  id: string,
): Promise<CustomFieldDefinition | null> {
  const field = await db.query.customFieldDefinitions.findFirst({
    where: eq(customFieldDefinitions.id, id),
  });

  return (field as CustomFieldDefinition | null);
}

/**
 * Updates a field definition.
 *
 * @param id - Field definition ID
 * @param input - Update data
 * @returns The updated field definition
 * @throws Error if field not found or validation fails
 */
export async function updateFieldDefinition(
  id: string,
  input: UpdateFieldDefinitionInput,
): Promise<CustomFieldDefinition> {
  const existing = await getFieldDefinitionById(id);
  if (!existing) {
    throw new Error("Field definition not found");
  }

  // If changing key, validate new key
  if (input.key && input.key !== existing.key) {
    const keyValidation = validateFieldKey(input.key);
    if (!keyValidation.valid) {
      throw new Error(keyValidation.error);
    }

    // Check for conflicts with new key
    const conflict = await db.query.customFieldDefinitions.findFirst({
      where: and(
        eq(customFieldDefinitions.organizationId, existing.organizationId),
        eq(customFieldDefinitions.key, input.key),
        eq(customFieldDefinitions.isActive, true),
      ),
    });

    if (conflict && conflict.id !== id) {
      throw new Error(`Field with key "${input.key}" already exists`);
    }
  }

  // If changing to select/multiselect, validate options
  if (input.fieldType && (input.fieldType === "select" || input.fieldType === "multiselect")) {
    const options = input.options ?? existing.options;
    const optionsValidation = validateFieldOptions(input.fieldType, options);
    if (!optionsValidation.valid) {
      throw new Error(optionsValidation.error);
    }
  }

  // Build update object
  const update: Record<string, unknown> = {};
  if (input.label !== undefined) update.label = input.label;
  if (input.description !== undefined) update.description = input.description;
  if (input.entityType !== undefined) update.entityType = input.entityType;
  if (input.fieldType !== undefined) update.fieldType = input.fieldType;
  if (input.options !== undefined) update.options = input.options;
  if (input.required !== undefined) update.required = input.required;
  if (input.placeholder !== undefined) update.placeholder = input.placeholder;
  if (input.defaultValue !== undefined) update.defaultValue = input.defaultValue;
  if (input.validation !== undefined) update.validation = input.validation;
  if (input.displayOrder !== undefined) update.displayOrder = input.displayOrder;
  if (input.isActive !== undefined) update.isActive = input.isActive;

  const [updated] = await db
    .update(customFieldDefinitions)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(customFieldDefinitions.id, id))
    .returning();

  return updated as CustomFieldDefinition;
}

/**
 * Soft-deletes a field definition by setting isActive to false.
 *
 * @param id - Field definition ID
 * @returns The updated (deactivated) field definition
 * @throws Error if field not found
 */
export async function deleteFieldDefinition(
  id: string,
): Promise<CustomFieldDefinition> {
  const existing = await getFieldDefinitionById(id);
  if (!existing) {
    throw new Error("Field definition not found");
  }

  const [deleted] = await db
    .update(customFieldDefinitions)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(customFieldDefinitions.id, id))
    .returning();

  return deleted as CustomFieldDefinition;
}
