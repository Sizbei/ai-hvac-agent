# Custom Fields CRM System - Design Document

**Date:** 2026-06-11
**Status:** Draft
**Stage:** Phase 7 - Deep Customization (CRM)

## Overview

Implement a flexible custom fields system that allows organizations to define additional data fields beyond the built-in HVAC-specific fields. This enables businesses to track industry-specific or company-specific information without code changes.

## Goals

1. Allow organizations to define custom field schemas (field definitions)
2. Store custom field values per entity (customers, service requests)
3. Provide admin UI for managing field definitions
4. Generate dynamic forms based on organization's field configuration
5. Maintain queryability and type safety where possible

## Architecture

### Data Model

#### 1. `custom_field_definitions` Table

Defines the schema of custom fields per organization.

```typescript
{
  id: uuid
  organizationId: uuid
  key: string              // Machine-readable identifier (e.g., "customer_source")
  label: string            // Human-readable display name (e.g., "How did they hear about us?")
  description?: string     // Help text for the field
  entityType: enum         // "customer" | "service_request" | "both"
  fieldType: enum          // "text" | "textarea" | "select" | "multiselect" | "number" | "date" | "checkbox" | "currency"
  options?: string[]       // For select/multiselect field types
  required: boolean
  placeholder?: string
  defaultValue?: string     // JSON-serialized default value
  validation?: object       // JSON-serialized validation rules (min, max, pattern)
  displayOrder: integer    // For UI ordering
  isActive: boolean
  createdAt: timestamp
  updatedAt: timestamp
}
```

**Indexes:**
- `(organizationId, entityType, isActive)` - Active fields per org/entity type
- `(organizationId, key)` unique - Unique keys per org
- `key` must match regex: `^[a-z][a-z0-9_]*$` (snake_case, starts with letter)

#### 2. `custom_field_values` Table

Stores actual field values per entity.

```typescript
{
  id: uuid
  organizationId: uuid
  fieldDefinitionId: uuid   // FK to custom_field_definitions
  entityType: enum          // "customer" | "service_request"
  entityId: uuid            // ID of the customer/service_request
  value: jsonb              // The actual value (typed by field definition)
  createdAt: timestamp
  updatedAt: timestamp
}
```

**Indexes:**
- `(entityType, entityId)` - Lookup all custom values for an entity
- `(fieldDefinitionId)` - Lookup all values for a specific field
- Unique `(fieldDefinitionId, entityType, entityId)` - One value per field per entity

### Field Types

| Type | Value Format | Example | Use Case |
|------|-------------|---------|----------|
| `text` | string | "Referral from John" | Short text input |
| `textarea` | string | "Long description..." | Multi-line text |
| `select` | string (single) | "Google" | Dropdown single select |
| `multiselect` | string[] | ["Google", "Referral"] | Dropdown multi-select |
| `number` | number | 25 | Numeric values |
| `currency` | number (cents) | 2500 | Dollar amounts (stored as cents) |
| `date` | ISO date string | "2026-06-11" | Date without time |
| `checkbox` | boolean | true | Yes/No toggle |

### Validation Rules (JSON schema)

```typescript
interface ValidationRules {
  // For text/textarea
  minLength?: number
  maxLength?: number
  pattern?: string  // Regex pattern

  // For number/currency
  min?: number
  max?: number

  // For date
  minDate?: string  // ISO date
  maxDate?: string  // ISO date

  // For select/multiselect
  allowedValues?: string[]  // Should match options, but can be stricter
}
```

## API Design

### Field Definition Endpoints

#### `POST /api/admin/custom-fields`

Create a new custom field definition.

**Request:**
```json
{
  "key": "preferred_contact_method",
  "label": "Preferred Contact Method",
  "entityType": "customer",
  "fieldType": "select",
  "options": ["Email", "Phone", "SMS", "Mail"],
  "required": false,
  "displayOrder": 10
}
```

**Response:** Field definition object

#### `GET /api/admin/custom-fields`

List all custom field definitions for the organization.

**Query params:**
- `entityType` (optional) - Filter by entity type
- `isActive` (optional) - Filter by active status

**Response:**
```json
{
  "fields": [
    {
      "id": "...",
      "key": "preferred_contact_method",
      "label": "Preferred Contact Method",
      "entityType": "customer",
      "fieldType": "select",
      "options": ["Email", "Phone", "SMS", "Mail"],
      "required": false,
      "displayOrder": 10
    }
  ]
}
```

#### `PATCH /api/admin/custom-fields/:id`

Update a field definition.

#### `DELETE /api/admin/custom-fields/:id`

Soft-delete (set `isActive = false`) a field definition.

### Field Value Endpoints

#### `POST /api/admin/custom-field-values`

Set a custom field value on an entity.

**Request:**
```json
{
  "entityType": "customer",
  "entityId": "customer-uuid",
  "fieldId": "field-uuid",
  "value": "Email"
}
```

**Response:** Field value object

#### `GET /api/admin/custom-field-values/:entityType/:entityId`

Get all custom field values for an entity.

**Response:**
```json
{
  "values": [
    {
      "fieldKey": "preferred_contact_method",
      "fieldLabel": "Preferred Contact Method",
      "value": "Email",
      "fieldType": "select"
    }
  ]
}
```

#### `POST /api/admin/custom-field-values/batch`

Set multiple field values at once (useful for forms).

**Request:**
```json
{
  "entityType": "customer",
  "entityId": "customer-uuid",
  "values": {
    "preferred_contact_method": "Email",
    "customer_since": "2026-01-01"
  }
}
```

## UI Components

### 1. Field Definition Builder

Admin interface for creating/editing custom fields:

**Components:**
- Field type selector (dropdown with icons)
- Label and key inputs
- Entity type toggle (Customer / Service Request / Both)
- Required checkbox
- Options builder (for select/multiselect) - dynamic list add/remove
- Validation rules (conditional based on field type)
- Preview of the rendered field

### 2. Dynamic Form Renderer

Generic component that renders custom fields as a form:

```typescript
interface CustomFieldsFormProps {
  entityType: 'customer' | 'service_request';
  entityId?: string;  // If editing, populate existing values
  onSubmit: (values: Record<string, unknown>) => void;
  organizationId: string;
}

function CustomFieldsForm({ entityType, entityId, onSubmit, organizationId }: CustomFieldsFormProps) {
  // Fetches field definitions for org + entityType
  // Renders appropriate input components
  // Validates based on field rules
  // Calls onSubmit with hydrated values
}
```

### 3. Customer/Service Request Detail Views

Extend existing CRM views to display custom field values in a dedicated "Custom Fields" section.

## Implementation Plan

### Phase 1: Database Schema

1. Add `custom_field_definitions` table migration
2. Add `custom_field_values` table migration
3. Create Drizzle schema exports
4. Run migrations

### Phase 2: Core Library Functions

1. `lib/custom-fields/definitions.ts`
   - `createFieldDefinition(orgId, data)`
   - `getFieldDefinitions(orgId, entityType?)`
   - `updateFieldDefinition(id, data)`
   - `deleteFieldDefinition(id)`

2. `lib/custom-fields/values.ts`
   - `setFieldValue(orgId, entityType, entityId, fieldKey, value)`
   - `getFieldValues(orgId, entityType, entityId)`
   - `batchSetFieldValues(orgId, entityType, entityId, values)`
   - `deleteFieldValue(fieldValueId)`

3. `lib/custom-fields/validation.ts`
   - `validateFieldValue(fieldDefinition, value)`
   - Returns `{ valid: boolean, errors: string[] }`

### Phase 3: API Routes

1. `src/app/api/admin/custom-fields/route.ts` - GET, POST
2. `src/app/api/admin/custom-fields/[id]/route.ts` - PATCH, DELETE
3. `src/app/api/admin/custom-field-values/route.ts` - POST
4. `src/app/api/admin/custom-field-values/[entityType]/[entityId]/route.ts` - GET
5. `src/app/api/admin/custom-field-values/batch/route.ts` - POST

### Phase 4: UI Components

1. `src/components/admin/custom-fields/FieldBuilder.tsx` - Create/edit form
2. `src/components/admin/custom-fields/FieldList.tsx` - List view
3. `src/components/admin/custom-fields/CustomFieldsForm.tsx` - Dynamic renderer
4. Integrate into customer detail and service request detail pages

## Security & Validation

### Input Sanitization

- `key` must match `^[a-z][a-z0-9_]*$` (enforced at DB constraint + API validation)
- `label` max 255 characters, trimmed
- `options` array max 100 items, each max 255 characters

### Authorization

- All endpoints require admin session
- Field definitions scoped to organization (hard gate)
- Field values scoped to organization (hard gate)

### Validation

- Required fields checked before save
- Type-specific validation applied (min/max/pattern)
- Select/multiselect values validated against allowed options
- JSON schema validation for `validation` object

## Future Enhancements

1. **Conditional visibility** - Show/hide fields based on other field values
2. **Calculated fields** - Fields whose values are computed from other fields
3. **Field groups** - Organize fields into sections with headers
4. **Import/Export** - Bulk import field values from CSV
5. **API access** - Allow external systems to read/write custom field values
6. **Search/filter** - Query entities by custom field values

## Migration Strategy

### Rollout

1. Deploy schema migration (no data loss, additive only)
2. Deploy API routes behind feature flag
3. Deploy admin UI
4. Enable feature flag for beta customers
5. Gradual rollout to all customers

### Backward Compatibility

- Existing APIs work without custom fields
- Customers without custom fields see no UI change
- All fields default to optional (non-breaking)

## Success Criteria

- [ ] Organizations can create 10+ custom fields per entity type
- [ ] Field values persist and retrieve correctly
- [ ] Validation prevents invalid data entry
- [ ] Admin UI allows full CRUD on field definitions
- [ ] Dynamic forms render correctly for all field types
- [ ] Performance: <100ms to load field definitions, <200ms to load entity values
