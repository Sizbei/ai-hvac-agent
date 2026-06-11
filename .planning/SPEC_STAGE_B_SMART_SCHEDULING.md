# Stage B: Admin Overhead (Smart Scheduling & Dispatch)
## Technical Specification v1.0

**Target Customer:** 5-technician HVAC service companies
**Primary Goal:** Reduce admin scheduling time by 70% through AI-powered automation
**Architecture Pattern:** Human-in-the-loop AI (suggests, admin confirms)

---

## Executive Summary

Stage B transforms the manual dispatch process into an intelligent, automated system that:
1. **Auto-assigns** technicians to new service requests based on skills, proximity, and availability
2. **Predicts** job duration using historical data and job characteristics
3. **Optimizes** daily routes to minimize travel time and maximize efficiency
4. **Provides** technicians with a mobile "Perfect Day" experience
5. **Learns** from completed jobs to continuously improve predictions

The system operates on a "suggest-confirm" model: AI makes recommendations, admins retain full control to override or adjust.

---

## 1. Feature Requirements

### 1.1 Technician Skills Model

#### Core Skill Dimensions

**1. Equipment Type Expertise**
Maps to existing `systemTypeEnum` with proficiency levels:
```typescript
type EquipmentSkill = {
  systemType: 'central_ac' | 'furnace' | 'heat_pump' | 'mini_split' | 'boiler' | 'packaged_unit' | 'other'
  proficiency: 'apprentice' | 'journeyman' | 'master' // Can perform independently, can teach
  certified: boolean // EPA 608, NATE, manufacturer certification
}
```

**2. Job Type Capability**
Maps to existing `jobTypeEnum` with eligibility:
```typescript
type JobSkill = {
  jobType: 'service_call' | 'no_heat' | 'no_cool' | 'maintenance' | 'install' | 'estimate' | 'warranty' | 'diagnostic' | 'inspection'
  eligible: boolean // Can this tech perform this job type solo?
  leadTechRequired: boolean // If false, must be paired with a lead tech
}
```

**3. Brand Specialization**
Optional manufacturer expertise (for warranty work, factory-specific training):
```typescript
type BrandSpecialization = {
  brand: string // 'Carrier', 'Trane', 'Lennox', 'Goodman', etc.
  certified: boolean
  preferredFor: boolean // Brand requests this tech for warranty calls
}
```

**4. Physical Requirements**
For job matching when available:
```typescript
type PhysicalCapability = {
  canLiftLbs: number // Weight capacity (typical HVAC units: 80-200 lbs)
  canWorkAtHeights: boolean // Roof work, second-story units
  confinedSpaces: boolean // Crawlspaces, attics
}
```

#### Skills Validation
- Skills entered by admin during technician onboarding
- Admin can upload certifications (PDF/image) for verification
- System tracks when certifications expire (NATE renewal every 2 years)
- Admins receive alerts when certifications approach expiry

### 1.2 Technician Location & Tracking

#### Location States

**1. Home Base (Required)**
- technician's starting location each morning
- Used for morning route optimization
- Set by technician in mobile app or by admin
- Defaults to organization's BUSINESS_BASE_LOCATION constant

**2. Current Location (During Work Hours)**
- Real-time GPS tracking via mobile app
- Updates every 2 minutes while technician is "on shift"
- Privacy-paused outside of working hours (per technician_availability)
- Used for proximity-based assignment: "Who can get there fastest from where they are NOW"

**3. Job Location (When Assigned)**
- The service address of the technician's current/next job
- Updated when job status changes to `in_progress`
- Used for ETA calculations and route optimization

#### Location Privacy Controls
- Technicians can toggle tracking visibility
- Location data used ONLY for dispatch purposes
- Historical location data NOT retained beyond 24 hours
- Admins see "Last known: X minutes ago" indicator

### 1.3 AI Assignment Algorithm

#### Multi-Factor Scoring

The assignment algorithm calculates a match score (0-100) for each technician:

```
Assignment Score = 
  Skills Match (40%) +
  Proximity (30%) +
  Availability (20%) +
  Workload Balance (10%)
```

**1. Skills Match (40 points)**
```typescript
function calculateSkillsMatch(tech: Technician, job: ServiceRequest): number {
  let score = 0;
  const maxScore = 40;

  // Required: Equipment type proficiency
  const requiredSystem = job.systemType;
  const techProficiency = tech.skills.find(s => s.systemType === requiredSystem)?.proficiency;
  if (!techProficiency) return 0; // Ineligible
  if (techProficiency === 'master') score += 15;
  else if (techProficiency === 'journeyman') score += 12;
  else score += 8; // apprentice

  // Required: Job type eligibility
  const jobEligible = tech.jobSkills.find(j => j.jobType === job.jobType)?.eligible;
  if (!jobEligible) return 0; // Ineligible
  score += 10;

  // Bonus: Brand certification for warranty work
  if (job.jobType === 'warranty' && job.underWarranty === 'yes') {
    if (tech.brandSpecializations.some(b => b.brand === job.equipmentBrand && b.certified)) {
      score += 10;
    }
  }

  // Bonus: NATE certification
  if (tech.nateCertified) score += 5;

  return score;
}
```

**2. Proximity (30 points)**
```typescript
function calculateProximity(tech: Technician, jobAddress: Address): number {
  const distance = getDistance(tech.currentLocation, jobAddress); // miles
  const maxScore = 30;

  // 0 miles = 30 points, 30+ miles = 0 points (linear falloff)
  // Service area is 50km (~31 miles) per BUSINESS_BASE_LOCATION
  const maxRelevantDistance = 30;
  return Math.max(0, maxScore * (1 - distance / maxRelevantDistance));
}
```

**3. Availability (20 points)**
```typescript
function calculateAvailability(tech: Technician, jobTime: DateTime): number {
  const maxScore = 20;

  // Check: Is technician scheduled to work at this time?
  const isWorking = isTechnicianScheduled(tech, jobTime);
  if (!isWorking) return 0;

  // Check: Does technician have existing jobs at this time?
  const conflict = getJobsAtTime(tech, jobTime);
  if (conflict.length > 0) return 0;

  // Bonus: Technician has availability block BEFORE this job
  // (indicates they're not starting mid-day elsewhere)
  const hasEarlierAvailability = hasAvailabilityBefore(tech, jobTime);
  if (hasEarlierAvailability) score += 10;

  return 20;
}
```

**4. Workload Balance (10 points)**
```typescript
function calculateWorkloadBalance(tech: Technician, date: Date): number {
  const maxScore = 10;
  const techJobsToday = countJobsForTechnician(tech, date);
  const avgJobsPerTech = getAverageJobsPerTechnician(date);

  // Ideal: Each tech has similar job count
  // Penalty: Tech is significantly above average
  const deviation = Math.abs(techJobsToday - avgJobsPerTech);
  const maxDeviation = 3; // More than 3 jobs above/below average = 0 points

  return Math.max(0, maxScore * (1 - deviation / maxDeviation));
}
```

#### Assignment Decision Rules
```typescript
function makeAssignmentRecommendation(job: ServiceRequest): AssignmentRecommendation {
  const technicians = getActiveTechnicians(job.organizationId);
  const scores = technicians.map(tech => ({
    technician: tech,
    score: calculateAssignmentScore(tech, job)
  })).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    return { status: 'no_elible_technician' };
  }

  const top = scores[0];
  const second = scores[1] || { score: 0 };

  // Confidence: gap between top and second choice
  const confidenceGap = top.score - second.score;

  return {
    status: 'recommendation_ready',
    recommendedTechnician: top.technician,
    score: top.score,
    confidence: confidenceGap > 15 ? 'high' : confidenceGap > 5 ? 'medium' : 'low',
    alternatives: scores.slice(1, 3).map(s => s.technician),
    reason: generateReason(top.technician, job, top.score)
  };
}
```

### 1.4 Predictive Job Duration

#### Prediction Model Features

**1. Base Duration by Job Type** (from historical averages)
```typescript
const BASE_DURATIONS = {
  service_call: 90, // minutes
  maintenance: 60,
  diagnostic: 75,
  install: 480, // 8 hours
  estimate: 30,
  no_heat: 105, // Often involves diagnostic + repair
  no_cool: 105,
  warranty: 90,
  inspection: 45
};
```

**2. Modifiers**
```typescript
function predictJobDuration(job: ServiceRequest): number {
  let duration = BASE_DURATIONS[job.jobType];

  // System type modifier
  if (job.systemType === 'heat_pump') duration *= 1.2; // More complex
  if (job.systemType === 'mini_split') duration *= 1.3; // Multiple indoor units
  if (job.systemType === 'boiler') duration *= 1.4; // Older systems, more complex

  // Equipment age modifier
  if (job.equipmentAgeBand === 'over_15') duration *= 1.5; // Older = more problems
  if (job.equipmentAgeBand === 'under_5') duration *= 0.9; // Newer = quicker

  // System status modifier
  if (job.systemDownStatus === 'fully_down') duration *= 1.3; // Full repair vs. partial

  // Property type modifier
  if (job.propertyType === 'commercial') duration *= 1.4; // Larger systems

  // Access difficulty
  if (job.accessNotes?.toLowerCase().includes('roof')) duration *= 1.2;
  if (job.accessNotes?.toLowerCase().includes('crawlspace')) duration *= 1.3;
  if (job.accessNotes?.toLowerCase().includes('attic')) duration *= 1.2;

  // Urgency modifier (rush jobs may be shorter per-task but include travel)
  if (job.urgency === 'emergency') duration *= 1.1;

  return Math.round(duration); // minutes
}
```

**3. Learning from History**
After each completed job, the system records:
- Predicted duration vs. actual duration
- Error margin (actual / predicted - 1)
- Which modifiers were applied

Weekly analysis updates base durations and modifier weights:
```sql
-- Simplified learning query
SELECT
  job_type,
  system_type,
  equipment_age_band,
  AVG(actual_duration_minutes) as avg_actual,
  AVG(predicted_duration_minutes) as avg_predicted,
  AVG(actual_duration_minutes / predicted_duration_minutes) as accuracy_ratio
FROM service_requests
WHERE completed_at >= NOW() - INTERVAL '30 days'
  AND status = 'completed'
GROUP BY job_type, system_type, equipment_age_band
```

### 1.5 Daily Route Optimization

#### Optimization Goals
For each technician, optimize the sequence of jobs to:
1. Minimize total travel distance
2. Minimize total travel time
3. Respect customer arrival windows
4. Start/end from technician's home base

#### Algorithm: Nearest Neighbor with Time Windows
Given the small scale (5 technicians, ~8 jobs each max), a simple heuristic performs well:

```typescript
function optimizeDailyRoute(technician: Technician, jobs: ServiceRequest[], date: Date): OptimizedRoute {
  const homeBase = technician.homeBaseLocation;
  const route = [homeBase];
  let currentTime = technician.startTime; // From technician_availability
  const remainingJobs = [...jobs];

  while (remainingJobs.length > 0) {
    const currentLocation = route[route.length - 1];
    let bestNext = null;
    let bestScore = -Infinity;

    for (const job of remainingJobs) {
      if (job.arrivalWindowStart && currentTime > job.arrivalWindowStart) {
        continue; // Would miss this window
      }

      const travelTime = getTravelTime(currentLocation, job.address);
      const arrivalTime = currentTime + travelTime + predictJobDuration(job);

      // Score: Prefer jobs that are close AND fit in their windows
      let score = 100 - travelTime; // Fewer minutes = better
      if (job.arrivalWindowStart) {
        const windowMargin = job.arrivalWindowStart - arrivalTime;
        if (windowMargin < 0) score -= 1000; // Missed window = terrible
        else if (windowMargin < 15) score -= 100; // Too close for comfort
        else if (windowMargin < 60) score += 50; // Perfect: arriving early-ish
      }

      if (score > bestScore) {
        bestScore = score;
        bestNext = { job, arrivalTime, travelTime };
      }
    }

    if (!bestNext) break; // No valid remaining jobs

    route.push(bestNext.job.address);
    currentTime = bestNext.arrivalTime + predictJobDuration(bestNext.job);
    remainingJobs.splice(remainingJobs.indexOf(bestNext.job), 1);
  }

  // Return home at end of day
  route.push(homeBase);

  return {
    technician: technician.id,
    date,
    stops: route,
    totalTravelTime: calculateTotalTravelTime(route),
    totalJobTime: calculateTotalJobTime(jobs),
    efficiency: calculateEfficiency(route)
  };
}
```

#### Route Optimization Timing
- Runs automatically:
  - When a new job is assigned
  - At 6 AM daily (pre-route for all technicians)
  - When a job is completed (re-optimize remaining jobs)
- Admin can trigger manual re-optimization

### 1.6 "Perfect Day" Technician Experience

#### Mobile App Core Features

**1. Today's Route**
- Map view showing optimized route
- List view with job details:
  - Customer name (not full address until job starts)
  - Job type, system type, urgency
  - ETA to next job
  - Predicted duration
  - Special notes (access instructions, equipment info)

**2. Job Details (When Started)**
- Full address with "Navigate" button (opens Waze/Google Maps)
- Customer contact info (phone tap-to-call)
- Equipment history (prior service calls, equipment age)
- Problem description (from chat intake)
- Access notes (gate code, pets, parking)
- Photo attachments (from customer)

**3. Job Completion Flow**
```typescript
interface JobCompletion {
  // Required
  status: 'completed' | 'on_hold' | 'cancelled';
  workPerformed: string; // Technician notes
  partsUsed: string[]; // Quick-select + custom

  // Optional
  photos: Photo[]; // Before/after photos
  customerSignature?: string; // Digital signature
  followUpNeeded: boolean;
  followUpReason?: string;

  // For on_hold
  holdReason: 'awaiting_parts' | 'awaiting_customer' | 'awaiting_access' | 'other';

  // Learning data (auto-captured)
  actualDuration: number; // Minutes from start to complete
  actualTravelTime: number; // Minutes from previous job
}
```

**4. Status Updates (One Tap)**
- "On my way" (en route to job)
- "On site" (arrived at customer location)
- "Working" (actively repairing)
- "Cleaning up" (finished work, cleaning area)
- "Complete" (job finished, leaving)

Each update:
- Timestamps the activity
- Updates admin dispatch board in real-time
- Triggers customer SMS notification (if opted in)

**5. Offline Support**
- Job details cached locally
- Completion form works offline
- Syncs when connection restored
- Shows "Syncing..." indicator

---

## 2. Technical Architecture

### 2.1 Database Schema Extensions

#### New Tables

**1. technician_skills**
```sql
CREATE TABLE technician_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  technician_id UUID NOT NULL REFERENCES users(id),
  skill_type TEXT NOT NULL, -- 'equipment', 'job_type', 'brand', 'physical'
  skill_key TEXT NOT NULL, -- e.g., 'central_ac', 'install', 'carrier', 'lift_80lbs'
  proficiency JSONB, -- { level: 'master', certified: true, etc. }
  certified_at TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(organization_id, technician_id, skill_type, skill_key)
);

CREATE INDEX idx_tech_skills_org ON technician_skills(organization_id);
CREATE INDEX idx_tech_skills_tech ON technician_skills(technician_id);
CREATE INDEX idx_tech_skills_type ON technician_skills(skill_type, skill_key);
```

**2. technician_locations**
```sql
CREATE TABLE technician_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  technician_id UUID NOT NULL REFERENCES users(id),
  location_type TEXT NOT NULL, -- 'home_base', 'current', 'job_site'
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  address TEXT,
  accuracy_meters INTEGER,
  recorded_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB, -- { source: 'gps', 'manual', 'inferred' }
  expires_at TIMESTAMP, -- For 'current' locations: 24h retention
  UNIQUE(organization_id, technician_id, location_type)
);

CREATE INDEX idx_tech_locations_org ON technician_locations(organization_id);
CREATE INDEX idx_tech_locations_tech ON technician_locations(technician_id);
CREATE INDEX idx_tech_locations_recorded ON technician_locations(recorded_at);
```

**3. job_duration_predictions**
```sql
CREATE TABLE job_duration_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  service_request_id UUID NOT NULL REFERENCES service_requests(id),
  predicted_minutes INTEGER NOT NULL,
  actual_minutes INTEGER,
  error_margin DECIMAL(5, 2), -- (actual - predicted) / predicted
  model_version TEXT NOT NULL, -- 'v1.0', 'v1.1', etc.
  features JSONB NOT NULL, -- { job_type, system_type, equipment_age, etc. }
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_duration_org ON job_duration_predictions(organization_id);
CREATE INDEX idx_duration_request ON job_duration_predictions(service_request_id);
CREATE INDEX idx_duration_created ON job_duration_predictions(created_at);
```

**4. assignment_logs**
```sql
CREATE TABLE assignment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  service_request_id UUID NOT NULL REFERENCES service_requests(id),
  recommended_technician_id UUID REFERENCES users(id),
  assigned_technician_id UUID REFERENCES users(id),
  recommendation_score DECIMAL(5, 2),
  recommendation_reason TEXT,
  admin_overridden BOOLEAN DEFAULT false,
  override_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_assignment_org ON assignment_logs(organization_id);
CREATE INDEX idx_assignment_request ON assignment_logs(service_request_id);
CREATE INDEX idx_assignment_created ON assignment_logs(created_at);
```

**5. route_optimizations**
```sql
CREATE TABLE route_optimizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  technician_id UUID NOT NULL REFERENCES users(id),
  date DATE NOT NULL,
  route JSONB NOT NULL, -- Array of { lat, lon, job_id, arrival_time }
  total_travel_minutes INTEGER NOT NULL,
  total_job_minutes INTEGER NOT NULL,
  efficiency_score DECIMAL(5, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(organization_id, technician_id, date)
);

CREATE INDEX idx_route_org ON route_optimizations(organization_id);
CREATE INDEX idx_route_tech_date ON route_optimizations(technician_id, date);
```

#### Schema Extensions to Existing Tables

**1. users table (technicians only)**
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_base_location_lat DECIMAL(10, 8);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_base_location_lon DECIMAL(11, 8);
ALTER TABLE users ADD COLUMN IF NOT EXISTS nate_certified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS epa_608_cert_type TEXT; -- 'type_i', 'type_ii', 'type_iii', 'universal'
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_device_id UUID; -- For push notifications
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_tracking_enabled BOOLEAN DEFAULT true;
```

**2. service_requests table**
```sql
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assignment_score DECIMAL(5, 2);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assignment_confidence TEXT; -- 'high', 'medium', 'low'
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS predicted_duration_minutes INTEGER;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS actual_duration_minutes INTEGER;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS route_position INTEGER; -- 1st, 2nd, 3rd job of day
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS travel_time_from_previous INTEGER; -- minutes
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS travel_time_to_next INTEGER; -- minutes
```

### 2.2 Assignment Algorithm Architecture

#### Module: `src/lib/dispatch/assignment-engine.ts`

```typescript
interface AssignmentEngine {
  // Core scoring
  calculateAssignmentScore(technician: Technician, job: ServiceRequest): Score;
  generateRecommendation(job: ServiceRequest): AssignmentRecommendation;

  // Skills matching
  getSkillsForJob(job: ServiceRequest): RequiredSkills[];
  isTechnicianEligible(technician: Technician, skills: RequiredSkills[]): boolean;

  // Proximity calculation
  getTechnicianLocation(technician: Technician): Location;
  calculateDistance(from: Location, to: Location): number;
  calculateTravelTime(from: Location, to: Location): number;

  // Availability checking
  isTechnicianAvailable(technician: Technician, at: DateTime): boolean;
  getJobsAtTime(technician: Technician, at: DateTime): ServiceRequest[];
  hasAvailabilityBefore(technician: Technician, at: DateTime): boolean;

  // Workload balancing
  getTechnicianWorkload(technician: Technician, date: Date): number;
  getAverageWorkload(date: Date): number;
}

interface Score {
  total: number; // 0-100
  breakdown: {
    skills: number;
    proximity: number;
    availability: number;
    workloadBalance: number;
  };
  reasons: string[]; // Human-readable explanations
}

interface AssignmentRecommendation {
  status: 'recommendation_ready' | 'no_eligible_technician' | 'manual_required';
  recommendedTechnician?: Technician;
  score?: number;
  confidence?: 'high' | 'medium' | 'low';
  alternatives?: Technician[];
  reason?: string;
}
```

#### Background Worker: `src/lib/dispatch/assignment-worker.ts`

```typescript
// Runs on: service_request.created event
async function handleNewServiceRequest(event: ServiceRequestCreatedEvent) {
  const job = await getServiceRequest(event.requestId);

  // Skip if already assigned (manual assignment)
  if (job.assignedTo) return;

  // Generate recommendation
  const recommendation = await assignmentEngine.generateRecommendation(job);

  if (recommendation.status !== 'recommendation_ready') {
    // Alert admin: no eligible technicians
    await sendAdminAlert({
      type: 'no_eligible_technician',
      requestId: job.id,
      reason: recommendation.reason
    });
    return;
  }

  // Store recommendation for admin review
  await storeAssignmentRecommendation(job.id, recommendation);

  // If confidence is HIGH and auto-assign is enabled, assign automatically
  const orgSettings = await getOrganizationSettings(job.organizationId);
  if (orgSettings.autoAssignEnabled && recommendation.confidence === 'high') {
    await assignTechnician(job.id, recommendation.recommendedTechnician.id);
    await sendTechnicianNotification(recommendation.recommendedTechnician.id, {
      type: 'new_assignment',
      job: job
    });
  } else {
    // Notify admin of pending recommendation
    await sendAdminNotification({
      type: 'assignment_recommendation',
      requestId: job.id,
      recommendation: recommendation
    });
  }
}
```

### 2.3 Route Optimization Approach

#### Module: `src/lib/dispatch/route-optimizer.ts`

```typescript
interface RouteOptimizer {
  // Daily optimization
  optimizeDailyRoute(technician: Technician, date: Date): OptimizedRoute;
  optimizeAllRoutes(date: Date): Map<Technician, OptimizedRoute>;

  // Real-time re-optimization
  reoptimizeAfterCompletion(completedJob: ServiceRequest): OptimizedRoute;
  reoptimizeAfterCancellation(cancelledJob: ServiceRequest): OptimizedRoute;

  // Efficiency analysis
  calculateRouteEfficiency(route: OptimizedRoute): number;
  compareRoutes(before: OptimizedRoute, after: OptimizedRoute): RouteComparison;
}

interface OptimizedRoute {
  technician: Technician;
  date: Date;
  stops: RouteStop[];
  summary: {
    totalJobs: number;
    totalJobTime: number; // minutes
    totalTravelTime: number; // minutes
    totalDriveDistance: number; // miles
    efficiency: number; // 0-100
    revenue: number; // estimated
  };
}

interface RouteStop {
  sequence: number; // 0 = home base, 1 = first job, etc.
  location: Location;
  job?: ServiceRequest; // null for home base
  arrivalTime: DateTime;
  departureTime: DateTime;
  travelFromPrevious: number; // minutes
}
```

#### Optimization Triggers

```typescript
// Event-driven optimization
optimizationTriggers: {
  'job.completed': reoptimizeRemainingJobs,
  'job.cancelled': reoptimizeRemainingJobs,
  'job.assigned': reoptimizeTechnicianRoute,
  'technician.location_updated': reoptimizeIfSignificantChange,
  'daily.6am': optimizeAllRoutesForToday
}
```

### 2.4 Mobile App Requirements

#### Platform Choice: Progressive Web App (PWA)

**Rationale:**
- Single codebase across iOS/Android
- No app store approval delays
- Works on desktop (for admins)
- Offline support via Service Workers
- Push notifications via Web Push API
- Access to geolocation API

#### Tech Stack
```typescript
// Frontend
- React 18+ (shared with admin dashboard)
- PWA Builder / Vite PWA plugin
- Workbox for service workers
- Mapbox GL JS for maps
- Web Push API for notifications

// State management
- Zustand (lightweight, works offline)

// Storage
- IndexedDB for offline job data
- Cache API for map tiles
```

#### Key Screens

**1. Login Screen**
- Email + password (shares auth with admin)
- Biometric auth (Face ID / Touch ID) via WebAuthn

**2. Today's Route (Home)**
- Map view with optimized route
- List of jobs in sequence
- Pull-to-refresh
- "Start Work" button (first job only)

**3. Job Detail Screen**
- Full job information
- "Start Job" / "Complete Job" actions
- Customer contact (tap-to-call)
- Equipment history
- Navigate button (opens external maps)

**4. Job Completion Modal**
- Work performed (text area)
- Parts used (multi-select + custom)
- Photos (camera capture)
- Customer signature (canvas)
- Follow-up needed (toggle + reason)
- Submit button

**5. Profile Screen**
- Home base location (set/edit)
- Location tracking toggle
- Skills view (read-only)
- Certifications view (read-only)
- Notifications preferences

#### API Endpoints for Mobile

```typescript
// Authentication
POST /api/technician/auth/login
POST /api/technician/auth/refresh

// Today's route
GET /api/technician/route/today
GET /api/technician/jobs/:id

// Job updates
POST /api/technician/jobs/:id/start
POST /api/technician/jobs/:id/complete
POST /api/technician/jobs/:id/status

// Location updates
POST /api/technician/location/update
POST /api/technician/home-base/set

// Offline sync
POST /api/technician/sync/pending
GET /api/technician/sync/today
```

### 2.5 Admin Dispatch Board Redesign

#### New Dispatch Board Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Dispatch Board                    [Auto-Pilot: ON] [Optimize] │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Pending Assignments (3)                                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🔥 #REQ-123 - No Heat (Emergency)                   │    │
│  │    Johnson City • 15 min ago                        │    │
│  │    AI: Assign Mike (92% confidence)                 │    │
│  │    [Accept] [Reassign] [Details]                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  Today's Routes - Tuesday, Jun 11                           │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐  │
│  │ Mike        │ Sarah       │ James       │ Emily       │  │
│  │ 8am-5pm     │ 8am-4pm     │ Off today   │ 9am-5pm     │  │
│  │ 5 jobs      │ 4 jobs      │             │ 6 jobs      │  │
│  │ ─────────── │ ─────────── │             │ ─────────── │  │
│  │ 🏠 Home     │ 🏠 Home     │             │ 🏠 Home     │  │
│  │ ↓ 12 min    │ ↓ 8 min     │             │ ↓ 15 min    │  │
│  │ 🔧 #REQ-120 │ 🔧 #REQ-118 │             │ 🔧 #REQ-121 │  │
│  │ 9:00-10:30  │ 8:30-9:30   │             │ 9:15-10:00  │  │
│  │ ↓ 18 min    │ ↓ 22 min    │             │ ↓ 10 min    │  │
│  │ 🔧 #REQ-122 │ 🔧 #REQ-119 │             │ 🔧 #REQ-124 │  │
│  │ 10:48-12:00 │ 9:52-11:00  │             │ 10:10-11:30 │  │
│  │ ...         │ ...         │             │ ...         │  │
│  │ 🏠 Home     │ 🏠 Home     │             │ 🏠 Home     │  │
│  │ 5:00pm      │ 4:00pm      │             │ 5:30pm      │  │
│  └─────────────┴─────────────┴─────────────┴─────────────┘  │
│                                                               │
│  [Unassigned Jobs (2)]  [On-Hold Jobs (1)]  [Completed]    │
└─────────────────────────────────────────────────────────────┘
```

#### Dispatch Board Interactions

**1. Pending Assignment Card**
- Shows AI recommendation with confidence score
- Click "Accept" to auto-assign
- Click "Reassign" to see alternative technicians (with scores)
- Click "Details" to view full job information

**2. Technician Column**
- Shows home/return locations
- Shows optimized route with travel times
- Drag-and-drop jobs between columns
- Click job to view details or reassign

**3. Auto-Pilot Mode**
- When ON: AI auto-assigns high-confidence recommendations
- When OFF: All assignments require manual approval
- Toggle persists per organization

**4. Optimize Button**
- Triggers manual re-optimization of all routes
- Shows "Optimizing..." spinner during calculation
- Displays summary: "Saved 23 minutes across 5 routes"

---

## 3. AI/ML Components

### 3.1 Job Duration Prediction Model

#### Model Architecture: Rule-Based with Learning

**Phase 1: Rule-Based Baseline (MVP)**
- Start with fixed base durations per job type
- Apply deterministic modifiers (system type, age, property type)
- No ML required initially

**Phase 2: Linear Regression (After 100+ completed jobs)**
```typescript
// Simple linear model: duration = w1*jobType + w2*systemType + w3*age + b
interface DurationModel {
  coefficients: {
    jobType: Record<string, number>;    // service_call: 90, install: 480, etc.
    systemType: Record<string, number>; // central_ac: 1.0, heat_pump: 1.2, etc.
    equipmentAge: Record<string, number>; // under_5: 0.9, over_15: 1.5, etc.
    propertyType: Record<string, number>; // residential: 1.0, commercial: 1.4, etc.
  };
  bias: number; // Base adjustment
  version: string; // For tracking model iterations
}

function predictDuration(job: ServiceRequest, model: DurationModel): number {
  const base = model.coefficients.jobType[job.jobType] || 90;
  const systemMultiplier = model.coefficients.systemType[job.systemType] || 1.0;
  const ageMultiplier = model.coefficients.equipmentAge[job.equipmentAgeBand] || 1.0;
  const propertyMultiplier = model.coefficients.propertyType[job.propertyType] || 1.0;

  return Math.round(base * systemMultiplier * ageMultiplier * propertyMultiplier + model.bias);
}
```

**Phase 3: Gradient Boosting (After 1000+ completed jobs)**
- Consider XGBoost or similar for non-linear relationships
- Feature interactions (e.g., old heat pumps take longer than average)
- Seasonal effects (winter no-heat jobs quicker than summer)

#### Model Training Pipeline

```typescript
// Weekly training job (Sundays at 2 AM)
async function trainDurationModel(orgId: string): Promise<DurationModel> {
  // Fetch last 90 days of completed jobs with predictions
  const history = await db.query(`
    SELECT
      sr.job_type,
      sr.system_type,
      sr.equipment_age_band,
      sr.property_type,
      sr.system_down_status,
      jdp.predicted_minutes,
      jdp.actual_minutes,
      jdp.error_margin
    FROM service_requests sr
    JOIN job_duration_predictions jdp ON sr.id = jdp.service_request_id
    WHERE sr.organization_id = $1
      AND sr.status = 'completed'
      AND sr.completed_at >= NOW() - INTERVAL '90 days'
    ORDER BY sr.completed_at DESC
  `, [orgId]);

  // Calculate new coefficients using ordinary least squares
  const coefficients = calculateOptimalCoefficients(history);

  // Validate model on hold-out set (last 10 days)
  const validationSet = history.slice(0, Math.floor(history.length * 0.1));
  const accuracy = validateModel(validationSet, coefficients);

  // Only deploy if accuracy improves
  const currentModel = await getCurrentModel(orgId);
  if (accuracy > currentModel.accuracy) {
    await deployModel(orgId, {
      ...coefficients,
      version: `v${Date.now()}`,
      accuracy
    });
  }

  return coefficients;
}
```

### 3.2 Assignment Scoring Algorithm

#### Score Calculation Details

```typescript
function calculateAssignmentScore(technician: Technician, job: ServiceRequest): Score {
  const breakdown = {
    skills: calculateSkillsMatch(technician, job),
    proximity: calculateProximity(technician, job),
    availability: calculateAvailability(technician, job),
    workloadBalance: calculateWorkloadBalance(technician, job.scheduledDate)
  };

  const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);

  const reasons = generateScoreReasons(breakdown, technician, job);

  return { total, breakdown, reasons };
}

function generateScoreReasons(breakdown: ScoreBreakdown, tech: Technician, job: ServiceRequest): string[] {
  const reasons = [];

  if (breakdown.skills >= 35) {
    reasons.push(`${tech.name} is a certified expert in ${job.systemType} systems`);
  } else if (breakdown.skills >= 25) {
    reasons.push(`${tech.name} has experience with ${job.systemType} systems`);
  }

  if (breakdown.proximity >= 25) {
    reasons.push(`${tech.name} is currently the closest technician (${breakdown.proximity} min away)`);
  }

  if (breakdown.availability === 20) {
    reasons.push(`${tech.name} has full availability for this time slot`);
  } else if (breakdown.availability === 0) {
    reasons.push(`${tech.name} is unavailable at this time`);
  }

  if (breakdown.workloadBalance >= 8) {
    reasons.push(`${tech.name} has fewer jobs assigned today than average`);
  }

  return reasons;
}
```

#### Confidence Calculation

```typescript
function calculateConfidence(topScore: Score, secondScore: Score): 'high' | 'medium' | 'low' {
  const gap = topScore.total - secondScore.total;

  if (gap >= 15) return 'high';  // Clear winner
  if (gap >= 5) return 'medium';  // Slight preference
  return 'low';                   // Too close to call
}
```

### 3.3 Learning from Completed Jobs

#### Feedback Loop

```typescript
// After job completion, record outcomes
async function recordJobOutcomes(jobId: string, completion: JobCompletion) {
  const job = await getServiceRequest(jobId);
  const prediction = await getPrediction(jobId);

  // Record actual vs predicted duration
  await db.jobDurationPredictions.update({
    where: { serviceRequestId: jobId },
    data: {
      actualMinutes: completion.actualDuration,
      errorMargin: (completion.actualDuration - prediction.predictedMinutes) / prediction.predictedMinutes
    }
  });

  // Record assignment quality (if tech reported issues)
  if (completion.skillsMismatch) {
    await updateSkillsModel(job.assignedTo, job, -1); // Penalize this skill match
  }

  // Record route efficiency
  if (completion.actualTravelTime) {
    await recordTravelEfficiency(job.assignedTo, job, completion.actualTravelTime);
  }
}
```

#### Weekly Model Updates

```typescript
// Cron: Weekly model retraining
async function weeklyModelUpdate() {
  const orgs = await getAllActiveOrganizations();

  for (const org of orgs) {
    // Update duration prediction model
    const newDurationModel = await trainDurationModel(org.id);

    // Update assignment weights based on recent accuracy
    const recentAccuracy = await getRecentAssignmentAccuracy(org.id, 30); // days
    if (recentAccuracy.skillsAccuracy < 0.8) {
      // Increase skills weight in scoring
      await updateAssignmentWeights(org.id, { skills: 45, proximity: 25, availability: 20, workloadBalance: 10 });
    }

    // Log model version
    await logModelUpdate(org.id, {
      durationModel: newDurationModel.version,
      assignmentWeights: await getAssignmentWeights(org.id),
      timestamp: new Date()
    });
  }
}
```

---

## 4. User Experience

### 4.1 Admin "Set It and Forget It" Mode

#### Auto-Pilot Configuration

```typescript
interface AutoPilotSettings {
  enabled: boolean;
  confidenceThreshold: 'high' | 'medium' | 'low'; // Minimum confidence for auto-assign
  maxJobsPerDay: number; // Prevent auto-assigning beyond capacity
  requireApprovalFor: {
    emergency: boolean; // Always require human review for emergencies
    warranty: boolean; // Require review for warranty work
    install: boolean; // Require review for installations
    highValue: number; // Require review for jobs over $X
  };
  quietHours: {
    enabled: boolean;
    start: string; // '17:00'
    end: string; // '08:00'
  };
}
```

#### Admin Notifications

**When Auto-Pilot Assigns:**
```typescript
// Push notification + in-app badge
{
  type: 'assignment_auto_assigned',
  message: 'Auto-assigned #REQ-123 to Mike (92% confidence)',
  requestId: 'REQ-123',
  technician: 'Mike',
  score: 92,
  undoAvailable: true // Can undo within 5 minutes
}
```

**When Manual Review Needed:**
```typescript
// Push notification + badge
{
  type: 'assignment_review_needed',
  message: '3 assignments pending review',
  pendingCount: 3,
  urgentCount: 1
}
```

#### Admin Dashboard: Assignments View

```
┌──────────────────────────────────────────────────────────────┐
│  Assignments                                  [Auto-Pilot: ON] │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Today's Summary                                             │
│  ┌────────────┬────────────┬────────────┬────────────┐      │
│  │ Auto-assgn │ Manual     │ Pending    │ Completed  │      │
│  │ 8 jobs     │ 2 jobs     │ 1 job      │ 12 jobs    │      │
│  └────────────┴────────────┴────────────┴────────────┘      │
│                                                               │
│  Recent Auto-Assignments (confidence threshold: high)         │
│  ┌────────────────────────────────────────────────────┐     │
│  │ ✅ #REQ-124 → Mike (92% confidence) • 2 min ago     │     │
│  │ ✅ #REQ-125 → Sarah (88% confidence) • 5 min ago    │     │
│  │ ✅ #REQ-126 → Emily (85% confidence) • 8 min ago    │     │
│  └────────────────────────────────────────────────────┘     │
│                                                               │
│  Pending Review (confidence below threshold)                 │
│  ┌────────────────────────────────────────────────────┐     │
│  │ ⚠️ #REQ-127 • No high-confidence recommendation     │     │
│  │    Mike: 68%, Sarah: 65%, James: 62%              │     │
│  │    [Review & Assign]                               │     │
│  └────────────────────────────────────────────────────┘     │
│                                                               │
│  [View All Pending] [Adjust Auto-Pilot Settings]             │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Technician Mobile Experience

#### Onboarding Flow

**First Launch:**
1. Welcome screen with company branding
2. Login (email/password)
3. Set home base location (map picker or manual address)
4. Enable location tracking (explain privacy)
5. Enable notifications (explain why: job updates, dispatch messages)
6. View skills (read-only, shows admin-entered certifications)
7. Ready to work screen

#### Daily Flow: "Perfect Day"

**Morning Start (7:30 AM):**
```
┌────────────────────────────────────────┐
│  Good morning, Mike!                   │
│                                        │
│  You have 5 jobs scheduled today      │
│  First job: #REQ-120 at 9:00 AM       │
│  Estimated finish: 5:00 PM            │
│                                        │
│  [View Today's Route] [I'm Not Available] │
└────────────────────────────────────────┘
```

**Today's Route Screen:**
```
┌────────────────────────────────────────┐
│  Today's Route - Tuesday, Jun 11     │
│                                        │
│  🏠 123 Your Home St                  │
│     Home Base                         │
│     Leave by: 8:45 AM                │
│  ↓ 12 minutes (8 miles)               │
│                                        │
│  🔧 #REQ-120                           │
│     9:00 - 10:30 AM (1.5 hr)         │
│     No Heat - Furnace                 │
│     456 Oak Lane, Johnson City        │
│     [Start Job] [Details]             │
│  ↓ 18 minutes (14 miles)              │
│                                        │
│  🔧 #REQ-122                           │
│     10:48 AM - 12:00 PM (1.2 hr)     │
│     Maintenance - AC                 │
│     789 Pine Ave, Johnson City        │
│                                        │
│  ... (3 more jobs)                    │
│                                        │
│  🏠 Home                               │
│     Estimated return: 5:00 PM         │
│                                        │
│  [Map View] [Refresh]                 │
└────────────────────────────────────────┘
```

**Job In Progress:**
```
┌────────────────────────────────────────┐
│  🔧 #REQ-120 - In Progress            │
│                                        │
│  No Heat - Furnace                     │
│  456 Oak Lane, Johnson City            │
│                                        │
│  ⏱️ Started 9:03 AM                   │
│  📍 ETA complete: 10:33 AM            │
│                                        │
│  Customer: John Smith                  │
│  📞 (423) 555-1234 [Call]             │
│                                        │
│  Equipment:                            │
│  • Furnace, installed 2012             │
│  • Last serviced: March 2023           │
│                                        │
│  Notes:                                │
│  • Gate code: #4521                   │
│  • Dog in backyard - friendly          │
│                                        │
│  [Update Status] [Complete Job]        │
│  [Navigate] [Customer History]         │
└────────────────────────────────────────┘
```

**Job Completion Flow:**
```
┌────────────────────────────────────────┐
│  ✅ Complete #REQ-120?                 │
│                                        │
│  Work Performed                        │
│  ┌──────────────────────────────────┐ │
│  │ [Text area for technician notes] │ │
│  └──────────────────────────────────┘ │
│                                        │
│  Parts Used                            │
│  [+ Add Part]                          │
│  ☑ Flame Sensor (replaced)            │
│  ☑ Filter (replaced)                  │
│                                        │
│  Photos                                │
│  [+ Add Photo]                         │
│  [Before] [After] [Equipment]         │
│                                        │
│  Customer Signature                    │
│  ┌──────────────────────────────────┐ │
│  │     [Signature canvas]           │ │
│  └──────────────────────────────────┘ │
│                                        │
│  Follow-up Needed?  [NO]  [YES ▼]    │
│  If yes, reason: [dropdown]           │
│                                        │
│  Actual Duration: 1 hr 27 min         │
│  (Recorded automatically)             │
│                                        │
│  [Cancel] [Submit Completion]          │
└────────────────────────────────────────┘
```

### 4.3 Manual Override Capabilities

#### Admin Override Options

**1. Override Assignment**
```
From Pending Assignment card:
[Reassign] → Shows all technicians with scores:
  Mike: 92 (recommended)
  Sarah: 85
  James: 78 (not certified for this system type)
  Emily: 72

Select any technician → Confirm → Assignment updated
```

**2. Adjust Schedule**
```
Drag and drop jobs between technician columns
- Updates assignment immediately
- Re-runs route optimization for affected technicians
- Shows "Route updated" notification
```

**3. Force Assignment (When No Good Match)**
```
[Assign Anyway] → Confirmation:
"This job has no eligible technicians based on skills.
Assigning anyway may result in poor service quality.

Assign to: [dropdown]
Reason: [dropdown] + [text field]
[Confirm Assignment] [Cancel]"
```

**4. Undo Auto-Assignment**
```
Within 5 minutes of auto-assignment:
[Undo] → Reverts assignment, returns to pending
Reason captured in assignment log
```

#### Technician Override Options

**1. Unavailable for Work**
```
Technician app:
[I'm Not Available Today] → Select reason:
  • Sick leave
  • Personal day
  • Vehicle breakdown
  • Other
[Submit] → Admin notified, jobs reassigned
```

**2. Request Different Assignment**
```
Technician app:
[Request Reassignment] → Message to admin:
"Please reassign #REQ-120. Reason: [text]"
Admin receives notification, can approve/deny
```

### 4.4 Real-Time Adjustments

#### Live Dispatch Updates

**When Technician Updates Status:**
1. Technician taps "On Site" in mobile app
2. Admin dispatch board updates in real-time (WebSocket)
3. Job card shows "🟢 On Site - 9:03 AM"
4. Next job's ETA recalculated

**When Job Runs Over:**
```
If 15 minutes past predicted duration:
• Admin dispatch board shows "⚠️ Running 15 min over"
• Next job's arrival time pushed back
• Technician can tap "Running late" to notify customers
• SMS sent to next customer: "Technician running 15 min late"
```

**When Emergency Job Comes In:**
```
1. New emergency request created
2. AI evaluates: Which technician can divert with least disruption?
3. Recommendation shown to admin
4. If accepted:
   - Affected jobs reordered
   - Customers notified of delays
   - Technician mobile app updated
```

---

## 5. Integration Points

### 5.1 Integration with Existing Calendar

#### Calendar Write Events

**When Job is Assigned:**
```typescript
// Create Google Calendar event
async function createJobEvent(job: ServiceRequest, technician: Technician) {
  const event = {
    summary: `#${job.referenceNumber} - ${job.issueType}`,
    description: `
Customer: ${job.customerName}
Address: ${job.address}
Phone: ${job.customerPhone}
Problem: ${job.description}
System: ${job.systemType} - ${job.equipmentBrand}
Urgency: ${job.urgency}
Access Notes: ${job.accessNotes || 'None'}
    `.trim(),
    location: job.address,
    start: {
      dateTime: job.arrivalWindowStart,
      timeZone: BUSINESS_TIMEZONE
    },
    end: {
      dateTime: job.arrivalWindowEnd,
      timeZone: BUSINESS_TIMEZONE
    },
    colorId: getColorIdForUrgency(job.urgency),
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 * 24 }, // 24 hours before
        { method: 'popup', minutes: 30 }
      ]
    }
  };

  await googleCalendar.events.insert({
    calendarId: technician.calendarId || 'primary',
    resource: event
  });

  // Store event ID for updates/deletions
  await db.serviceRequests.update({
    where: { id: job.id },
    data: { calendarEventId: event.id }
  });
}
```

**When Route is Optimized:**
```typescript
// Batch update calendar events
async function syncRouteToCalendar(technician: Technician, route: OptimizedRoute) {
  for (const stop of route.stops) {
    if (!stop.job) continue;

    const existingEvent = await getCalendarEvent(stop.job.calendarEventId);

    if (existingEvent) {
      // Update event time if changed
      if (existingEvent.start.dateTime !== stop.arrivalTime) {
        await googleCalendar.events.patch({
          calendarId: technician.calendarId || 'primary',
          eventId: stop.job.calendarEventId,
          resource: {
            start: { dateTime: stop.arrivalTime, timeZone: BUSINESS_TIMEZONE },
            end: { dateTime: stop.departureTime, timeZone: BUSINESS_TIMEZONE }
          }
        });
      }
    } else {
      // Create new event
      await createJobEvent(stop.job, technician);
    }
  }
}
```

### 5.2 Integration with After-Hours Queue (Stage A)

#### Priority Assignment for Next-Day Routing

```typescript
// At 7 AM daily, process overnight queue
async function processOvernightQueue(orgId: string) {
  const overnightRequests = await db.serviceRequests.findMany({
    where: {
      organizationId: orgId,
      status: 'pending',
      isAfterHours: true,
      createdAt: gte('yesterday 5 PM')
    },
    orderBy: { urgency: 'desc' }
  });

  for (const request of overnightRequests) {
    // Generate high-priority assignment
    const recommendation = await assignmentEngine.generateRecommendation(request);

    // Boost score for urgent overnight requests
    if (request.urgency === 'emergency') {
      recommendation.score *= 1.2;
    }

    // Store for dispatch review
    await storeAssignmentRecommendation(request.id, recommendation);

    // Auto-assign if configured
    const settings = await getOrganizationSettings(orgId);
    if (settings.autoAssignOvernight && recommendation.confidence === 'high') {
      await assignTechnician(request.id, recommendation.recommendedTechnician.id);
    }
  }
}
```

#### Customer Notification Integration

```typescript
// When overnight job is scheduled, notify customer
async function notifyOvernightCustomer(request: ServiceRequest, technician: Technician) {
  const message = `
Good morning! Your overnight HVAC request has been scheduled.

Technician: ${technician.name}
Arrival Window: ${formatArrivalWindow(request.arrivalWindowStart, request.arrivalWindowEnd)}
Address: ${request.address}

You'll receive a text when the technician is on the way.

Reply STOP to opt out of notifications.
  `.trim();

  await sendSMS(request.customerPhone, message);
}
```

### 5.3 Integration with Analytics (Stage D)

#### Metrics Pipeline

**Assignment Efficiency:**
```sql
-- Weekly assignment accuracy
SELECT
  DATE_TRUNC('week', created_at) as week,
  COUNT(*) as total_assignments,
  SUM(CASE WHEN admin_overridden = false THEN 1 ELSE 0 END) as auto_assigned,
  SUM(CASE WHEN admin_overridden = true THEN 1 ELSE 0 END) as overridden,
  AVG(CASE WHEN admin_overridden = false THEN 1 ELSE 0 END) as auto_assign_rate
FROM assignment_logs
WHERE organization_id = $1
  AND created_at >= NOW() - INTERVAL '90 days'
GROUP BY week
ORDER BY week DESC;
```

**Duration Prediction Accuracy:**
```sql
-- Monthly prediction error analysis
SELECT
  DATE_TRUNC('month', jdp.created_at) as month,
  AVG(ABS(jdp.error_margin)) as mean_absolute_error,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ABS(error_margin)) as median_error,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY ABS(error_margin)) as p95_error,
  COUNT(*) as sample_size
FROM job_duration_predictions jdp
JOIN service_requests sr ON jdp.service_request_id = sr.id
WHERE sr.organization_id = $1
  AND jdp.actual_minutes IS NOT NULL
  AND jdp.created_at >= NOW() - INTERVAL '365 days'
GROUP BY month
ORDER BY month DESC;
```

**Route Efficiency:**
```sql
-- Daily route optimization savings
SELECT
  date,
  technician_id,
  total_travel_minutes as optimized_travel,
  total_job_minutes,
  efficiency_score,
  -- Compare to unoptimized baseline (simple geographic assignment)
  (total_travel_minutes / total_job_minutes) as travel_to_work_ratio
FROM route_optimizations
WHERE organization_id = $1
  AND date >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY date DESC, technician_id;
```

**Technician Performance:**
```sql
-- Technician leaderboard (by jobs completed and accuracy)
WITH tech_stats AS (
  SELECT
    sr.assigned_to as technician_id,
    COUNT(*) as jobs_completed,
    AVG(jdp.actual_minutes / jdp.predicted_minutes) as duration_accuracy_ratio,
    AVG(sr.actual_duration_minutes) as avg_actual_duration,
    AVG(jdp.predicted_minutes) as avg_predicted_duration
  FROM service_requests sr
  JOIN job_duration_predictions jdp ON sr.id = jdp.service_request_id
  WHERE sr.organization_id = $1
    AND sr.status = 'completed'
    AND sr.completed_at >= CURRENT_DATE - INTERVAL '90 days'
  GROUP BY sr.assigned_to
)
SELECT
  u.name as technician,
  t.jobs_completed,
  ROUND(t.duration_accuracy_ratio::numeric, 2) as prediction_accuracy,
  ROUND(t.avg_actual_duration::numeric, 0) as avg_job_length,
  ROUND(t.avg_predicted_duration::numeric, 0) as avg_predicted_length
FROM tech_stats t
JOIN users u ON t.technician_id = u.id
ORDER BY t.jobs_completed DESC;
```

#### Real-Time Dashboard Metrics

```typescript
// Admin dashboard: "Dispatch Efficiency" card
async function getDispatchEfficiencyMetrics(orgId: string): Promise<DispatchMetrics> {
  const today = new Date();
  const todayStart = startOfDay(today);

  return {
    autoAssignRate: await getAutoAssignRate(orgId, todayStart),
    avgAssignmentConfidence: await getAvgConfidence(orgId, todayStart),
    avgPredictionError: await getAvgPredictionError(orgId, todayStart),
    totalTravelTime: await getTotalTravelTime(orgId, todayStart),
    optimizedSavings: await getOptimizedSavings(orgId, todayStart),
    pendingAssignments: await getPendingCount(orgId),
    technicianUtilization: await getUtilizationByTechnician(orgId, todayStart)
  };
}

interface DispatchMetrics {
  autoAssignRate: number; // 0-100, percentage of assignments auto-handled
  avgAssignmentConfidence: number; // 0-100, average confidence score
  avgPredictionError: number; // percentage, lower is better
  totalTravelTime: number; // minutes across all technicians
  optimizedSavings: number; // minutes saved vs. unoptimized routing
  pendingAssignments: number; // count of unassigned jobs
  technicianUtilization: Map<TechnicianId, number>; // 0-100, hours booked / hours available
}
```

---

## Implementation Phases

### Phase B.1: Foundation (Weeks 1-3)
- Database schema extensions (skills, locations, predictions, logs)
- Skills data model and admin UI for entering technician skills
- Location tracking API and background worker
- Basic assignment algorithm (rule-based, no learning)

### Phase B.2: Assignment & Routing (Weeks 4-6)
- Assignment recommendation engine
- Admin dispatch board redesign
- Route optimization algorithm
- Calendar integration for assigned jobs
- Auto-pilot mode with confidence thresholds

### Phase B.3: Technician Mobile App (Weeks 7-10)
- PWA setup and authentication
- Today's Route screen
- Job Detail screen
- Job Completion flow
- Location tracking integration
- Offline support

### Phase B.4: Learning & Analytics (Weeks 11-12)
- Duration prediction model training pipeline
- Weekly model updates
- Assignment analytics dashboard
- Route efficiency metrics
- Technician performance tracking

### Phase B.5: Integration & Polish (Weeks 13-14)
- After-hours queue integration
- Customer notification workflows
- Real-time dispatch updates
- Admin override refinements
- End-to-end testing

---

## Success Metrics

### Admin Time Savings
- **Target:** 70% reduction in time spent on scheduling
- **Measurement:** Time from request creation to assignment (auto vs. manual)
- **Baseline:** Average 15 minutes per job (manual scheduling)
- **Target:** Average 4.5 minutes per job (AI-assisted)

### Assignment Accuracy
- **Target:** 80%+ of auto-assignments accepted without override
- **Measurement:** Override rate in assignment_logs
- **Baseline:** N/A (no auto-assignment)

### Duration Prediction Accuracy
- **Target:** Within 20% of actual duration (median)
- **Target:** Within 40% of actual duration (95th percentile)
- **Measurement:** Error margin in job_duration_predictions

### Route Efficiency
- **Target:** 15% reduction in total travel time vs. unoptimized routing
- **Measurement:** total_travel_minutes in route_optimizations vs. baseline

### Technician Satisfaction
- **Target:** 80%+ of technicians rate the mobile app as "helpful" or "very helpful"
- **Measurement:** In-app NPS survey

---

## Open Questions & Decisions Required

1. **Mobile Platform:** PWA vs. Native?
   - PWA pros: Single codebase, no app store, faster development
   - PWA cons: Limited background location, push notification variability
   - Decision: Start with PWA, evaluate native if critical limitations emerge

2. **Map Provider:** Mapbox vs. Google Maps?
   - Mapbox: More affordable, better customization
   - Google Maps: Better traffic data, more familiar
   - Decision: Mapbox for cost, fall back to external apps for navigation

3. **ML Model Complexity:** When to upgrade from rule-based to ML?
   - Decision: After 100 completed jobs with good data quality

4. **Location Tracking Frequency:** Balance between accuracy and battery?
   - Decision: 2-minute intervals during work hours, 15-minute intervals otherwise

5. **Auto-Assignment Threshold:** What confidence level for auto-pilot?
   - Decision: Start with "high" only (85%+ score), adjust based on feedback

---

## Dependencies & Risks

### Dependencies
- **Stage A (After-Hours Queue):** Required for next-day priority routing
- **Stage D (Analytics):** Required for performance dashboards
- **Google Calendar API:** For calendar integration (optional fallback: manual entry)
- **Mapbox API:** For route optimization (fallback: straight-line distance)
- **Twilio:** For SMS notifications to customers

### Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Low adoption by technicians | High | Simplify mobile app, provide training, add incentives |
| Poor prediction accuracy early on | Medium | Start with rule-based baseline, improve with data |
| Location tracking privacy concerns | High | Transparent privacy policy, easy opt-out, data retention limits |
| Auto-assignment errors | High | Require admin approval for low-confidence assignments, easy override |
| Mobile app battery drain | Medium | Optimized location intervals, background geolocation best practices |

---

## Appendix: Data Dictionary

### technician_skills
| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| organization_id | UUID | FK to organizations |
| technician_id | UUID | FK to users (technicians only) |
| skill_type | TEXT | 'equipment', 'job_type', 'brand', 'physical' |
| skill_key | TEXT | Specific skill identifier |
| proficiency | JSONB | { level, certified, etc. } |
| certified_at | TIMESTAMP | When certification was obtained |
| expires_at | TIMESTAMP | When certification expires |

### technician_locations
| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| organization_id | UUID | FK to organizations |
| technician_id | UUID | FK to users (technicians only) |
| location_type | TEXT | 'home_base', 'current', 'job_site' |
| latitude | DECIMAL(10,8) | GPS latitude |
| longitude | DECIMAL(11,8) | GPS longitude |
| address | TEXT | Human-readable address |
| accuracy_meters | INTEGER | GPS accuracy |
| recorded_at | TIMESTAMP | When location was recorded |
| expires_at | TIMESTAMP | When to purge this location |

### job_duration_predictions
| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| organization_id | UUID | FK to organizations |
| service_request_id | UUID | FK to service_requests |
| predicted_minutes | INTEGER | Predicted job duration |
| actual_minutes | INTEGER | Actual duration (after completion) |
| error_margin | DECIMAL(5,2) | (actual - predicted) / predicted |
| model_version | TEXT | Model that made this prediction |
| features | JSONB | Input features for reproducibility |

### assignment_logs
| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| organization_id | UUID | FK to organizations |
| service_request_id | UUID | FK to service_requests |
| recommended_technician_id | UUID | FK to users (AI recommendation) |
| assigned_technician_id | UUID | FK to users (actual assignment) |
| recommendation_score | DECIMAL(5,2) | AI confidence score |
| recommendation_reason | TEXT | Human-readable explanation |
| admin_overridden | BOOLEAN | Did admin change the assignment? |
| override_reason | TEXT | Why admin changed it |

### route_optimizations
| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| organization_id | UUID | FK to organizations |
| technician_id | UUID | FK to users |
| date | DATE | Optimization date |
| route | JSONB | Array of route stops |
| total_travel_minutes | INTEGER | Total travel time |
| total_job_minutes | INTEGER | Total job time |
| efficiency_score | DECIMAL(5,2) | 0-100 efficiency rating |

---

**Document Version:** 1.0
**Last Updated:** 2025-06-11
**Author:** AI HVAC Agent Technical Team
**Status:** Draft for Review
