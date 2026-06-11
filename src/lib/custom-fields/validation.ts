/**
 * Custom Fields Validation
 *
 * Validates custom field values against their field definition rules.
 */

import { CustomFieldDefinition, ValidationResult, ValidationRules } from "./types";

/**
 * Validates a value against a field definition's rules.
 *
 * @param fieldDefinition - The field definition to validate against
 * @param value - The value to validate
 * @returns ValidationResult with valid flag and error messages
 */
export function validateFieldValue(
  fieldDefinition: Pick<CustomFieldDefinition, "fieldType" | "label" | "options" | "required"> & { validation?: ValidationRules | Record<string, unknown> | null },
  value: unknown,
): ValidationResult {
  const errors: string[] = [];

  // Check required fields
  if (fieldDefinition.required && (value === null || value === undefined || value === "")) {
    return { valid: false, errors: ["This field is required"] };
  }

  // Allow null/undefined for optional fields
  if (value === null || value === undefined) {
    return { valid: true, errors: [] };
  }

  const validation = fieldDefinition.validation || {};

  // Type-specific validation
  switch (fieldDefinition.fieldType) {
    case "text":
    case "textarea":
      validateText(value, validation, errors, fieldDefinition.label);
      break;

    case "select":
      validateSelect(value, fieldDefinition.options, errors, fieldDefinition.label, validation);
      break;

    case "multiselect":
      validateMultiSelect(value, fieldDefinition.options, errors, fieldDefinition.label, validation);
      break;

    case "number":
      validateNumber(value, validation, errors, fieldDefinition.label);
      break;

    case "currency":
      validateCurrency(value, validation, errors, fieldDefinition.label);
      break;

    case "date":
      validateDate(value, validation, errors, fieldDefinition.label);
      break;

    case "checkbox":
      validateCheckbox(value, errors, fieldDefinition.label);
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates text/textarea fields.
 */
function validateText(
  value: unknown,
  validation: ValidationRules,
  errors: string[],
  label: string,
): void {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return;
  }

  if (validation.minLength !== undefined && value.length < validation.minLength) {
    errors.push(`${label} must be at least ${validation.minLength} characters`);
  }

  if (validation.maxLength !== undefined && value.length > validation.maxLength) {
    errors.push(`${label} must be at most ${validation.maxLength} characters`);
  }

  if (validation.pattern) {
    const regex = new RegExp(validation.pattern);
    if (!regex.test(value)) {
      errors.push(`${label} format is invalid`);
    }
  }
}

/**
 * Validates select (single-choice) fields.
 */
function validateSelect(
  value: unknown,
  options: string[],
  errors: string[],
  label: string,
  validation?: ValidationRules,
): void {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return;
  }

  const allowedValues = validation?.allowedValues || options;
  if (!allowedValues.includes(value)) {
    errors.push(`${label} must be one of: ${allowedValues.join(", ")}`);
  }
}

/**
 * Validates multiselect fields.
 */
function validateMultiSelect(
  value: unknown,
  options: string[],
  errors: string[],
  label: string,
  validation?: ValidationRules,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }

  const allowedValues = validation?.allowedValues || options;
  for (const item of value) {
    if (typeof item !== "string" || !allowedValues.includes(item)) {
      errors.push(`${label} contains invalid value: ${item}`);
    }
  }
}

/**
 * Validates number fields.
 */
function validateNumber(
  value: unknown,
  validation: ValidationRules,
  errors: string[],
  label: string,
): void {
  if (typeof value !== "number" || isNaN(value)) {
    errors.push(`${label} must be a number`);
    return;
  }

  if (validation.min !== undefined && value < validation.min) {
    errors.push(`${label} must be at least ${validation.min}`);
  }

  if (validation.max !== undefined && value > validation.max) {
    errors.push(`${label} must be at most ${validation.max}`);
  }
}

/**
 * Validates currency fields (stored as cents, validated as dollars).
 */
function validateCurrency(
  value: unknown,
  validation: ValidationRules,
  errors: string[],
  label: string,
): void {
  if (typeof value !== "number" || isNaN(value) || value < 0) {
    errors.push(`${label} must be a positive number (in cents)`);
    return;
  }

  // Convert cents to dollars for validation
  const dollars = value / 100;

  if (validation.min !== undefined && dollars < validation.min) {
    errors.push(`${label} must be at least $${validation.min}`);
  }

  if (validation.max !== undefined && dollars > validation.max) {
    errors.push(`${label} must be at most $${validation.max}`);
  }
}

/**
 * Validates date fields (ISO 8601 format).
 */
function validateDate(
  value: unknown,
  validation: ValidationRules,
  errors: string[],
  label: string,
): void {
  if (typeof value !== "string") {
    errors.push(`${label} must be a date string`);
    return;
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    errors.push(`${label} must be a valid date (ISO 8601 format)`);
    return;
  }

  if (validation.minDate) {
    const minDate = new Date(validation.minDate);
    if (date < minDate) {
      errors.push(`${label} must be on or after ${validation.minDate}`);
    }
  }

  if (validation.maxDate) {
    const maxDate = new Date(validation.maxDate);
    if (date > maxDate) {
      errors.push(`${label} must be on or before ${validation.maxDate}`);
    }
  }
}

/**
 * Validates checkbox (boolean) fields.
 */
function validateCheckbox(value: unknown, errors: string[], label: string): void {
  if (typeof value !== "boolean") {
    errors.push(`${label} must be true or false`);
  }
}

/**
 * Validates field key format (snake_case, starts with letter).
 */
export function validateFieldKey(key: string): { valid: boolean; error?: string } {
  const regex = /^[a-z][a-z0-9_]*$/;
  if (!regex.test(key)) {
    return {
      valid: false,
      error: "Field key must be snake_case, start with a letter, and contain only letters, numbers, and underscores",
    };
  }
  return { valid: true };
}

/**
 * Validates field options for select/multiselect types.
 */
export function validateFieldOptions(
  fieldType: string,
  options: unknown,
): { valid: boolean; error?: string } {
  if (fieldType === "select" || fieldType === "multiselect") {
    if (!Array.isArray(options)) {
      return { valid: false, error: "Options must be an array" };
    }
    if (options.length === 0) {
      return { valid: false, error: "Select fields require at least one option" };
    }
    if (options.length > 100) {
      return { valid: false, error: "Select fields can have at most 100 options" };
    }
    for (const opt of options) {
      if (typeof opt !== "string" || opt.length > 255) {
        return { valid: false, error: "Each option must be a string of 255 characters or less" };
      }
    }
  }
  return { valid: true };
}
