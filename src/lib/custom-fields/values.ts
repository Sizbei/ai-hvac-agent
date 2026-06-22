/**
 * Custom Field Values CRUD
 *
 * Functions for managing custom field values on entities.
 */

import { db } from "@/lib/db";
import { customFieldDefinitions, customFieldValues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  CustomFieldValueWithMeta,
  SetFieldValueInput,
  BatchSetFieldValuesInput,
  CustomFieldEntityType,
  type CustomFieldType,
  type CustomFieldValue,
} from "./types";
import { validateFieldValue } from "./validation";

/**
 * Sets a custom field value on an entity.
 *
 * @param organizationId - The organization ID
 * @param input - Value data including entityType, entityId, fieldKey, and value
 * @returns The created/updated field value with metadata
 * @throws Error if field not found or validation fails
 */
export async function setFieldValue(
  organizationId: string,
  input: SetFieldValueInput,
): Promise<CustomFieldValueWithMeta> {
  // Find the field definition by key
  const fieldDef = await db.query.customFieldDefinitions.findFirst({
    where: and(
      eq(customFieldDefinitions.organizationId, organizationId),
      eq(customFieldDefinitions.key, input.fieldKey),
      eq(customFieldDefinitions.isActive, true),
    ),
  });

  if (!fieldDef) {
    throw new Error(`Field "${input.fieldKey}" not found`);
  }

  // Validate the field applies to this entity type
  if (fieldDef.entityType !== "both" && fieldDef.entityType !== input.entityType) {
    throw new Error(`Field "${input.fieldKey}" does not apply to ${input.entityType}`);
  }

  // Validate the value
  const validation = validateFieldValue(fieldDef, input.value);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
  }

  // Upsert the value (delete existing if setting to null/undefined, otherwise insert/update)
  const valueToSet = input.value === null || input.value === undefined ? null : input.value;

  if (valueToSet === null) {
    // Delete existing value if any
    await db
      .delete(customFieldValues)
      .where(
        and(
          eq(customFieldValues.fieldDefinitionId, fieldDef.id),
          eq(customFieldValues.entityType, input.entityType),
          eq(customFieldValues.entityId, input.entityId),
        ),
      );
  } else {
    // Insert or update
    await db
      .insert(customFieldValues)
      .values({
        organizationId,
        fieldDefinitionId: fieldDef.id,
        entityType: input.entityType,
        entityId: input.entityId,
        value: valueToSet,
      })
      .onConflictDoUpdate({
        target: [
          customFieldValues.fieldDefinitionId,
          customFieldValues.entityType,
          customFieldValues.entityId,
        ],
        set: {
          value: valueToSet,
          updatedAt: new Date(),
        },
      });
  }

  return {
    fieldKey: fieldDef.key,
    fieldLabel: fieldDef.label,
    fieldType: fieldDef.fieldType as CustomFieldType,
    value: valueToSet as CustomFieldValue,
  };
}

/**
 * Gets all custom field values for an entity.
 *
 * @param organizationId - The organization ID
 * @param entityType - The entity type
 * @param entityId - The entity ID
 * @returns Array of field values with metadata
 */
export async function getFieldValues(
  organizationId: string,
  entityType: CustomFieldEntityType,
  entityId: string,
): Promise<CustomFieldValueWithMeta[]> {
  // Get field IDs first, then fetch values separately
  const fieldDefs = await db.query.customFieldDefinitions.findMany({
    where: and(
      eq(customFieldDefinitions.organizationId, organizationId),
      eq(customFieldDefinitions.isActive, true),
    ),
  });

  const applicableFieldIds = fieldDefs
    .filter((f) => f.entityType === entityType || f.entityType === "both")
    .map((f) => f.id);

  if (applicableFieldIds.length === 0) {
    return [];
  }

  const values = await db.query.customFieldValues.findMany({
    where: and(
      eq(customFieldValues.organizationId, organizationId),
      eq(customFieldValues.entityType, entityType),
      eq(customFieldValues.entityId, entityId),
    ),
  });

  const fieldMap = new Map(
    fieldDefs.map((f) => [f.id, { key: f.key, label: f.label, fieldType: f.fieldType }]),
  );

  return values
    .filter((v) => fieldMap.has(v.fieldDefinitionId))
    .map((v) => {
      const field = fieldMap.get(v.fieldDefinitionId)!;
      return {
        fieldKey: field.key,
        fieldLabel: field.label,
        fieldType: field.fieldType as CustomFieldType,
        value: v.value as CustomFieldValue,
      };
    });
}

/**
 * Sets multiple custom field values at once.
 *
 * @param organizationId - The organization ID
 * @param input - Batch input with entityType, entityId, and values object
 * @returns Array of created/updated field values with metadata
 * @throws Error if any field not found or validation fails
 */
export async function batchSetFieldValues(
  organizationId: string,
  input: BatchSetFieldValuesInput,
): Promise<CustomFieldValueWithMeta[]> {
  const results: CustomFieldValueWithMeta[] = [];
  const errors: { fieldKey: string; error: string }[] = [];

  // Process each field value
  for (const [fieldKey, value] of Object.entries(input.values)) {
    try {
      const result = await setFieldValue(organizationId, {
        entityType: input.entityType,
        entityId: input.entityId,
        fieldKey,
        value,
      });
      results.push(result);
    } catch (error) {
      errors.push({
        fieldKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // If any errors occurred, throw with details
  if (errors.length > 0) {
    const message = `Failed to set ${errors.length} field(s): ${errors
      .map((e) => `${e.fieldKey}: ${e.error}`)
      .join("; ")}`;
    throw new Error(message);
  }

  return results;
}

/**
 * Deletes a specific field value.
 *
 * @param organizationId - The organization ID
 * @param fieldKey - The field key
 * @param entityType - The entity type
 * @param entityId - The entity ID
 */
export async function deleteFieldValue(
  organizationId: string,
  fieldKey: string,
  entityType: CustomFieldEntityType,
  entityId: string,
): Promise<void> {
  const fieldDef = await db.query.customFieldDefinitions.findFirst({
    where: and(
      eq(customFieldDefinitions.organizationId, organizationId),
      eq(customFieldDefinitions.key, fieldKey),
    ),
  });

  if (!fieldDef) {
    throw new Error(`Field "${fieldKey}" not found`);
  }

  await db
    .delete(customFieldValues)
    .where(
      and(
        eq(customFieldValues.organizationId, organizationId),
        eq(customFieldValues.fieldDefinitionId, fieldDef.id),
        eq(customFieldValues.entityType, entityType),
        eq(customFieldValues.entityId, entityId),
      ),
    );
}

/**
 * Gets all entities that have a specific custom field value.
 * Useful for filtering customers or service requests by custom field values.
 *
 * @param organizationId - The organization ID
 * @param fieldKey - The field key
 * @param entityType - The entity type
 * @param value - The value to match
 * @returns Array of entity IDs that match
 */
export async function findEntitiesByFieldValue(
  organizationId: string,
  fieldKey: string,
  entityType: CustomFieldEntityType,
  value: unknown,
): Promise<string[]> {
  const fieldDef = await db.query.customFieldDefinitions.findFirst({
    where: and(
      eq(customFieldDefinitions.organizationId, organizationId),
      eq(customFieldDefinitions.key, fieldKey),
      eq(customFieldDefinitions.isActive, true),
    ),
  });

  if (!fieldDef) {
    throw new Error(`Field "${fieldKey}" not found`);
  }

  const values = await db.query.customFieldValues.findMany({
    where: and(
      eq(customFieldValues.organizationId, organizationId),
      eq(customFieldValues.fieldDefinitionId, fieldDef.id),
      eq(customFieldValues.entityType, entityType),
    ),
  });

  // Filter by matching value (simple equality for now, could be enhanced)
  return values
    .filter((v) => JSON.stringify(v.value) === JSON.stringify(value))
    .map((v) => v.entityId);
}
