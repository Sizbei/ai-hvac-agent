# HVAC-Specific Improvements - Stage 9 Documentation

## Overview

The AI HVAC Agent has domain-specific features for HVAC service companies. This document outlines current implementation and recommended improvements for the triage flow and extraction accuracy.

## Current HVAC Features

### 1. Deterministic Intent Router

**Location:** `src/lib/ai/router.ts`

The router handles common HVAC intents without LLM calls:

- **Emergency Escalation:** Gas leaks, carbon monoxide, no cooling in extreme heat
- **FAQ Responses:** Hours, pricing, services, contact info
- **Service Request Triage:** Captures name, phone, address, problem description

**Current Capabilities:**
- 0-token responses for known intents
- Fallback to LLM for novel/ambiguous inputs
- Slot-based state machine for structured data capture

### 2. Service Request Extraction

**Location:** `src/lib/ai/extraction.ts`

Extracts structured HVAC service requests from conversation:

```typescript
interface ServiceRequest {
  name: string;
  phone: string;
  address: string;
  problem: string;
  urgency: 'low' | 'medium' | 'high';
  category: 'ac' | 'heating' | 'maintenance' | 'other';
}
```

### 3. Brand Configurable Responses

**Location:** Environment variables & prompts

- Company name, service area, hours
- Emergency escalation triggers
- After-hours messaging

## Recommended Improvements

### 1. Enhanced Triage Flow

**Priority:** HIGH

**Current Limitation:** The triage flow can feel mechanical when re-asking for missing information.

**Recommended Enhancement:**

```typescript
// Implement context-aware re-asking
function getFollowUpQuestion(
  missingFields: string[],
  conversationHistory: Message[]
): string {
  // Check if user already provided partial info
  const partialAddress = conversationHistory.find(
    m => m.content.includes('123') || m.content.includes('Main St')
  );

  if (missingFields.includes('address') && partialAddress) {
    return "I see you mentioned a location. Could you provide the full street address?";
  }

  // Default to polite re-ask
  return "To schedule your service, I'll need your [field].";
}
```

### 2. Extraction Accuracy

**Priority:** HIGH

**Current Implementation:** Uses LLM to extract structured data from conversation.

**Improvement Areas:**

#### a. Phone Number Normalization

```typescript
function normalizePhone(raw: string): string {
  // Remove all non-digits
  const digits = raw.replace(/\D/g, '');

  // Handle extensions
  const [number, ext] = digits.split('x');

  // Format as E.164
  if (digits.length === 10) {
    return `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  throw new Error('Invalid phone number format');
}
```

#### b. Address Validation with Photon

```typescript
import photon from 'electron-photon';

async function validateAddress(address: string): Promise<ValidatedAddress> {
  const suggestions = await photon({
    q: address,
    limit: 3,
    // Bias towards service area
    bias: SERVICE_AREA_CENTER,
    radius: 50000, // 50km
  });

  if (suggestions.features.length === 0) {
    throw new Error('Address not found');
  }

  return {
    original: address,
    normalized: suggestions.features[0].properties.formatted,
    coordinates: suggestions.features[0].geometry.coordinates,
    confidence: suggestions.features[0].properties.confidence,
  };
}
```

#### c. HVAC Category Detection

```typescript
const HVAC_KEYWORDS = {
  ac: ['air conditioning', 'ac', 'a/c', 'cooling', 'not cooling', 'warm'],
  heating: ['furnace', 'heating', 'heat', 'not heating', 'cold'],
  maintenance: ['maintenance', 'tune-up', 'inspection', 'check'],
  repair: ['repair', 'fix', 'broken', 'not working', 'leaking'],
  installation: ['install', 'new', 'replace', 'upgrade'],
};

function categorizeProblem(description: string): ServiceCategory {
  const lower = description.toLowerCase();

  for (const [category, keywords] of Object.entries(HVAC_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return category as ServiceCategory;
    }
  }

  return 'other';
}
```

### 3. Urgency Detection

**Priority:** MEDIUM

**Current:** Basic keyword matching for "emergency", "urgent", "asap".

**Enhancement:** Multi-factor urgency scoring:

```typescript
function calculateUrgency(serviceRequest: ServiceRequest): UrgencyScore {
  let score = 0; // 0-100

  // Temperature-based urgency
  if (serviceRequest.category === 'ac' && currentTemp > 90) score += 30;
  if (serviceRequest.category === 'heating' && currentTemp < 40) score += 30;

  // Problem type
  if (serviceRequest.problem.toLowerCase().includes('leaking')) score += 20;
  if (serviceRequest.problem.toLowerCase().includes('no cooling')) score += 15;
  if (serviceRequest.problem.toLowerCase().includes('no heating')) score += 15;

  // Customer vulnerability
  if (serviceRequest.problem.includes('elderly') || serviceRequest.problem.includes('kids')) {
    score += 10;
  }

  // Time-based
  if (isAfterHours() && score > 20) score += 10;

  return {
    score,
    level: score >= 70 ? 'emergency' : score >= 40 ? 'urgent' : 'normal',
    factors: ['temperature', 'problem_type', 'vulnerability', 'timing'],
  };
}
```

### 4. Multi-Intent Handling

**Priority:** LOW

**Use Case:** Customer mentions multiple issues in one message.

**Example:** "My AC isn't cooling and I also need a maintenance check."

**Implementation:**

```typescript
interface ServiceRequest {
  primaryIssue: ServiceIssue;
  secondaryIssues?: ServiceIssue[];
}

function extractMultipleIssues(message: string): ServiceRequest {
  const issues = message.split(/\s+and\s+|\s+also\s+/i);

  return {
    primaryIssue: extractIssue(issues[0]),
    secondaryIssues: issues.slice(1).map(extractIssue),
  };
}
```

### 5. Intelligent Handoff

**Priority:** MEDIUM

**Current:** Generic "agent will assist" message.

**Enhancement:** Context-aware handoff:

```typescript
function getHandoffMessage(serviceRequest: ServiceRequest): string {
  const urgency = calculateUrgency(serviceRequest);

  if (urgency.level === 'emergency') {
    return "A technician will call you within 15 minutes.";
  } else if (urgency.level === 'urgent') {
    return "We'll have someone call you within the hour.";
  } else {
    const nextSlot = getNextAvailableSlot();
    return `Our earliest availability is ${nextSlot}. Would that work?`;
  }
}
```

## Testing HVAC Features

### Unit Tests

```typescript
describe('HVAC Extraction', () => {
  test('should extract phone from various formats', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('555-123-4567')).toBe('+15551234567');
    expect(normalizePhone('555.123.4567')).toBe('+15551234567');
  });

  test('should categorize HVAC problems', () => {
    expect(categorizeProblem('AC not cooling')).toBe('ac');
    expect(categorizeProblem('Furnace broken')).toBe('heating');
    expect(categorizeProblem('Annual maintenance')).toBe('maintenance');
  });
});
```

### E2E Tests

```typescript
test('should complete HVAC service request flow', async ({ page }) => {
  await page.goto('/');

  // Start service request
  await page.getByPlaceholder(/type/i).fill('My AC is not cooling');
  await page.getByRole('button', { name: /send/i }).click();

  // Should enter triage
  await expect(page.getByText(/address/i)).toBeVisible();

  // Complete flow
  await page.getByLabel(/address/i).fill('123 Main St, Johnson City, TN');
  await page.getByRole('button', { name: /continue|next/i }).click();

  await page.getByLabel(/phone/i).fill('555-123-4567');
  await page.getByRole('button', { name: /continue|next/i }).click();

  // Should complete extraction
  await expect(page.getByText(/service request/i)).toBeVisible();
});
```

## Configuration

### Environment Variables

```bash
# Service area (for address bias)
SERVICE_AREA_LAT=36.3426
SERVICE_AREA_LON=-82.3837  # Johnson City, TN
SERVICE_AREA_RADIUS=50000  # 50km

# Emergency hours
EMERGENCY_HOURS_START=17  # 5 PM
EMERGENCY_HOURS_END=8     # 8 AM

# HVAC categories
HVAC_CATEGORIES=ac,heating,maintenance,repair,installation
```

## Next Steps

1. Implement enhanced triage with context-aware re-asking
2. Add phone number normalization
3. Integrate Photon for address validation
4. Implement urgency scoring
5. Add multi-intent detection
6. Create comprehensive E2E tests for HVAC flows

## References

- `src/lib/ai/router.ts` - Intent routing
- `src/lib/ai/extraction.ts` - Structured data extraction
- `src/lib/ai/state-machine.ts` - Conversation state management
- `e2e/chat.spec.ts` - E2E test examples
