# Phase 3: Admin Dashboard + Manual Dispatch - Context

**Gathered:** 2026-05-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Build an authenticated admin dashboard where dispatchers can view incoming service requests, assign them to technicians, and manage technician records. Includes NextAuth authentication, protected routes, request queue with live updates, manual technician assignment, technician CRUD, and stats overview.

</domain>

<decisions>
## Implementation Decisions

### Dashboard Layout & Navigation
- Collapsible sidebar with "Requests" and "Technicians" tabs, collapses to icons on mobile
- /admin redirects to /admin/requests (request queue is primary workflow)
- Native HTML table styled with shadcn Table component (no TanStack Table)
- Request detail in slide-over Sheet panel (stays in context of list)

### Admin Auth & Security
- NextAuth v5 (Auth.js) with Credentials provider for email/password login
- Login page: centered card with email + password, project branding, subtle blue gradient background
- JWT strategy with 24-hour expiry (no refresh rotation for MVP)
- Route protection via Next.js middleware — redirect to /admin/login if no session

### Request Management UX
- Assignment: click request row -> sheet opens -> "Assign Technician" dropdown -> select -> confirm
- Live updates: polling every 10 seconds on the request list
- Urgency badges: emergency=red, high=orange, medium=blue, low=gray
- Stats cards: Pending Requests, Assigned Today, In Progress, Completed Today (counts only)

### Claude's Discretion
- Exact sidebar width and collapse breakpoint
- Sheet panel width and responsive behavior
- Polling implementation details (SWR revalidation vs setInterval)
- Stats card layout and responsive grid

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- src/lib/db/schema.ts — serviceRequests, users, organizations tables
- src/lib/db/tenant.ts — withTenant helper for org-scoped queries
- src/lib/crypto.ts — decrypt for reading encrypted PII
- src/lib/api-response.ts — success/error envelope helpers
- src/lib/rate-limit.ts — rate limiter
- src/components/ui/ — shadcn components (button, card, dialog, table, badge, skeleton, sheet, input, etc.)
- src/lib/design-tokens.ts — color palette and animation constants

### Established Patterns
- Next.js 15 App Router with src/ directory
- API routes return { success, data?, error? } envelope
- All DB queries use withTenant for multi-tenancy
- PII fields stored encrypted, decrypt on read

### Integration Points
- Admin API routes at /api/admin/* (new)
- NextAuth at /api/auth/[...nextauth] (new)
- Middleware at src/middleware.ts (extend existing to protect /admin/*)
- Existing session/chat APIs are customer-facing, admin APIs are separate

</code_context>

<specifics>
## Specific Ideas

- Use shadcn Sheet component for request detail slide-over
- Urgency badge colors should match the extraction schema urgency enum values
- Technician form should include: name, email, phone, specialties (multi-select from issueType values), active toggle
- Admin sees decrypted PII (name, phone, email, address) in request detail view

</specifics>

<deferred>
## Deferred Ideas

- Auto-dispatch with weighted scoring — v2
- Analytics dashboard with charts (Recharts) — v2
- Dark mode toggle — v2
- Technician location tracking and map view — v2
- Email/SMS notifications to technicians on assignment — v2

</deferred>
