# Implementation Roadmap: Stage B & Stage C
## Communication Automation + Smart Scheduling System

**Date:** 2025-06-11
**Status:** Approved for Implementation
**Estimated Timeline:** 8 months (33 weeks)

---

## Executive Summary

This roadmap synthesizes two major technical specifications into a cohesive implementation plan:

1. **Stage C: Communication Automation (Ghost CSR)** - Automated confirmations, reminders, rescheduling, and review requests
2. **Stage B: Smart Scheduling & Dispatch** - AI-powered technician assignment, route optimization, and mobile technician experience

**Key Decision:** Implement Stage C first, then Stage B.

**Rationale:**
- Stage C provides immediate customer-facing value (automated confirmations work with existing manual scheduling)
- Lower technical complexity (templates/job queue vs. ML algorithms/mobile app)
- Stage B benefits from having Stage C's communication infrastructure in place
- Early value delivery while building toward complete system

---

## Implementation Phases

### Phase 1: Communication Foundation (Weeks 1-4)

**Goal:** Core infrastructure for automated messaging

**Database Migrations:**
- `communication_jobs` table
- `communication_templates` table
- `communication_preferences` table
- Enums: `communication_job_type`, `communication_channel`, `communication_priority`, `job_status`

**Backend Components:**
- Template engine (Handlebars for SMS, React Email for HTML)
- In-memory job queue (using `after()` hooks + Vercel cron)
- Basic job scheduler and executor
- Template renderer with context builder

**Channel Integration:**
- Twilio SMS adapter
- SMS webhook handler (delivery status, inbound replies)
- Basic response parser

**Admin UI:**
- Template list and editor
- Template preview functionality
- Communication jobs list

**Deliverables:**
- ✅ Appointment confirmations sent via SMS when service request is scheduled
- ✅ Admin can create/edit templates
- ✅ Delivery tracking visible in admin
- ✅ Webhook processing working

**Acceptance Criteria:**
- Service request scheduled → SMS confirmation sent within 2 minutes
- Admin can edit SMS templates and see live preview
- Delivery status (sent/delivered/failed) tracked in database
- Webhook receives and processes Twilio status updates

---

### Phase 2: Communication Core Features (Weeks 5-8)

**Goal:** Complete confirmation and reminder flows

**Database Extensions:**
- `conversation_states` table (for rescheduling conversations)
- `message_deliverability` table

**Backend Components:**
- 24-hour reminder cron job
- 2-hour reminder cron job
- Rescheduling conversation state machine
- Slot availability finder for rescheduling

**Channel Integration:**
- Resend email adapter
- Email webhook handler

**Templates:**
- 24h reminder SMS/email
- 2h reminder SMS/email
- Rescheduling options SMS
- Reschedule confirmation

**Admin UI:**
- Conversation history viewer
- Rescheduling analytics
- Reminder settings

**Deliverables:**
- ✅ 24-hour reminder sent automatically
- ✅ 2-hour reminder sent automatically
- ✅ SMS-based rescheduling flow working
- ✅ Email confirmations and reminders

**Acceptance Criteria:**
- Customer receives 24h reminder before appointment
- Customer receives 2h reminder before appointment
- Customer can reply "RESCHEDULE" to trigger rescheduling flow
- Customer receives email confirmation if email is preferred channel
- Rescheduling offers 3 available slots within 7 days

---

### Phase 3: Escalation & Quality (Weeks 9-12)

**Goal:** Human escalation system and message quality monitoring

**Database Migrations:**
- `escalation_tasks` table
- Escalation enums: `escalation_reason`, `escalation_status`

**Backend Components:**
- Escalation creation logic
- Escalation assignment algorithm
- Message quality validator
- TCPA compliance checker
- CAN-SPAM compliance checker

**Admin UI:**
- Escalation queue (pending, assigned, resolved)
- Escalation detail view with customer context
- Claim/resolve interface
- Communication quality dashboard

**Compliance Features:**
- TCPA opt-out handling (STOP replies)
- CAN-SPAM unsubscribe mechanism
- Hours restriction (9PM-8AM local time)
- Consent verification

**Deliverables:**
- ✅ Escalations created for problematic cases
- ✅ Admin can claim and resolve escalations
- ✅ TCPA/CAN-SPAM compliance enforced
- ✅ Quality metrics tracked

**Acceptance Criteria:**
- Failed rescheduling → escalation created
- Customer replies "HELP" → escalation created
- 3+ delivery failures → escalation created
- STOP reply → opt-out recorded, no further SMS
- Unsubscribe link → opt-out recorded, no further email
- Messages outside 9PM-8AM blocked unless emergency
- Quality check catches template errors before sending

---

### Phase 4: Review Automation (Weeks 13-15)

**Goal:** Automated review request collection

**Database Extensions:**
- Add `reviewRequestSentAt` to `service_requests`

**Backend Components:**
- Review request trigger (36 hours after completion)
- Review reminder trigger (7 days later)
- Review link generation (Google, Facebook, Yelp)
- Review tracking

**Templates:**
- Review request SMS/email
- Review reminder

**Admin UI:**
- Review platform settings
- Review request history
- Response rate metrics

**Deliverables:**
- ✅ Review requests sent 36 hours after job completion
- ✅ Reminder sent after 7 days if no response
- ✅ Direct links to review platforms
- ✅ Review tracking visible in admin

**Acceptance Criteria:**
- Completed job → review request sent 36 hours later
- Non-response → reminder sent 7 days after first request
- Links go directly to Google/Facebook/Yelp review pages
- Admin can see which platform customer reviewed on

---

### Phase 5: Scheduling Foundation (Weeks 16-18)

**Goal:** Technician skills and location tracking data model

**Database Migrations:**
- `technician_skills` table
- `technician_locations` table
- Extensions to `users` (home_base_location_lat/lon, nate_certified, epa_608_cert_type, location_tracking_enabled)

**Admin UI:**
- Technician profile page with skills section
- Skills entry form (equipment expertise, job capabilities, certifications)
- Brand specialization entry
- Physical capabilities entry
- Skills validation and warnings

**Backend Components:**
- Skills validation logic
- Location tracking API
- Privacy controls (opt-in/opt-out)

**Deliverables:**
- ✅ Admin can enter technician skills
- ✅ Skills validated for completeness
- ✅ Technicians can set home base location
- ✅ Location tracking with privacy controls

**Acceptance Criteria:**
- Technician profile shows equipment expertise (apprentice/journeyman/master)
- Technician profile shows job type eligibility
- Certifications tracked with expiry dates
- Admin alerted when certifications expiring
- Technician can enable/disable location tracking
- Location data purged after 24 hours

---

### Phase 6: Assignment Engine (Weeks 19-23)

**Goal:** AI-powered technician assignment

**Database Migrations:**
- `assignment_logs` table
- Extensions to `service_requests` (assignment_score, assignment_confidence, predicted_duration_minutes)

**Backend Components:**
- Multi-factor scoring algorithm (40% skills, 30% proximity, 20% availability, 10% workload)
- Skills matching logic
- Proximity calculation (distance from current location)
- Availability checker
- Workload balancer
- Recommendation generator

**Admin UI:**
- Dispatch board redesign
- Pending assignments section with AI recommendations
- Technician columns with current routes
- Auto-pilot toggle
- Assignment confidence indicators

**Integration:**
- Assignment → triggers Stage C confirmation
- Assignment → creates calendar event

**Deliverables:**
- ✅ AI recommends technician for each new job
- ✅ Confidence score displayed (high/medium/low)
- ✅ Auto-assign when confidence = high and auto-pilot enabled
- ✅ Assignment triggers confirmation to customer
- ✅ Calendar event created

**Acceptance Criteria:**
- New service request → recommendation generated within 30 seconds
- Recommendation shows top technician + 2 alternatives with scores
- Confidence gap >15 = high, 5-15 = medium, <5 = low
- Auto-pilot + high confidence → assignment made automatically
- Assignment → SMS confirmation sent to customer
- Assignment → calendar event created for technician

---

### Phase 7: Route Optimization (Weeks 24-27)

**Goal:** Daily route optimization for technicians

**Database Migrations:**
- `route_optimizations` table
- Extensions to `service_requests` (route_position, travel_time_from_previous, travel_time_to_next)

**Backend Components:**
- Nearest neighbor route optimization algorithm
- Daily route calculation (6 AM cron)
- Real-time re-optimization triggers
- ETA calculation engine
- Travel time estimation

**Admin UI:**
- Optimized route view for each technician
- Route metrics (total travel time, total job time, efficiency score)
- Manual re-optimization button
- Route comparison (before/after)

**Integration:**
- Route optimization → updates calendar events
- Job completed → re-optimizes remaining jobs

**Deliverables:**
- ✅ Daily routes optimized at 6 AM
- ✅ Routes updated when jobs assigned/completed
- ✅ Calendar events show optimized times
- ✅ Travel time estimates accurate

**Acceptance Criteria:**
- 6 AM cron → optimized routes for all technicians
- Job assigned → technician's route recalculated
- Job completed → remaining jobs re-optimized
- Calendar events show arrival/departure times from optimization
- Travel time estimates within 20% of actual

---

### Phase 8: Technician Mobile App (Weeks 28-33)

**Goal:** PWA for technician job management

**Platform:** Progressive Web App (single codebase, iOS/Android)

**Backend Components:**
- Technician authentication API
- Today's route API
- Job details API
- Job completion API
- Location update API
- Offline sync API

**Frontend Components:**
- Login screen (email/password, biometric)
- Today's Route home screen
- Job Detail screen
- Job Completion modal
- Profile screen
- Offline support (IndexedDB, Service Worker)

**Features:**
- Today's route with map view
- Job list in sequence
- One-tap status updates (On my way, On site, Working, Complete)
- Job completion form (work performed, parts used, photos)
- Customer signature capture
- Offline mode

**Integration:**
- Location updates → proximity calculations
- Job completion → route re-optimization
- Status updates → customer notifications

**Deliverables:**
- ✅ Technician can view today's optimized route
- ✅ Technician can update job status
- ✅ Technician can complete jobs with notes/photos/signature
- ✅ Location tracking works (with consent)
- ✅ Offline mode functional

**Acceptance Criteria:**
- Technician logs in → sees today's route
- Technician taps "On my way" → customer notified
- Technician arrives → taps "On site"
- Technician completes job → form captures work, parts, photos, signature
- Location updates every 2 minutes while on shift
- App works offline, syncs when connection restored

---

## Dependencies & Integration Points

### Cross-Stage Dependencies

| Stage C Component | Stage B Component | Integration |
|------------------|------------------|-------------|
| Appointment confirmation | Service request scheduled | Confirmation sent when status = scheduled |
| 24h/2h reminders | Calendar/arrival windows | Reminder calculated from arrivalWindowStart |
| Rescheduling | Availability/assignment | Reschedule uses available slots |
| Confirmation | Assignment (auto-assign) | Assignment triggers confirmation |

### External Dependencies

**Stage C:**
- Twilio (SMS)
- Resend (Email)
- Vercel Cron (scheduled jobs)

**Stage B:**
- Mapbox (routing, distances)
- Google Calendar (technician calendars)

### Shared Infrastructure

**Database:**
- Multi-tenant (organization_id)
- Encrypted PII (customer data)
- Audit logging

**Backend:**
- Next.js API Routes
- Drizzle ORM
- Neon Serverless Postgres

**Frontend:**
- React 18
- Admin dashboard framework
- Tailwind CSS

---

## Risk Assessment

### High-Risk Items

1. **SMS Deliverability (Stage C)**
   - Risk: Twilio delivery failures, carrier filtering
   - Mitigation: Delivery tracking, fallback to email, escalation on 3+ failures

2. **TCPA Compliance (Stage C)**
   - Risk: Regulatory violations, fines
   - Mitigation: Strict compliance layer, consent verification, hours enforcement

3. **Assignment Accuracy (Stage B)**
   - Risk: Poor recommendations, admin overrides
   - Mitigation: Confidence thresholds, auto-pilot only on high confidence, learning from feedback

4. **Route Optimization Accuracy (Stage B)**
   - Risk: Inefficient routes, technician frustration
   - Mitigation: Start with simple algorithm, allow manual override, learn from actual travel times

5. **Mobile App Adoption (Stage B)**
   - Risk: Technicians won't use it
   - Mitigation: Simplify UI, provide training, ensure offline support works

### Medium-Risk Items

1. **Template Complexity (Stage C)**
   - Risk: Templates become unmaintainable
   - Mitigation: Version control, approval workflow, preview functionality

2. **Job Queue Reliability (Stage C)**
   - Risk: Jobs lost or delayed
   - Mitigation: Start with in-memory, monitor closely, migrate to Redis when needed

3. **Location Privacy Concerns (Stage B)**
   - Risk: Technician pushback on tracking
   - Mitigation: Transparent privacy policy, easy opt-out, data retention limits

### Low-Risk Items

1. **Email Deliverability (Stage C)**
   - Resend has good deliverability
   - CAN-SPAM compliance straightforward

2. **Calendar Integration (Stage B)**
   - Google Calendar API well-documented
   - Fallback to manual entry if API fails

---

## Success Criteria

### Stage C Success Metrics

- 95%+ SMS delivery rate
- 90%+ Email delivery rate
- <5 minutes from scheduling to confirmation sent
- 30%+ reduction in no-shows
- 20%+ increase in review collection rate
- <10% escalation rate for automated conversations

### Stage B Success Metrics

- 80%+ of auto-assignments accepted without override
- Job duration prediction within 20% of actual (median)
- Job duration prediction within 40% of actual (95th percentile)
- 15%+ reduction in total travel time
- 70%+ reduction in admin scheduling time
- 80%+ of technicians rate mobile app as helpful

### Technical Metrics

- <500ms average job execution time
- 99.9% webhook processing success rate
- <5 second processing time for cron jobs
- Zero data loss (all communications persisted)
- 100% audit trail coverage

---

## Testing Strategy

### Unit Tests
- Template rendering (all template types)
- Job queue (schedule, execute, retry)
- Response parsing (all intent types)
- Assignment scoring (all factors)
- Route optimization (sample data)

### Integration Tests
- Twilio SMS send/receive
- Resend email send/webhook
- Vercel cron execution
- Assignment → Confirmation trigger
- Route → Calendar integration

### E2E Tests
- New service request → confirmation sent
- Customer replies RESCHEDULE → options presented → selection → confirmation
- 24h reminder → sent at correct time
- Assignment → confirmation → calendar event
- Route optimization → technician calendar updated
- Mobile app → view route → update status → complete job

### Load Tests
- Job queue throughput (1000 jobs/hour)
- Webhook processing capacity
- Route optimization calculation time

---

## Timeline Summary

| Phase | Duration | Weeks | Deliverable |
|-------|----------|-------|-------------|
| 1 | 4 weeks | 1-4 | Communication Foundation |
| 2 | 4 weeks | 5-8 | Communication Core Features |
| 3 | 4 weeks | 9-12 | Escalation & Quality |
| 4 | 3 weeks | 13-15 | Review Automation |
| 5 | 3 weeks | 16-18 | Scheduling Foundation |
| 6 | 5 weeks | 19-23 | Assignment Engine |
| 7 | 4 weeks | 24-27 | Route Optimization |
| 8 | 6 weeks | 28-33 | Technician Mobile App |

**Total: 33 weeks (8 months)**

---

## Parallel Work Opportunities

- Phases 5 and 6 can overlap (Scheduling Foundation + Assignment Engine)
- Phase 3 templates can be prepared during Phase 2
- Mobile app can be prototyped during Phase 7

---

## Next Steps

1. **Immediate (Week 1):** Begin Phase 1 database migrations
2. **Week 1:** Set up Twilio account and test SMS
3. **Week 2:** Implement template engine and job queue
4. **Week 3:** Build admin UI for templates
5. **Week 4:** End-to-end test confirmation flow

---

## Appendix: Resource Requirements

### Development Team
- 1 Full-stack developer (primary)
- 1 Frontend specialist (Phases 6-8 for mobile app)
- 1 Backend specialist (optional, for complex algorithms)

### External Services
- Twilio SMS (~$50/month for testing)
- Resend Email (~$20/month for testing)
- Mapbox API (~$50/month for routing)
- Google Calendar API (free tier sufficient)

### Infrastructure
- Vercel Pro account (for cron jobs)
- Neon Serverless Postgres (scale as needed)
- Future: Redis for job queue (when volume increases)

---

**Document Status:** ✅ Approved
**Last Updated:** 2025-06-11
**Version:** 1.0
