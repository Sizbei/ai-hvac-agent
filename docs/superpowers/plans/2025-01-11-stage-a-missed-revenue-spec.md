# Stage A: Missed Revenue (After-Hours Emergency Capture) - Technical Specification

> **Status:** DRAFT - Ready for Implementation Planning
> **Priority:** HIGH - Premium revenue feature
> **Target:** 5-technician HVAC shop operation

---

## Executive Summary

Stage A transforms the AI HVAC Agent from a passive intake system into an **active revenue capture engine** for after-hours emergencies. The platform already captures intake via phone+chat with safety-first triage. Stage A adds:

1. **Hard slot-hold scheduling** - Prevent double-booking with optimistic concurrency
2. **Emergency SLA system** - 15-minute response commitment for gas/CO emergencies
3. **Automatic technician dispatch** - Route emergencies to on-call technicians instantly
4. **After-hours queue management** - Dedicated admin surface for overnight requests

This is a **premium positioning feature** that justifies higher pricing through guaranteed emergency response.

---

## 1. Feature Requirements

### 1.1 Hard Slot-Hold Scheduling

**Requirement:** Prevent double-booking when multiple customers confirm simultaneously for the same time slot.

**Business Logic:**
- When a customer confirms a booking (via chat/phone), the system must:
  1. Compute open availability for the requested date range
  2. Pick the earliest bookable `{day, window}` matching the customer's preference
  3. Atomically claim one unit of capacity from that slot
  4. Return the concrete arrival window OR report "slot full" with alternatives

**Technical Approach (Optimistic Concurrency):**
```typescript
// The confirm-time hold pattern (already designed in capacity-hold.ts):
// 1. Re-read open availability (fresh counts)
// 2. pickBookableSlot(availability, preferredWindow) → {day, window} | null
// 3. CONDITIONAL UPDATE with WHERE available > 0 (CAS predicate)
// 4. If 0 rows changed → race lost → re-read and retry OR report full
```

**Why NOT transactions:** The app runs on `neon-http` which has NO interactive transactions. `db.transaction()` THROWS at runtime. We use `db.batch()` for atomic non-interactive operations.

**Success Criteria:**
- No two customers can ever be confirmed into the same slot
- Race condition is handled gracefully (retry with next available slot)
- Customer sees real-time availability, not overbooked promises

### 1.2 Emergency SLA System

**Requirement:** For gas leak and carbon monoxide emergencies, commit to a 15-minute response time and track compliance.

**Emergency Detection (already implemented):**
The chat/voice intake already triages to `urgency: "emergency"` for:
- "gas leak" or "smell gas"
- "carbon monoxide" or "CO detector"
- "furnace blowing hot/cold air" (indicating potential CO)

**SLA Components:**

| SLA Type | Trigger | Response Commitment | Notification |
|----------|---------|---------------------|--------------|
| **GAS_CO_EMERGENCY** | `urgency="emergency"` AND issueType includes gas/CO keywords | 15 minutes | On-call tech + on-duty admin |
| **AFTER_HOURS_EMERGENCY** | `urgency="emergency"` AND `isAfterHours=true` | 30 minutes | On-call tech |
| **STANDARD_AFTER_HOURS** | `urgency="high"` AND `isAfterHours=true` | 2 hours | Next-day queue |

**SLA Tracking:**
- `slaBreachAt`: computed timestamp when SLA is violated
- `slaAcknowledgedAt`: when technician acknowledged the emergency
- `slaResponderUserId`: which technician is on the hook
- `slaStatus`: `pending` | `acknowledged` | `met` | `breached`

**Customer Commitment:**
The bot MUST disclose: "For gas/CO emergencies, we'll have a technician call you within 15 minutes."

### 1.3 Automatic Technician Dispatch

**Requirement:** Emergency requests are automatically routed to the on-call technician with immediate notification.

**On-Call Schedule:**
- New table: `on_call_schedule` - weekly recurring on-call rotations
- One technician is "on-call" for each time block
- On-call status is separate from regular working hours

**Dispatch Logic:**
```typescript
// Pseudo-code for emergency dispatch
if (urgency === "emergency") {
  const onCallTech = await getOnCallTechnician(organizationId, now);
  if (onCallTech) {
    await assignRequest(requestId, onCallTech.id);
    await notifyEmergency(onCallTech, request);
  } else {
    await escalateToOnDutyAdmin(request);
  }
}
```

**Notification Channels:**
1. **SMS** to technician's phone (via Twilio)
2. **In-app notification** for admins (real-time dashboard badge)
3. **Phone call** (optional, for GAS_CO_EMERGENCY if SMS unacknowledged after 5 minutes)

**Acknowledgement Protocol:**
- Technician must click "I'm on it" in the app OR reply to SMS
- Timestamp recorded as `slaAcknowledgedAt`
- If unacknowledged after 10 minutes → escalate to on-duty admin

### 1.4 After-Hours Queue Management

**Requirement:** Admins need a dedicated surface to manage requests that arrived outside business hours.

**Queue View Features:**
- Filter by `isAfterHours=true`
- Sort by: SLA deadline (emergencies first), then arrival time
- Bulk operations: assign multiple, export to CSV
- SLA countdown timer (minutes until breach)

**Workflow:**
1. Overnight requests accumulate in the queue
2. Morning dispatcher reviews the queue
3. One-click assignment to technicians (respecting SLAs)
4. Customer confirmation sent when assigned

---

## 2. Technical Architecture

### 2.1 Database Schema Changes

```sql
-- New table: on_call_schedule
-- Recurring weekly on-call rotations per technician
CREATE TABLE on_call_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  technician_id UUID NOT NULL REFERENCES users(id),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun, 6=Sat
  start_minute INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute INTEGER NOT NULL CHECK (end_minute > start_minute AND end_minute <= 1440),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, technician_id, day_of_week, start_minute)
);

-- Index for active on-call lookup
CREATE INDEX on_call_schedule_org_tech_idx 
  ON on_call_schedule(organization_id, technician_id);
CREATE INDEX on_call_schedule_org_day_idx 
  ON on_call_schedule(organization_id, day_of_week);

-- New columns on service_requests (SLA tracking)
ALTER TABLE service_requests ADD COLUMN sla_breach_at TIMESTAMPTZ;
ALTER TABLE service_requests ADD COLUMN sla_acknowledged_at TIMESTAMPTZ;
ALTER TABLE service_requests ADD COLUMN sla_responder_user_id UUID REFERENCES users(id);
ALTER TABLE service_requests ADD COLUMN sla_status VARCHAR(20) 
  CHECK (sla_status IN ('pending', 'acknowledged', 'met', 'breached'));

-- Index for SLA queries
CREATE INDEX requests_sla_status_idx 
  ON service_requests(organization_id, sla_status);
CREATE INDEX requests_sla_breach_idx 
  ON service_requests(organization_id, sla_breach_at);

-- New table: emergency_acknowledgements
-- Audit trail of technician responses to emergency dispatches
CREATE TABLE emergency_acknowledgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  request_id UUID NOT NULL REFERENCES service_requests(id),
  technician_id UUID NOT NULL REFERENCES users(id),
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('sms', 'app', 'phone')),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX emergency_ack_req_idx 
  ON emergency_acknowledgements(request_id);
CREATE INDEX emergency_ack_tech_idx 
  ON emergency_acknowledgements(technician_id);
```

### 2.2 API Endpoints Required

#### 2.2.1 On-Call Management

```typescript
// GET /api/admin/on-call/schedule
// List on-call rotations for the organization
Response: OnCallScheduleEntry[]

// POST /api/admin/on-call/schedule
// Set on-call rotations for a technician
Body: { technicianId, dayOfWeek, startMinute, endMinute }[]
Response: 201 Created

// GET /api/admin/on-call/current
// Get the currently on-call technician
Response: { technicianId, technicianName, phone, until }
```

#### 2.2.2 Emergency Dispatch

```typescript
// POST /api/admin/emergency/acknowledge
// Technician acknowledges an emergency dispatch
Body: { requestId, channelId }
Response: 200 OK

// GET /api/admin/emergency/pending
// List unacknowledged emergencies (for admin escalation)
Response: EmergencyRequest[]

// POST /api/admin/emergency/escalate
// Manually escalate an unacknowledged emergency
Body: { requestId, escalateToUserId }
Response: 200 OK
```

#### 2.2.3 After-Hours Queue

```typescript
// GET /api/admin/queue/after-hours
// List after-hours requests with SLA tracking
Query: ?status=pending|acknowledged|breached&sort=sla_deadline|created_at
Response: AfterHoursQueueItem[]

// POST /api/admin/queue/bulk-assign
// Bulk assign multiple queue items to technicians
Body: { requestIds, technicianId }
Response: 200 OK

// GET /api/admin/queue/sla-report
// SLA compliance metrics for a date range
Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
Response: SlaReport
```

#### 2.2.4 Capacity Hold (Confirm-Time)

```typescript
// POST /api/session/confirm
// Already exists - EXTEND for slot-hold
Extension: Add slot-hold logic using capacity-hold.ts primitives

// GET /api/availability
// Already exists - PUBLIC availability endpoint
Extension: Return real-time open windows (capacity > 0)
```

### 2.3 Frontend Components

#### 2.3.1 Admin: After-Hours Queue Page

**Route:** `/admin/queue/after-hours`

**Component Structure:**
```typescript
// src/app/admin/(dashboard)/queue/after-hours/page.tsx
interface AfterHoursQueuePageProps {
  searchParams: { status?: string; sort?: string };
}

// Main component
function AfterHoursQueuePage({ searchParams }: AfterHoursQueuePageProps) {
  // Fetch queue with filters
  // Display table with SLA countdowns
  // Bulk assign modal
  // Export button
}

// Sub-components
<AfterHoursQueueTable>
<SlotCountdown slaBreachAt={timestamp} />
<BulkAssignModal />
<SlaReportChart />
```

**UI Features:**
- Color-coded urgency (emergency = red, high = orange, standard = blue)
- Live countdown timer to SLA breach
- One-click "Assign to on-call" button
- Bulk select with checkbox column
- Filter by status (pending, acknowledged, breached)

#### 2.3.2 Technician: Emergency Acknowledgement

**Route:** `/admin/emergency/[id]`

**Component Structure:**
```typescript
// Emergency detail view for technicians
function EmergencyDetailPage({ params }: { params: { id: string } }) {
  // Show emergency details
  // Big "ACKNOWLEDGE" button
  // Customer contact info (phone click-to-call)
  // Previous service history
}
```

**Mobile-Optimized:**
- Large touch targets for field use
- One-tap phone dial
- Minimal scrolling, critical info first

#### 2.3.3 Admin: On-Call Schedule Editor

**Route:** `/admin/settings/on-call`

**Component Structure:**
```typescript
// Weekly on-call rotation editor
function OnCallScheduleEditor() {
  // 7-day week view
  // Drag-drop or click-to-assign
  // Time range picker
  // Preview: "Who's on call right now?"
}
```

#### 2.3.4 Public: Slot Confirmation

**Enhancement to existing confirm flow:**

```typescript
// src/components/chat/confirmation-card.tsx
// EXTEND to show selected slot with capacity
function ConfirmationCard({ slot, available }: SlotConfirmation) {
  return (
    <div>
      <h3>{slot.day} - {slot.window}</h3>
      <p>{available} slots remaining</p>
      <ConfirmButton />
    </div>
  );
}
```

### 2.4 Business Logic Modules

#### 2.4.1 On-Call Resolution

```typescript
// src/lib/admin/on-call-queries.ts

export async function getOnCallTechnician(
  organizationId: string,
  at: Date = new Date()
): Promise<OnCallTechnician | null> {
  // Resolve current on-call from schedule
  // Returns: { technicianId, technicianName, phone, until }
}

export async function setOnCallSchedule(
  organizationId: string,
  schedule: OnCallSlotInput[]
): Promise<void> {
  // Replace existing schedule with new rotations
  // Uses db.batch for atomic swap
}
```

#### 2.4.2 SLA Computation

```typescript
// src/lib/admin/sla-compute.ts

export function computeSlaBreachAt(
  urgency: string,
  issueType: string,
  isAfterHours: boolean,
  createdAt: Date
): Date | null {
  // Return SLA deadline based on SLA matrix
  // null = no SLA (standard requests)
}

export function getSlaType(request: ServiceRequest): SlaType {
  // Classify request into SLA tier
}

export const SLA_DEADLINES_MINUTES = {
  GAS_CO_EMERGENCY: 15,
  AFTER_HOURS_EMERGENCY: 30,
  STANDARD_AFTER_HOURS: 120,
} as const;
```

#### 2.4.3 Emergency Dispatch

```typescript
// src/lib/admin/emergency-dispatch.ts

export async function dispatchEmergency(
  requestId: string
): Promise<DispatchResult> {
  // 1. Get on-call technician
  // 2. Assign request to technician
  // 3. Send SMS notification
  // 4. Record in emergency_acknowledgements
  // 5. Return dispatch result
}

export async function acknowledgeEmergency(
  requestId: string,
  technicianId: string,
  channel: 'sms' | 'app' | 'phone'
): Promise<void> {
  // Update sla_acknowledged_at
  // Insert acknowledgement record
  // Send customer notification ("Tech is on the way!")
}
```

#### 2.4.4 Notification Service

```typescript
// src/lib/notifications/emergency-sms.ts

export async function sendEmergencyDispatchSms(
  technicianPhone: string,
  request: EmergencyRequest
): Promise<void> {
  // Compose emergency SMS
  // Send via Twilio
}

export async function sendCustomerTechEnrouteSms(
  customerPhone: string,
  technicianName: string,
  etaMinutes: number
): Promise<void> {
  // "Technician NAME is on the way! ETA: X minutes"
}
```

### 2.5 Integration with Existing Intake Flow

**Injection Points:**

1. **Confirm Endpoint (`/api/session/confirm`):**
   - After extraction passes gate, BEFORE creating service_request
   - Call `pickBookableSlot()` and `arrivalWindowForSlot()`
   - Conditional UPDATE with CAS predicate
   - On race loss → retry with next slot OR report full

2. **Chat/Voice Intake:**
   - Already detects emergencies via urgency triage
   - NEW: After confirm, if emergency → `dispatchEmergency()`

3. **After-Hours Detection:**
   - Already implemented (`isAfterHours()` in after-hours.ts)
   - NEW: Stamp `slaBreachAt` on confirm

---

## 3. User Experience

### 3.1 Customer-Facing Experience

#### 3.1.1 Chat/Phone Intake Flow

**Standard Requests:**
```
Bot: "I've got your info. When would you like us to come out?"
Customer: "Tomorrow morning"
Bot: "Great! I have 2 slots for tomorrow morning. Shall I book you for 8-12?"
Customer: "Yes"
Bot: "You're confirmed for tomorrow 8am-12pm. We'll text you when a technician is assigned."
```

**Emergency Flow:**
```
Customer: "My furnace is blowing hot air and I smell gas!"
Bot: (urgency="emergency", triggers SLA)
Bot: "This sounds like a gas emergency. Please leave the building and call 911 if you smell gas strongly."
Bot: "For gas emergencies, we'll have a technician call you within 15 minutes."
Customer: "Yes please"
Bot: "Confirmed. Our on-call technician will call you at [PHONE] within 15 minutes."
(SMS to customer): "Emergency confirmed. Technician en route now. ETA 12 minutes."
```

#### 3.1.2 Slot Selection UI

**Public Availability Display:**
```
Tomorrow, Jan 12
  Morning (8am-12pm)   2 slots available
  Afternoon (12pm-5pm) 1 slot available
  Evening (5pm-8pm)     0 slots available [FULL]
```

**Confirmation Message:**
```
You're all set for January 12, 8am-12pm.
We'll call you at 555-1234 when the technician is on the way.
```

### 3.2 Admin After-Hours Queue View

**UI Layout:**
```
┌──────────────────────────────────────────────────────────────┐
│ After-Hours Queue              [Export] [Assign All]         │
├──────────────────────────────────────────────────────────────┤
│ Filter: [All ▼]  Sort: [SLA Deadline ▼]                    │
├──────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 🔴 EMERGENCY - GAS LEAK                                 │ │
│ │ Reference: #ABC123 | Customer: John Doe                  │ │
│ │ Address: 123 Main St                                     │ │
│ │ SLA: Breaches in 8:23  [Assign to On-Call]             │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 🟠 HIGH - NO COOLING                                    │ │
│ │ Reference: #ABC124 | Customer: Jane Smith               │ │
│ │ Address: 456 Oak Ave                                     │ │
│ │ SLA: Breaches in 1:45:12  [Assign]                      │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 🔵 STANDARD - MAINTENANCE                               │ │
│ │ Reference: #ABC125 | Customer: Bob Johnson                │ │
│ │ Address: 789 Elm St                                     │ │
│ │ Arrived: 2:30am  [Assign]                               │ │
│ └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Bulk Assign Modal:**
```
┌─────────────────────────────────────┐
│ Assign 3 requests to technician:   │
│ [Select Technician ▼]               │
│                                     │
│ Requests:                           │
│ ☑ #ABC123 - GAS LEAK               │
│ ☑ #ABC124 - NO COOLING              │
│ ☑ #ABC125 - MAINTENANCE             │
│                                     │
│ [Cancel] [Assign]                   │
└─────────────────────────────────────┘
```

### 3.3 Technician Emergency Interface

**Mobile View (Emergency Acknowledgement):**
```
┌─────────────────────────────────────┐
│ 🚨 EMERGENCY DISPATCH              │
│                                     │
│ GAS LEAK - HIGH PRIORITY           │
│ SLA: 11 minutes remaining          │
│                                     │
│ Customer: John Doe                 │
│ Phone: [555-1234] (tap to call)    │
│ Address: 123 Main St               │
│                                     │
│ Issue: Furnace blowing hot air,     │
│        smell of gas detected        │
│                                     │
│ Previous service:                   │
│ • 2023-06-15: AC install           │
│ • 2022-03-10: Furnace service      │
│                                     │
│ [ACKNOWLEDGE] (taps to confirm)    │
└─────────────────────────────────────┘
```

**After Acknowledgement:**
```
┌─────────────────────────────────────┐
│ ✓ Acknowledged at 11:52pm          │
│                                     │
│ Customer notified:                  │
│ "Technician is on the way!"         │
│                                     │
│ [View in Dispatch Board]            │
└─────────────────────────────────────┘
```

### 3.4 Escalation Paths

**Path 1: Unacknowledged Emergency**
```
1. Emergency confirmed → SMS sent to on-call tech
2. 5 minutes pass → no acknowledgement
3. System → Phone call to technician (optional, configurable)
4. 10 minutes pass → still no acknowledgement
5. System → Escalate to on-duty admin
6. Admin receives notification + can manually dispatch
```

**Path 2: No On-Call Technician**
```
1. Emergency confirmed → No on-call tech found
2. System → Escalate immediately to on-duty admin
3. Admin receives notification + must manually assign
4. Customer notified: "We're dispatching now. You'll hear from us shortly."
```

**Path 3: SLA Breach**
```
1. SLA breach time passes → sla_status = 'breached'
2. Admin dashboard shows breached requests prominently
3. Post-mortem: What went wrong?
   - Technician didn't acknowledge?
   - No on-call scheduled?
   - System downtime?
```

---

## 4. Edge Cases

### 4.1 All Technicians Busy

**Scenario:** Emergency comes in, on-call technician is already on another emergency.

**Handling:**
```typescript
// Dispatch logic checks technician's active jobs
const activeJobs = await getActiveJobsForTechnician(technicianId);
const emergenciesInProgress = activeJobs.filter(j => j.urgency === 'emergency');

if (emergenciesInProgress.length >= MAX_CONCURRENT_EMERGENCIES) {
  // Escalate to next available tech or admin
  await escalateEmergency(requestId);
}
```

**Customer Communication:**
"All our technicians are currently on emergency calls. We'll dispatch the next available technician and call you within 30 minutes."

### 4.2 Multiple Simultaneous Emergencies

**Scenario:** 3 gas leak emergencies come in within 1 minute.

**Handling:**
- Each emergency gets its own SLA countdown
- On-call tech gets 3 SMS notifications (one per emergency)
- Queue order: first-confirmed = first-acknowledged
- If tech can't handle all, escalate to backup tech

**Admin Dashboard:**
Shows all 3 with individual countdowns. Bulk assign to multiple technicians.

### 4.3 Technician Doesn't Respond

**Scenario:** On-call tech's phone is off/dead, no acknowledgement.

**Handling:**
```
Timeline:
T+0: SMS sent
T+5: Phone call attempt (optional)
T+10: Escalate to on-duty admin
T+15: SLA breach → flag as breached
```

**Admin Notification:**
"Emergency unacknowledged - please dispatch manually. Customer: John Doe, 555-1234."

### 4.4 System Downtime

**Scenario:** Platform goes down during after-hours period. Requests accumulate.

**Handling:**
- **Graceful degradation:** Chatbot shows "We're experiencing issues. Please call 555-9999 for emergencies."
- **Request buffering:** If phone (Twilio) is up, voice intake continues
- **Downtime recovery:** On restart, process queued requests in order
- **SLA pause:** SLA countdown pauses during known outages (optional)

**Recovery Process:**
```typescript
// On system startup
async function handleBacklog() {
  const unassigned = await getUnassignedAfterHoursRequests();
  for (const request of unassigned) {
    // Re-compute SLA (pause downtime period?)
    // Attempt dispatch
    // Notify admins of backlog
  }
}
```

### 4.5 On-Call Schedule Gap

**Scenario:** No on-call technician scheduled for current time.

**Handling:**
```typescript
const onCall = await getOnCallTechnician(orgId, now);
if (!onCall) {
  // Fall back to active technicians in working hours
  const activeTechs = await getActiveTechnicians(orgId, now);
  if (activeTechs.length === 0) {
    // Escalate to on-duty admin
    await escalateToAdmin(requestId);
  }
}
```

**Prevention:**
- Admin UI warns when on-call schedule has gaps
- Weekly summary: "On-call coverage: 100% complete" or "Missing: Saturday 2pm-8pm"

### 4.6 Capacity Hold Race Condition

**Scenario:** Two customers click "Confirm" for the last morning slot simultaneously.

**Handling:**
```typescript
// Confirm endpoint
let attempts = 0;
const MAX_ATTEMPTS = 3;

while (attempts < MAX_ATTEMPTS) {
  const availability = await getOpenAvailability(orgId, days);
  const slot = pickBookableSlot(availability, preferredWindow);
  
  if (!slot) {
    return { error: "No slots available" };
  }
  
  const window = arrivalWindowForSlot(slot.day, slot.window);
  
  // Conditional UPDATE with CAS predicate
  const result = await db.update(serviceRequests)
    .set({ arrivalWindowStart: window.startUtc, arrivalWindowEnd: window.endUtc, status: 'scheduled' })
    .where(
      and(
        eq(serviceRequests.id, requestId),
        // CAS predicate: re-check capacity (simulated via count query)
        exists(
          db.select({ one: sql`1` })
            .from(open_windows) // Simplified: actual query computes live capacity
            .where(and(
              eq(open_windows.day, slot.day),
              eq(open_windows.window, slot.window),
              gt(open_windows.available, 0)
            ))
        )
      )
    )
    .returning({ updated: sql`1` });
  
  if (result.rowsAffected > 0) {
    return { success: true, slot, window };
  }
  
  // Race lost - retry with fresh availability
  attempts++;
}

return { error: "Slot full. Please choose another time." };
```

---

## 5. Success Metrics

### 5.1 Revenue Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **After-Hours Capture Rate** | % of after-hours contacts that become booked jobs | ≥60% |
| **Emergency Conversion** | % of emergency urgencies that result in same-day service | ≥90% |
| **Premium Uplift** | Avg job value for after-hours vs standard hours | +20% |
| **SLA Compliance** | % of emergencies responded within SLA | ≥95% |

### 5.2 Operational Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Time to Assign** | Minutes from confirm to technician assignment | ≤5 |
| **Time to Acknowledge** | Minutes from dispatch to tech acknowledgement | ≤10 |
| **Queue Overnight** | Avg number of unassigned requests each morning | ≤10 |
| **Breached SLAs** | % of emergencies that breach SLA | ≤5% |

### 5.3 Customer Experience Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Customer NPS** | Net Promoter Score for after-hours customers | ≥70 |
| **No-Show Rate** | % of after-hours bookings where customer can't be reached | ≤10% |
| **Repeat Emergency Rate** | % of emergency customers who return within 30 days | ≤15% |

### 5.4 Tracking Implementation

```sql
-- Metrics queries

-- After-hours capture rate
SELECT 
  COUNT(DISTINCT CASE WHEN is_after_hours THEN id END) * 100.0 / COUNT(*) as after_hours_rate
FROM service_requests
WHERE created_at >= NOW() - INTERVAL '30 days';

-- Emergency conversion
SELECT
  COUNT(CASE WHEN urgency = 'emergency' AND status = 'completed' THEN 1 END) * 100.0 / 
  NULLIF(COUNT(CASE WHEN urgency = 'emergency' THEN 1 END), 0) as emergency_conversion
FROM service_requests
WHERE created_at >= NOW() - INTERVAL '30 days';

-- SLA compliance
SELECT
  sla_status,
  COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage
FROM service_requests
WHERE sla_breach_at IS NOT NULL
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY sla_status;
```

---

## 6. Implementation Phases

### Phase 1: Foundation (Week 1)
1. Database migration: `on_call_schedule` + SLA columns
2. On-call queries module
3. Admin on-call schedule editor UI
4. Tests for on-call resolution logic

### Phase 2: Slot Hold (Week 2)
1. Integrate `capacity-hold.ts` into confirm endpoint
2. Public availability endpoint (real-time)
3. Slot selection UI in confirmation flow
4. Race condition testing

### Phase 3: Emergency Dispatch (Week 3)
1. SLA computation module
2. Emergency dispatch service
3. Twilio SMS notifications
4. Technician acknowledgement endpoint
5. Emergency detail page

### Phase 4: After-Hours Queue (Week 4)
1. After-hours queue query module
2. Queue page UI
3. Bulk assign functionality
4. SLA countdown timer
5. Export functionality

### Phase 5: Testing & Polish (Week 5)
1. E2E tests for emergency flow
2. Load testing (simultaneous confirms)
3. SLA breach scenarios
4. Customer notification copy
5. Admin documentation

---

## 7. Open Questions for Product

1. **SLA Pause Policy:** Should SLA countdown pause during known system outages?
   - Option A: Yes, pause during outage
   - Option B: No, SLA is absolute regardless of system state

2. **Emergency Phone Call:** Should the system automatically call the technician if SMS unacknowledged after 5 minutes?
   - Option A: Yes, automated call
   - Option B: No, escalate to admin instead

3. **Customer Deposit:** Should we require a credit card for after-hours emergencies?
   - Option A: Yes, $50 deposit to hold slot
   - Option B: No, trust-based (current)

4. **Pricing Display:** Should the bot disclose after-hours pricing during intake?
   - Option A: Yes, "Emergency rates apply"
   - Option B: No, price disclosed after dispatch

5. **Geofencing:** Should after-hours service be limited to a radius around base location?
   - Option A: Yes, 30-mile max
   - Option B: No, serve entire market

---

## 8. Dependencies

### Existing Modules to Leverage
- `capacity-hold.ts` - Slot selection logic (already implemented)
- `after-hours.ts` - After-hours detection (already implemented)
- `arrival-window.ts` - Time zone conversion (already implemented)
- `scheduling-queries.ts` - Conflict detection (already implemented)
- Twilio MCP - SMS/phone infrastructure (already configured)

### External Services
- **Twilio:** SMS notifications, phone calls
- **ElevenLabs:** TTS for phone notifications (optional)
- **PostgreSQL/Neon:** Database (already configured)

---

## 9. Security & Privacy Considerations

1. **Technician Phone Numbers:** Encrypted at rest, only decrypted for SMS dispatch
2. **Customer PII:** Already encrypted per existing architecture
3. **Audit Trail:** All emergency dispatches logged to `emergency_acknowledgements`
4. **Rate Limiting:** SMS endpoints protected from abuse
5. **Multi-Tenant Isolation:** All queries scoped by `organizationId`

---

## 10. Appendix: Code Examples

### 10.1 Confirm Endpoint Extension

```typescript
// src/app/api/session/confirm/rate.ts (extension to existing)

import { pickBookableSlot, arrivalWindowForSlot, canHoldSlot } from '@/lib/admin/capacity-hold';
import { getOpenAvailability } from '@/lib/admin/scheduling-queries';
import { db } from '@/lib/db';
import { serviceRequests } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

// In the confirm handler, after extraction passes:

const availability = await getOpenAvailability(organizationId, {
  fromDate: today,
  toDate: todayPlusDays(7),
});

const slot = pickBookableSlot(availability, extraction.preferredWindow ?? 'asap');

if (!slot) {
  return errorResponse('No slots available. Please call us.', 'NO_AVAILABILITY', 409);
}

const window = arrivalWindowForSlot(slot.day, slot.window);

// Re-check capacity (CAS predicate) before writing
const freshAvailable = availableForBand(availability, slot.day, slot.window);

if (!canHoldSlot(freshAvailable)) {
  // Race lost - retry or report full
  return errorResponse('This slot just filled up. Please choose another time.', 'SLOT_FULL', 409);
}

// Atomic write with guard
const [request] = await db
  .update(serviceRequests)
  .set({
    arrivalWindowStart: window.startUtc,
    arrivalWindowEnd: window.endUtc,
    status: 'scheduled',
    scheduledDate: slot.day,
  })
  .where(eq(serviceRequests.id, requestId))
  .returning();

// If emergency, dispatch immediately
if (request.urgency === 'emergency') {
  await dispatchEmergency(request.id);
}

return successResponse({ 
  request, 
  slot, 
  window 
});
```

### 10.2 Emergency Dispatch Service

```typescript
// src/lib/admin/emergency-dispatch.ts

import { db } from '@/lib/db';
import { serviceRequests, emergency_acknowledgements, users } from '@/lib/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getOnCallTechnician } from './on-call-queries';
import { sendEmergencyDispatchSms } from '@/lib/notifications/emergency-sms';
import { computeSlaBreachAt } from './sla-compute';

export interface DispatchResult {
  ok: boolean;
  technicianId?: string;
  acknowledged?: boolean;
  reason?: string;
}

export async function dispatchEmergency(requestId: string): Promise<DispatchResult> {
  const [request] = await db
    .select()
    .from(serviceRequests)
    .where(eq(serviceRequests.id, requestId))
    .limit(1);

  if (!request || request.urgency !== 'emergency') {
    return { ok: false, reason: 'Request not found or not an emergency' };
  }

  const onCall = await getOnCallTechnician(request.organizationId);
  
  if (!onCall) {
    // Escalate to on-duty admin
    await escalateToOnDutyAdmin(requestId);
    return { ok: false, reason: 'No on-call technician - escalated to admin' };
  }

  // Assign request to on-call technician
  await db
    .update(serviceRequests)
    .set({
      assignedTo: onCall.technicianId,
      slaStatus: 'pending',
      slaResponderUserId: onCall.technicianId,
      slaBreachAt: computeSlaBreachAt(
        request.urgency,
        request.issueType,
        request.isAfterHours ?? false,
        request.createdAt
      ),
    })
    .where(eq(serviceRequests.id, requestId));

  // Send SMS notification
  await sendEmergencyDispatchSms(onCall.phone, {
    referenceNumber: request.referenceNumber,
    customerPhone: request.customerPhoneEncrypted, // decrypted for SMS
    issueType: request.issueType,
    urgency: request.urgency,
    address: request.addressEncrypted, // decrypted for SMS
    slaMinutes: 15, // or computed based on SLA tier
  });

  return { 
    ok: true, 
    technicianId: onCall.technicianId,
    acknowledged: false 
  };
}

async function escalateToOnDutyAdmin(requestId: string): Promise<void> {
  // Find on-duty admins (active admins in working hours OR explicitly on-duty)
  // Send in-app notification
  // Could also send SMS to admin phone if configured
}
```

### 10.3 Technician Acknowledgement Endpoint

```typescript
// src/app/api/emergency/acknowledge/route.ts

import { NextRequest } from 'next/server';
import { getAdminSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { serviceRequests, emergency_acknowledgements } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { successResponse, errorResponse } from '@/lib/api-response';
import { acknowledgeEmergency } from '@/lib/admin/emergency-dispatch';

export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);
  }

  const body = await request.json();
  const { requestId, channel } = body;

  try {
    await acknowledgeEmergency(
      requestId,
      session.userId,
      channel ?? 'app'
    );

    return successResponse({ acknowledged: true });
  } catch (error) {
    return errorResponse('Failed to acknowledge', 'ACK_FAILED', 500);
  }
}
```

---

## 11. Testing Strategy

### 11.1 Unit Tests

- `on-call-queries.test.ts`: On-call resolution logic
- `sla-compute.test.ts`: SLA deadline computation
- `emergency-dispatch.test.ts`: Dispatch logic with mocked SMS
- `capacity-hold.test.ts`: Slot selection and CAS predicate

### 11.2 Integration Tests

- Confirm endpoint with slot-hold
- Emergency dispatch with real Twilio sandbox
- After-hours queue queries with multi-tenant isolation

### 11.3 E2E Tests (Playwright)

- Customer confirms booking → slot assigned
- Emergency confirmed → SMS sent → technician acknowledges
- After-hours queue → bulk assign
- SLA breach scenario → admin escalation

### 11.4 Load Tests

- 100 simultaneous confirms for last slot → 1 success, 99 "slot full"
- 10 emergencies in 1 minute → all dispatched correctly

---

## 12. Documentation Requirements

1. **Admin Guide:** How to set up on-call schedule, handle queue
2. **Technician Guide:** How to acknowledge emergencies, mobile app usage
3. **SLA Configuration:** How to customize SLA deadlines per organization
4. **Troubleshooting:** What to do when emergencies go wrong

---

## 13. Sign-Off Checklist

Before launching Stage A:

- [ ] All database migrations run successfully
- [ ] On-call schedule can be set via admin UI
- [ ] Emergency dispatch sends SMS (Twilio sandbox verified)
- [ ] Slot hold prevents double-booking (load tested)
- [ ] After-hours queue displays correctly
- [ ] SLA countdown timer works in real-time
- [ ] E2E test passes: emergency → SMS → acknowledgement
- [ ] Admin documentation complete
- [ ] Technician guide complete
- [ ] Success metrics dashboard built
- [ ] Security review passed (no PII leakage in SMS)

---

**End of Specification**
