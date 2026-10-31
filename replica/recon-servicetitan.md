# ServiceTitan clean-room recon map

Researched 2026-10-31 from public sources only: marketing site, help.servicetitan.com, the public OpenAPI pages at developer.servicetitan.io/api/docs/apis/*, the App Store, Trustpilot, and third-party pricing and review aggregators. I did not log in, scrape, or read any JS bundles.

This extends `SERVICETITAN-PLAN.md`, the 10-stage roadmap. That plan already covers call booking, AI voice agent and transfer, summaries, texting inbox, the customer/location split, Scheduling Pro abandoned-booking recovery, tech mobile, pricebook, estimates/invoices/financing, memberships, reporting and job costing. It defers Dispatch Pro. This report adds evidence for what those surfaces look like, the field-level data model, and the complaint list.

Legend: **[E]** means evidenced at the cited URL. **[I-h] / [I-m] / [I-l]** mean inference with high, medium or low confidence.

Fetch limitations, stated plainly:
- developer.servicetitan.io's human portal (`/apis/`, `/docs/...`) is a JS shell. The raw spec pages at `/api/docs/apis/tenant-<domain>-v2` are readable, but they are 150-640 KB and truncate past 100 KB per read. Field lists therefore come from example payloads, not full `components/schemas`.
- Capterra, G2 and Software Advice returned 403. Their quotes below came through search-engine snippets and are labelled that way.
- No Reddit thread surfaced through search. The Reddit quotes are second-hand via an aggregator and labelled that way.

---

## 1. Sources

| # | URL | What it gave |
|---|---|---|
| 1 | https://www.servicetitan.com/pricing | Three tiers (Starter, Essentials, The Works), what each gates, "Request Pricing" with no $; Pro product list in nav |
| 2 | https://tooleduppro.com/guides/servicetitan-pricing/ (also projul.com, forz.io, trustpro.io) | Third-party price bands per tech per month; implementation fee $5k-$50k+; 12-month contract claims |
| 3 | https://www.servicetitan.com/features/dispatch-software | Dispatch Board marketing: drag-drop, ACP, Map 2.0, multi-day, Notification Center, Project filter, property data display |
| 4 | https://help.servicetitan.com/docs/use-the-new-daily-and-weekly-dispatch-board | **Best UI source.** Appointment card color legend, Jobs Tray tabs, filters, Holding Area, Edit Arrival Window popup, right-click menu, Dispatch Pro shift-extension hatch, Activity Center |
| 5 | https://help.servicetitan.com/docs/use-the-daily-dispatch-board ; https://help.servicetitan.com/v1/docs/use-the-jobs-tray-on-the-weekly-dispatch-board | Unassigned tab is default; weekly board uses a Select Technician dropdown (no drag); Working/Dispatched/Done can't be unassigned |
| 6 | https://help.servicetitan.com/docs/book-jobs-and-schedule-appointments | Call Booking flow, Bookings tab, Follow Up tabs (Sold estimates, Recurring events, Leads), required-field config, arrival-window setup, call reasons |
| 7 | https://help.servicetitan.com/v1/docs/book-a-job | Call bubble → auto-open Customer Record, "Manual job", unlink mismatched caller, close call with call reason, convert lead, Duplicate Job |
| 8 | https://help.servicetitan.com/docs/customer-and-location-records-overview | Full Customer and Location Record section lists, header fields, actions, merge tools, preferred tech |
| 9 | https://help.servicetitan.com/v1/docs/job-record-overview | Job record sections, Job Actions menu, appointment statuses and actions, Media, History tabs |
| 10 | https://help.servicetitan.com/docs/manage-estimates-in-servicetitan | Estimate export/import as XLSX template, email multiple estimates, duplicate, pinned notes, visibility permission |
| 11 | https://help.servicetitan.com/docs/estimate-workflows-in-servicetitan-and-servicetitan-mobile | Present → Sign/Accept → "Yes I have the items" vs "work done later"; Follow Up › Sold/Unsold Estimates; Initiate Booking; Sold/Convert |
| 12 | https://help.servicetitan.com/docs/field-mobile-app-cheat-sheet | FMA bottom nav, job tabs, Dispatch → Arrive → Close Out options (Pause / Hold / Schedule another / Mark myself done), card readers |
| 13 | https://help.servicetitan.com/docs/complete-the-work-in-the-field-3 ; https://help.servicetitan.com/how-to/dispatch-and-arrive-at-a-job-in-the-servicetitan-field-mobile-app | Office must check tech in before dispatch; skipping "Working" loses job-costing and drive-time data; required forms block completion |
| 14 | https://help.servicetitan.com/docs/the-new-customer-portal-end-user-experience | Portal tabs (My Tasks, Invoices, Proposals, Jobs, Equipment, Service Agreements, Memberships), pay links, partial pay, ACH auth |
| 15 | https://help.servicetitan.com/docs/memberships-concepts ; …/create-membership-types ; …/manage-recurring-services ; …/membership-faq | Membership type as template, sale task, recurring service types, events generated about 12 months out, Follow Up › Book Events (bulk), Expiring Memberships |
| 16 | https://help.servicetitan.com/how-to/set-up-adjustable-capacity-planning ; …/docs/adjustable-capacity-planning-acp-faq | ACP formula: shift hours + base capacity − threshold − job durations, per BU per slot; Manually Adjust Capacity permission |
| 17 | https://help.servicetitan.com/docs/use-sms-opt-in-with-scheduling-pro ; …/set-up-scheduling-pro-webhooks ; …/scheduling-pro-funnel-report-template | Scheduling Pro abandoned session → Calls › Bookings or lead; "Qualified Abandoned Session" webhook; Funnel report |
| 18 | https://help.servicetitan.com/docs/atlas | Titan Intelligence and Atlas features with gates (Core / Field Pro / Max / private preview) |
| 19 | https://www.servicetitan.com/features/pro/pricebook | Pricebook Pro: content updates, Smart Start, Regional Pricing Averages, auto G/B/B proposals, Smart Recommendations |
| 20 | https://www.servicetitan.com/features/pro/dispatch ; https://www.servicetitan.com/blog/webinar-recap-dispatch-pro | Dispatch Pro: ML assignment on projected revenue per job and per tech, Job Value Predictor, overrides for recall/warranty/tags |
| 21 | https://www.servicetitan.com/features/pro/contact-center | Contact Center Pro, AI Virtual Agent (labelled "early access"), job-value routing thresholds |
| 22 | https://www.servicetitan.com/features/pro/marketing/email ; …/marketing/ai-powered-agents ; https://www.pointofactionmarketing.com/is-servicetitan-marketing-pro-worth-it/ | Marketing Pro audiences (unsold estimates, aging equipment, expiring memberships), automated unsold-estimate SMS, AI outbound agents |
| 23 | https://help.servicetitan.com/docs/batch-post-and-export-transactions ; …/quickbooks-online-1 ; …/not-seeing-an-invoice-exported-to-quickbooks-online ; …/set-up-touchless-integration-for-quickbooks-online | Batch → Post (Pending→Posted) → Export to QBO; invoices before payments; batches of 3-4; returns don't export; locked batches |
| 24 | https://help.servicetitan.com/docs/measure-performance-and-make-decisions ; …/technician-dashboard-revenue-report ; …/v1/docs/map-business-units-to-technician-scorecards | Modular dashboard (KPI, chart, table and report modules), report builder (template → columns → filters → Run), Technician Scorecards by BU |
| 25 | https://developer.servicetitan.io/api/docs/apis/tenant-jpm-v2 | Job, Appointment, Project, cancel/hold reasons, job history, budget codes, daily logs; status enums |
| 26 | https://developer.servicetitan.io/api/docs/apis/tenant-crm-v2 | Customer, Location, Contact, ContactMethod and preferences, Booking, BookingProviderTag, Lead, Note |
| 27 | https://developer.servicetitan.io/api/docs/apis/tenant-dispatch-v2 | AppointmentAssignment, TechnicianShift, NonJobAppointment, ArrivalWindow, Capacity req/resp, Team, BusinessHours, GPS ping |
| 28 | https://developer.servicetitan.io/api/docs/apis/tenant-accounting-v2 | AP bills/credits/payments, credit memos, journal entries, payments, payment terms and types, tax zones, remittance vendors |
| 29 | https://developer.servicetitan.io/api/docs/apis/tenant-pricebook-v2 | Category, DiscountAndFee, Equipment (very rich), ClientSpecificPricing (rate sheets) |
| 30 | https://developer.servicetitan.io/api/docs/apis/tenant-memberships-v2 | CustomerMembership, MembershipType, RecurringService, RecurringServiceEvent, RecurringServiceType, InvoiceTemplate; status enums |
| 31 | https://developer.servicetitan.io/api/docs/apis/tenant-salestech-v2 | Estimates (sell/unsell/dismiss), estimate items, estimate and proposal templates, contracts with e-sign enums |
| 32 | https://developer.servicetitan.io/api/docs/apis/tenant-settings-v2 | BusinessUnit, Employee, Technician, TagType, UserRole |
| 33 | https://developer.servicetitan.io/api/docs/apis/tenant-inventory-v2 | PurchaseOrder (+approval requests), Receipt, Transfer, Adjustment; PO status enum |
| 34 | https://developer.servicetitan.io/api/docs/apis/tenant-payroll-v2 | GrossPayItem, PayrollAdjustment, job Timesheet, TimesheetCode, JobSplit, LaborType, ActivityCode; PayrollStatus |
| 35 | https://developer.servicetitan.io/api/docs/apis/tenant-equipment-systems-v2 | InstalledEquipment with warranties, predicted replacement, parent System |
| 36 | https://developer.servicetitan.io/api/docs/apis/tenant-marketing-v2 | Campaign, CampaignCategory (Regular/GoogleHomeServices), CampaignCost (daily cost per month), SMS opt-in import |
| 37 | https://github.com/api-evangelist/servicetitan | Index of 23 API domains and base paths (telecom v3, jbce, schedulingpro, taskmanagement, customerinteractions, webhooks v1) |
| 38 | https://www.fieldproxy.ai/guides/servicetitan-api (third-party) | OAuth2 client-credentials, 15-min tokens, 600 calls per 10 s per app per tenant |
| 39 | https://apps.apple.com/us/app/servicetitan-mobile/id1037989976?see-all=reviews | Legacy ServiceTitan Mobile 2.9★ (1.7K ratings); verbatim reviews |
| 40 | https://www.trustpilot.com/review/servicetitan.com | 4.0★ / 423 reviews; verbatim 2026 negative reviews |
| 41 | https://play.google.com/store/apps/details?id=com.servicetitan.work | "ServiceTitan Field" Android listing. Rating 3.2-3.4 seen in search snippets; the page body did not render |
| 42 | https://checkthat.ai/brands/servicetitan/reviews | Aggregated (second-hand) Reddit, Trustpilot and BBB complaint quotes |
| 43 | https://www.quiverquant.com/news/ServiceTitan+Expands+AI-Powered+Max+to+All+Residential+Contractors,+Launches+Atlas+Mobile+App+and+Homh+at+Pantheon+2026 | Pantheon 2026: "Max" package for all residential, Atlas mobile app, Homh demand-gen |

---

## 2. Positioning and packaging

**Positioning:** "Per-technician" pricing, "designed to fit your business and goals, at any size" [E #1]. In practice it is aimed at growth-oriented shops of 10+ techs; a BVP memo notes historic difficulty selling to under 10 techs [E via search, https://www.bvp.com/memos/servicetitan]. In 2026 ServiceTitan brands itself an "Agentic Operating System" with a "Max" AI package [E #43].

### Core tiers [E #1]
| Capability | Starter | Essentials | The Works |
|---|---|---|---|
| Dispatching, Scheduling, Call Booking, Invoicing, Pricebook | ✓ | ✓ | ✓ |
| Mobile Estimates | ✗ | ✓ | ✓ |
| Payroll Management | ✗ | ✓ | Configurable Payroll |
| Advanced Reporting (custom dashboards gated by package [E #24]) | ✗ | ✗ | ✓ |
| Commission Tracking | ✗ | ✗ | ✓ |
| Customizable Memberships | ✗ | ✗ | ✓ |
| **Third-party price estimate (not from ServiceTitan)** | ~$245-300/tech/mo | ~$300-400 | ~$400-500+ |

Third-party estimate sources: #2. TrustRadius gives a wider $125-$398 range. Implementation is $5k-$50k+, and a 12-month minimum is commonly cited. Treat all of these as directional, since many come from competitor blogs.

### Pro add-ons (nav list [E #1]; capabilities from cited pages)
| Pro product | What it does | Evidence |
|---|---|---|
| **Dispatch Pro** | ML auto-assignment driven by projected revenue per job and per tech (Job Value Predictor). Overrides for recall, warranty or tagged jobs. Board shows a hatched "max shift extension" area where it may still assign. Toggle per appointment, "resume" per tech | #20, #4 |
| **Scheduling Pro** | Online scheduler (WorkConnect), SMS opt-in, abandoned-session follow-up SMS, webhooks, Funnel report, Adaptive Capacity (strategic rules, editable via Atlas) | #17, #6, #18 |
| **Contact Center Pro** | Call bar, inbox, abandoned-call view, call-center dashboard, AI Virtual Agent for overflow and after-hours, job-value routing thresholds (AI vs CSR). Booked jobs land on the dispatch board | #6, #21 |
| **AI Virtual Agent** | Separate nav item. Books, confirms, escalates. "Early access" on the vendor page | #1, #21 |
| **Marketing Pro** | Email, direct mail, ads attribution, segmentation on live ST data (unsold estimates, aging equipment, expiring memberships), automated unsold-estimate SMS, review requests and listings (third-party claim), AI outbound agents | #22 |
| **Pricebook Pro** | Managed content updates (cost, images, descriptions, sold hours), Smart Start (a few hundred common services), Regional Pricing Averages, one-click G/B/B templates, Smart Recommendations | #19 |
| **Field Pro** (formerly Sales Pro) | Atlas in Field Pro: equipment docs, troubleshooting, calculators, diagnostics, parts lookup; Sales Coach from tech recording transcripts (preview) | #1, #18 |
| **Fleet Pro** | Vehicle service records logged from FMA (release-hub title only). GPS and telematics hardware [I-m] | search result: help.servicetitan.com/release-hub/docs/log-vehicle-service-records-from-servicetitan-field-mobile-app |
| **Phones Pro** | **Not evidenced** in any source I reached. The current nav lists Contact Center Pro, not Phones Pro [E #1]. It may be a renamed or legacy SKU [I-l] | — |

### Titan Intelligence (TI) and Atlas [E #18]
| Feature | Gate |
|---|---|
| Atlas in mobile (tech Q&A about jobs and customers) | Core |
| Atlas in support (help chatbot) | Core |
| Atlas in Field Pro (equipment docs, diagnostics, parts) | Field Pro |
| Atlas in Adaptive Capacity strategic rules (plain-language capacity rules) | Scheduling Pro [I-m] |
| Atlas personas and access controls | Private preview |
| Atlas in Accounting (invoice anomaly review), in Marketing Pro, in Contact Center Pro, Field Pro Sales Coach | Private preview |
| Atlas mobile app for owners (KPIs) | ServiceTitan Max |
| Pricebook Pro "one-click bulk actions powered by TI"; Dispatch Pro job-value prediction | Pro add-ons [E #19, #20] |

---

## 3. Screen inventory

| ID | Screen | Route / nav path | Purpose | Key components | States seen |
|---|---|---|---|---|---|
| S01 | Dashboard (Modular) | Top nav › Dashboard [I-h] | Owner and manager KPIs | KPI modules, charts, tables, report modules, Technician Scorecards module, date and BU filters | Custom dashboards gated by package [E #24] |
| S02 | Calls screen / Call Booking | Calls › (incoming call bubble) [E #6, #7] | CSR intake | Call bubbles (live/grey ended), customer search (name/phone/address), "Add New Customer", "Manual job", Customer Record auto-pop, Overview section with job fields, "Book Job", call-reason close dialog, lead capture, unlink-caller banner | Ringing, answered, ended (greyed), unlinked, booked (auto-clears) [E #7] |
| S03 | Bookings tab | Calls › Bookings [E #6] | Review web, Google, Thumbtack and Scheduling Pro bookings before accepting | Booking list, job-type re-classify (defaults "Unknown"), accept/dismiss with dismissing reason | Pending, accepted (→ jobId), dismissed [E #26 Booking.status, dismissingReasonId] |
| S04 | Job Booking form (shared) | Opened from Call Booking, Location Record "Book job", Follow Up "Initiate Booking", Duplicate Job [E #6, #7, #11] | Create job and first appointment | Location picker, Job Type (filters BU), Business Unit, Campaign, Priority (Low/Normal/High/Urgent [E #25]), Summary, Tags, custom fields, Arrival Window dropdown (filtered by BU), attach equipment (setting-gated), customer PO, required-field enforcement | Field-level required config at Settings › Operations › Job Booking [E #6] |
| S05 | Dispatch Board, Daily | Dispatch [E #4] | Assign and move appointments | Tech rows grouped by Team, zone dot per tech, timeline (today opens at "now"), shift caret markers, Dispatch Pro hatched extension, appointment "bubbles" color-coded by status with red outline for alerts and a multi-tech icon, header status counts (Idle/Dispatched/Working/Meal) as filters, BU/Team/Skill filters, tech search, Today/date picker/arrows, Refresh, Mass Reschedule, horizontal/vertical layout toggle, Classic vs Modern palette | Card colors: light blue scheduled, dark blue confirmed, purple dispatched, green working, yellow paused, light grey done or held, dark grey non-job [E #4] |
| S06 | Dispatch Board, Weekly | Dispatch › Week tab [E #4, #5] | Multi-day planning | Week grid; assign via Select Technician dropdown in Unassigned tab (no drag) | — |
| S07 | Jobs Tray | Docked or pop-out window on the Dispatch Board [E #4] | Queue views | Tabs: Unassigned (default), Alerts, Assigned, Scheduled, Unconfirmed, Confirmed, Dispatched, Working, Paused, Done, Hold, Canceled, Future; Holding Area (visual drag bubbles); configurable columns | Zero-unassigned = full coverage [E #5] |
| S08 | Job Details flyout | Click a bubble on the board [E #4] | Quick view and actions | Hover popup, flyout, More Actions / right-click: assign, confirm, dispatch, cancel, reschedule, record access, Schedule Assistant, Dispatch Pro toggle, map | Reassign blocked when Working/Dispatched/Done [E #4] |
| S09 | Edit Arrival Window popup | Shown when dragging a bubble to a new time [E #4] | Keep customer promise consistent | 3 radio options: keep window / match window to new time / choose existing window | — |
| S10 | Tech row menu | Click a tech name [E #4] | Per-tech ops | Route (Google Maps), optimization, memos, personal time, timesheets, call, text, resume Dispatch Pro; hover shows team, zones, phone, skills | — |
| S11 | Map (Map 2.0) | Dispatch › Map (separate nav item) [E #3, #4] | Geographic dispatch | Validated-address job pins, tech routes | Unvalidated addresses hidden [E #4] |
| S12 | Activity Center / Notification Center | Board header [E #3, #4] | Alerts and messaging | Unread/All tabs, filters, mass text techs, 2-click call tech | — |
| S13 | Adjustable Capacity Planning (ACP) board | Dispatch/Settings › Capacity [E #16] | Bookable hours per BU per slot | BU rows × time slots or arrival windows, base capacity ±, threshold, manual adjust (permission-gated) | Over/under capacity; `isExceedingIdealBookingPercentage` [E #27] |
| S14 | Customer Record | Search › customer [E #8] | Bill-to party | Header: name, ID, Residential/Commercial, billing address, membership status, "Customer since" year. Summary: Lifetime Revenue, Avg Job Total, Balance Due, Credit Available. Right Details panel: tags, contacts, additional info, notes. Left sections: Notes, Locations, Memberships, Invoices, Payments, Payment Methods, Statement Log, Jobs, Appointments, Projects, Tasks, Leads, Calls, Marketing Activity (Email/SMS), Opportunities & Estimates, Forms, Photos/Videos/Attachments. Actions: add payment method, sell membership, add location; More: estimate, collect payment, project, statements | Sections vary with setup; Audit Trail [E #8] |
| S15 | Location Record | Customer › Locations, or search [E #8] | Service site | Header: name, customer link, service address, Zone. Sections: Notes, Jobs, Appointments, Projects, Opportunities & Estimates, **Equipment (only here)**, Leads, Calls, Memberships, Recurring Services, Recurring Service Events (when present), Forms, Media. Actions: Book job, attachment, add equipment; More: edit (preferred tech), add recurring service, estimate, project, sell membership, statement | — |
| S16 | Equipment detail / history | Location › Equipment [E search: track-and-manage-installed-equipment] | Asset tracking | Fields per #35 (serial, barcode, warranties, predicted replacement), Equipment History of completed service jobs, replace vs delete | Replace keeps history; delete erases it |
| S17 | Job Record | Search › job, or links [E #9] | Job hub | Header: Job Actions dropdown (Complete, Hold All/Remove Hold, Cancel/Remove, Recall, Warranty, Lead, Add Estimate, Log Task, Purchase Order, Take Survey, Timesheets, Create project), copy-link icon, Edit (tags, BU, skills, priority). Sections: Service Location / Bill To / Summary, Estimate (View Opportunity), Findings (optional), Timesheets, Appointments, Media, History (All/Events/Calls/Notes/Files/Email) | Appt statuses: Scheduled, Dispatched, Working, Done, Hold, Canceled, Unused [E #9]. Job: Scheduled, Dispatched, InProgress, Hold, Completed, Canceled [E #25] |
| S18 | Invoice (job invoice) | Job › Invoice [I-h]; auto-created at booking [E search: invoice-your-customers] | Bill the job | Line items (pricebook SKUs), summary, signature, payments, email with delivery status (Sent/Opened/Dropped/Bounced) | Pending → Posted → Exported [E #23] |
| S19 | Estimate page | Job › Estimate / Search [E #10] | Build quote | Costing tab, Actions (Export/Import XLSX template), Email (multi-estimate send), Duplicate, Notes (pinned, internal), Sold by | Contract statuses Draft/Sent/Accepted/Dismissed/Expired/Failed [E #31] |
| S20 | Follow Up hub | Top nav › Follow Up [E #6, #11, #15] | Work queues | Tabs: Sold Estimates, Unsold Estimates/Opportunities, Recurring Service Events, Expiring Memberships, Leads. "Initiate Booking", "Log a follow-up" (templates, next date), "Book Events" (bulk) | Opportunity follow-up status NotAttempted/Unreachable/Contacted/Won/Dismissed [E #30] |
| S21 | Opportunity Follow Up panel | Follow Up › Unsold › estimate [E #11] | Close unsold work | Call, log, attachments, edit estimate, "Sold/Convert" with salesperson credit | — |
| S22 | Projects dashboard | Location › More › Create Project [E #6] | Multi-job work | Actions: Book new job, Attach existing job; estimates section; daily logs and budget codes [E #25] | Project status and sub-status [E #25] |
| S23 | Pricebook | Top nav › Pricebook [I-h] | SKU catalog | Category tree (Services/Materials), Services, Materials, Equipment (member/add-on prices, warranties, vendors, recommendations, upgrades), Discounts & Fees, client-specific rate sheets | Screen layout not evidenced; data shape only [#29] |
| S24 | Memberships admin | Settings › Memberships [I-h] | Configure plans | Membership type (duration/billing table, discounts, recurring service types with offsets, sale task, auto-renew), recurring service types, invoice templates | Membership status Active/Suspended/Expired/Canceled/Deleted [E #30] |
| S25 | Marketing (Campaigns) | Marketing › Campaigns [I-h] | Attribution | Campaign list with category, source/medium, tracking phone numbers (DNIS), monthly daily-cost entry | Screen layout not evidenced [#36] |
| S26 | Marketing Pro campaign builder | Marketing Pro [E #22] | Email/SMS/mailer automation | Audience builder on live data, templates | Screen not evidenced in detail |
| S27 | Reports / Report builder | Reports [E #24] | Custom reports | Template pick → columns → filters (date, BU, job type, tech) → Run | — |
| S28 | Technician Scorecards | Dashboard module [E #24] | Tech KPIs | Per-tech rows by BU division, CSAT 0-5 | Based on invoice-item BU, not tech BU |
| S29 | Accounting › Batch/Export | Accounting › Batch/Export Transactions [E #23] | Close the books | Batch list, post, export to QBO, unpost/repost | Pending/Posted/Exported; locked batch |
| S30 | Inventory (POs, receipts, transfers) | Inventory [I-h] | Stock and purchasing | PO list with approval requests, receive, transfers warehouse ↔ truck, adjustments | PO Pending/Sent/PartiallyReceived/Received/Exported/Canceled [E #33] |
| S31 | Payroll / Timesheets | Payroll [I-h] | Pay techs | Gross pay items, adjustments, job splits, timesheet codes, payroll periods | PayrollStatus Pending/Expired/Approved/Paid/Locked [E #34] |
| S32 | Settings | Settings › Operations / Employees / Tools [E #6, #8, #10] | Configuration | Job Booking fields, Arrival Windows, Call Reasons, Business Units, Job Types, Tag Types (color, importance, show on dispatch board), Zones, Teams, Skills, Business Hours, Employees/Technicians with Permissions tab, Merge Customers/Locations | — |
| S33 | Customer Portal | Public portal URL [E #14] | Self-service | My Tasks, Invoices (Pay Total Balance, partial, ACH auth, Bill To switch), Proposals (compare options, PDF, sign, deposit), Jobs (In Progress/On Hold/Upcoming/Completed/Canceled; "Call to Schedule"), Equipment (search, filters, next service, history), Service Agreements, Memberships | Tabs admin-hideable |
| S34 | Pay-link page | Emailed link [E #14] | Single-invoice pay | No login, no saved methods | — |
| S35 | Scheduling Pro widget | Embedded on contractor site [E #17] | Online booking | Steps not evidenced at screen level; captures contact first, then abandonment handling | Abandoned / qualified-abandoned / booked |
| S36 | FMA Home | Field Mobile App › Home [E #12] | Tech's day | Today's jobs; View all → Upcoming / Previous / Paused | — |
| S37 | FMA Job (tabs) | Home › job [E #12] | Do the work | Tabs: Job (status, window, techs, special instructions, pinned notes, tags, media, call recordings), Location Info, Equipment, Forms, Estimates, Invoice/Work Order; floating **Add** (photo/video/file, payment, equipment, items) | Scheduled, Dispatched, Working, Paused, On Hold |
| S38 | FMA Close Out | Job › Close Out [E #12, #13] | End visit | Pause / Hold (reason) / Schedule another appointment / Mark myself done → "Close out job instead" | Blocked by required forms or other techs not done |
| S39 | FMA Estimate presenter | Job › Estimates › Present [E #11] | In-home sale | Template picker, options, Sign/Accept, "Yes I have the items" vs "work later" | Signature immutable once invoiced |
| S40 | FMA Invoice and Payment | Job › Invoice [E #12] | Collect | Items, signature, Add Payment (after Arrive), card reader (Adyen/BBPOS/ID TECH), email invoice | — |
| S41 | FMA Time | Bottom nav › Time [E #12] | Timekeeping | Clock in/out, activity status bar (Continuous Timekeeping) | — |
| S42 | FMA Menu | Bottom nav › Menu [E #12] | Utilities | Scorecard, Book a Job, Financing History, Card Reader Mgmt, Opportunities, Content Portal, My Forms, settings (Residential/Commercial terms, Location Tracking, Update Pricebook, environment Go/Next) | — |
| S43 | FMA Book Job | Menu › Book Job [E #6] | Tech-generated lead or job | Customer search/add, + on location, job details | Can leave unassigned for dispatcher (release hub) |
| S44 | Atlas chat (web + mobile) | Atlas panel [E #18] | AI assistant | Chat, NL report/schedule/dispatch commands (Pantheon 2025 claim) | Gated per §2 |

**Screens I could not evidence at layout level:** Pricebook editor UI, Marketing Pro builder, Inventory screens, Payroll screens, report-builder canvas, Scheduling Pro widget steps, Projects board visuals. Their data shapes come from the API; their layouts are inferred.

---

## 4. User flows

| ID | Goal | Screen sequence | Edge cases (evidenced unless marked) | Happy-path clicks (est.) |
|---|---|---|---|---|
| F01 | Inbound call → booked job | S02 click call bubble → Customer Record auto-pops (S14) → choose location → check for existing lead (convert) → Overview: Job Type → BU (filtered) → Campaign (auto-filled from the call's tracking number) → Priority / Summary / Tags → Arrival Window (BU-filtered) → Book Job → call clears | Unknown caller → Add New Customer. Number mismatch → unlink. Not booking → X, call reason, optional lead. Web bookings arrive as "Unknown" job type. Window crossing midnight needs a custom window. Tags must go on the location: "Customer-level tags silently fail to fire" [E #6, #7] | ~10-14 clicks plus typing [I-m] |
| F02 | Dispatch assignment | S05 → Jobs Tray Unassigned (S07) → drag bubble onto tech row at time (or Holding Area / click-to-drop) → Edit Arrival Window popup if time moved (S09) → right-click Confirm / Dispatch | Weekly board: dropdown assign, no drag. Multi-tech icon. Red-outline alert for running late. Dispatch Pro may auto-assign inside the hatched extension | 2-4 per job |
| F03 | Re-assignment | Drag bubble to another tech, or flyout → Unassign (back to Unassigned) → reassign; Mass Reschedule from header | **Blocked when appt is Working, Dispatched or Done** [E #4, #5]. Refresh to see other dispatchers' moves (no live push) [I-m] | 2-3 |
| F04 | Tech field workflow | Office checks tech in → FMA Home (S36) → job → **Dispatch** (en route; customer notified [I-m]) → **Arrive** (confirm popup) → **Working** → add items, photos, forms, equipment, estimates → present invoice → signature → Add Payment → Close Out (S38): Pause / Hold / Schedule another / Mark myself done → Close out job | Must be checked in before dispatching. Skipping Working loses job costing and drive-time data. Required forms block completion. All techs and appts must be Done. Payments and equipment need Arrive first [E #12, #13] | ~15-25 taps [I-m] |
| F05 | Estimate → sold → job | FMA Estimates › Add from template (multiple options) → Present → customer picks an option → Sign/Accept → (a) "Yes I have the items" → sold items go onto the current invoice; or (b) "work later" → office Follow Up › Sold Estimates → select all or some items → Initiate Booking → S04 → Book | Signature can't be removed once invoiced (recreate the estimate). Partial-item booking splits work. Can add to a project. Deposit on signature (`requireDepositOnSignature` [E #31]) | 6-10 taps (tech) + 5-8 clicks (office) |
| F06 | Membership sale → recurring visits | Customer/Location › Sell Membership → pick membership type (duration/billing option) → payment method → the type's sale task goes on the invoice → recurring services attach to the location (start, recurrence, preferred tech) → events generate up to about 12 months ahead → Follow Up › Recurring Service Events → filter → **Book Events** (bulk) → jobs | Events beyond 12 months hurt performance. Auto-renew, otherwise Follow Up › Expiring Memberships (manual renew with adjusted start). Preferred tech conflicts with ACP. Statuses Active/Suspended/Expired/Canceled [E #15, #30, #8] | ~8 clicks to sell; bulk book 3-4 |
| F07 | Invoice → payment → QuickBooks | Job complete → invoice (auto-created at booking) → payment in FMA or portal or pay link → Accounting › Batch → Post (Pending→Posted) → Export to QBO (invoices first, then payments) | Batches of 3-4 to avoid QBO throttling. $0 payments don't transfer. Returns and inventory adjustments are manual. Invoices with no tasks don't export. Locked batches need support. Touchless mode doesn't mark Exported (close periods instead) [E #23] | ~6-8 clicks per batch |
| F08 | Unsold-estimate follow-up | Follow Up › Unsold Estimates → Opportunity panel → call / log follow-up (template, next date) → edit → Sold/Convert. Marketing Pro: an audience of "unsold estimates" gets automated SMS or email; AI agents do outbound SMS and voice | Opportunity statuses NotAttempted → Unreachable → Contacted → Won/Dismissed. Estimate visibility permission may hide others' estimates [E #10, #11, #22, #30] | 3-5 per follow-up; 0 when automated |
| F09 | Online booking (Scheduling Pro) | Widget → customer details → slot from Adaptive Capacity → booking lands in Calls › Bookings (or as a lead) → CSR accepts | Abandoned with contact → auto SMS with scheduler URL; Qualified Abandoned Session webhook. Job types need a default duration, otherwise overbooking [E #6, #17] | — |
| F10 | Tech-generated lead | FMA Menu › Book a Job, or Job Actions › Lead → office Follow Up › Leads → Book Job | Can leave booked jobs unassigned for the dispatcher (release hub) | 4-6 |

---

## 5. Components

| Component | Variants / states | Used in |
|---|---|---|
| Appointment bubble (job card) | 7 status colors (scheduled, confirmed, dispatched, working, paused, done/hold, non-job), red alert outline, multi-tech icon, configurable fields (job type, project, customer, ZIP, street, city, tags), Classic/Modern palette | S05, S06, S07 Holding Area |
| Status pill | Job: Scheduled/Dispatched/InProgress/Hold/Completed/Canceled. Appt: Scheduled/Dispatched/Working/Hold/Done/Canceled/Unused. Estimate/contract: Draft/Sent/Accepted/Dismissed/Expired. Membership: Active/Suspended/Expired/Canceled. PO, Payroll, Batch states | Everywhere |
| Header status-count chips (filterable) | Idle / Dispatched / Working / Meal | S05 |
| Jobs Tray (tabbed queue table) | 13 tabs, column chooser, pop-out window | S05-S07 |
| Tech row | Team group header, zone dot, shift carets, Dispatch Pro hatch, activity line (Flexible Timekeeping), hover card | S05 |
| Edit Arrival Window modal | 3-option radio | S05 drag |
| Right-click / More Actions menu | Assign, confirm, dispatch, cancel, reschedule, Schedule Assistant, Dispatch Pro toggle, map | S05, S08 |
| Call bubble | Ringing / active / ended-grey / linked / unlinked | S02 |
| Global customer search | By name, phone, address; results by customer vs location | S02, S14, FMA |
| Record shell (left section nav + right Details panel + header KPIs) | Customer vs Location variants | S14, S15 |
| KPI stat tiles | Lifetime Revenue, Avg Job Total, Balance Due, Credit Available | S14, S01 |
| History timeline with filter tabs | All / Events / Calls / Notes / Files / Email; audit trail | S17, S14 |
| Notes with pin-to-top | Pinned, add to locations | Customer, Location, Job, Estimate |
| Tag chips | Color, code, importance, "visible on dispatch board", "conversion opportunity" [E #32] | Job, customer, location, equipment, membership |
| Media grid | Hover download/trash, multi-select, lightbox with arrows, rename | S14, S15, S17 |
| Capacity cell | Total vs open hours, exceeding-ideal flag, tech list with has-required-skills [E #27] | S13, booking, Scheduling Pro |
| Follow-up queue row + "Log a follow-up" drawer | Template, next date, copy to notes | S20, S21 |
| Estimate option card / presenter | Multiple options, recommended flag (`isRecommended`), sign pad, deposit | S19, S39, S33 |
| Signature pad | Finger (mobile) or desktop | S39, S40, S33 |
| Close-out action sheet | 4 options | S38 |
| Bottom nav (mobile) | Home / Time / Projects / Menu, customizable | FMA |
| Floating "Add" sheet | Photo, video, file, payment, equipment, items | S37 |
| Batch table | Pending/Posted/Exported, locked | S29 |
| Atlas chat panel | Text/voice, persona-gated | S44 |

---

## 6. Inferred data model (from the public v2 API; field lists come from examples, so there may be more fields)

All IDs are int64 and tenant-scoped under `/{domain}/v2/tenant/{tenant}/…`. Nearly every entity carries `active, createdOn, createdById, modifiedOn, customFields[{typeId,name,value}], externalData[{key,value}]`, and most domains expose `/export/<entity>` continuation-token feeds for incremental sync [E #25-#36].

| Domain | Entity | Key fields | Relationships | Evidence / conf. |
|---|---|---|---|---|
| CRM | **Customer** | name, type (Residential/Commercial [E #8]), address{street,unit,city,state,zip,country,lat,lng}, balance, taxExempt, tagTypeIds, doNotMail, **doNotService**, nationalAccount, mergedToId, paymentTermId, creditLimit, creditLimitBalance | 1→N Location, Contact, Note, Membership, Invoice | #26 high |
| CRM | **Location** | name, address, customerId, taxZoneId, **zoneId**, taxExempt, tagTypeIds, mergedToId, contacts | N→1 Customer; 1→N Job, InstalledEquipment, RecurringService | #26 high |
| CRM | Contact / ContactMethod | type, value, memo, phoneSettings{phoneNumber, **doNotText**}, preferences{jobRemindersEnabled, marketingUpdatesEnabled, invoiceNotification, statementNotification, invoiceStatementNotification} | On customer and location; `/contacts/{id}/contact-methods/{id}/preferences/{name}` | #26 high |
| CRM | **Booking** | source, name, address, customerType, start, campaignId, businessUnitId, jobTypeId, priority, isFirstTimeClient, uploadedImages, status, dismissingReasonId, jobId, externalId, bookingProviderId, summary | Per booking provider (integration); → Job | #26 high |
| CRM | BookingProviderTag | tagName, description, type | Booking | #26 |
| CRM | **Lead** | status, priority, customerId, locationId, BU, jobTypeId, campaignId, followUpDate, tagTypeIds, dismissingReasonId, summary, callReasonId, callId, bookingId, lead* contact fields, captureSource | → Call, Booking, Job | #26 high |
| CRM | Note | text, isPinned; create: pinToTop, addToLocations | Customer/Location/Job | #26 |
| JPM | **Job** | jobNumber, projectId, customerId, locationId, jobStatus, completedOn, businessUnitId, jobTypeId, priority, campaignId, appointmentCount, first/lastAppointmentId, **recallForId, warrantyId**, jobGeneratedLeadSource{jobId,employeeId}, noCharge, notificationsEnabled, tagTypeIds, leadCallId, bookingId, soldById, customerPo, invoiceId, membershipId, total, createdFromEstimateId, estimateIds, equipmentIds, **isAutoDispatched**, summary | 1 Job : 1 Invoice; 1→N Appointment; N→1 Project | #25 high |
| JPM | **Appointment** | appointmentNumber, start, end, **arrivalWindowStart/End**, status, specialInstructions, isConfirmed, unused, appointmentSummaries[] | N→1 Job; N↔N Technician via AppointmentAssignment | #25 high |
| JPM | Project | number, name, status/statusId, subStatus, projectTypeId, projectManagerIds, businessUnitIds, startDate, targetCompletionDate, actualCompletionDate, contractStartDate, jobIds | 1→N Job, DailyLog, BudgetCode | #25 high |
| JPM | JobCancelReason / JobHoldReason / CanceledLog | name; log: jobId, reasonId, memo | Job, Appointment | #25 |
| JPM | JobHistory | employeeId, eventType, date, usedSchedulingTool, memo | Job (audit) | #25 |
| JPM | JobType | name, BU list, default duration, skills, priority [I-m: duration from #6, skills from capacity req] | Job, Capacity | inferred medium |
| Dispatch | **AppointmentAssignment** | technicianId, technicianName, assignedById, assignedOn, status, isPaused, jobId, appointmentId | Tech ↔ Appointment; assign/unassign endpoints | #27 high |
| Dispatch | **TechnicianShift** | shiftType (Normal/OnCall/TimeOff), title, note, technicianId, start, end, timesheetCodeId; create with repeatType/interval/shiftDays | Capacity input | #27 high |
| Dispatch | NonJobAppointment | technicianId, start, duration, name, timesheetCodeId, clearDispatchBoard, clearTechnicianView, removeTechnicianFromCapacityPlanning, allDay, showOnTechnicianSchedule, recurrence | Board grey events | #27 high |
| Dispatch | ArrivalWindow | start, duration, businessUnitIds, active (+ global configuration) | BU | #27 high |
| Dispatch | **Capacity** (computed) | req: startsOnOrAfter, endsOnOrBefore, businessUnitIds, jobTypeId, skillBasedAvailability. resp: availabilities[{start,end,businessUnitIds,totalAvailability,openAvailability,technicians[{id,name,status,hasRequiredSkills}],isAvailable,isExceedingIdealBookingPercentage}] | Shifts, jobs, ACP | #27 high |
| Dispatch | Team, BusinessHours, TechnicianSkill, Zone, GPS ping (unitId, lat/lng, speed, address, eventTime) | | | #27; Zone fields not visible |
| Accounting | **Invoice / InvoiceItem** | Not visible in my fetch window. Inferred: number, jobId, customerId, locationId, BU, items(skuId, qty, unitPrice, cost, membershipTypeId), subtotal, tax, total, balance, syncStatus (Pending/Posted/Exported), batch | Job 1:1 | inferred high (#23, #31 `invoiceItemId`) |
| Accounting | **Payment** | customerId, typeId, paidOn, total, unappliedAmount, splits[] (applied to invoices), authCode, checkNumber, status, transactionStatus, deposit, batch, refundedPaymentId, syncStatus | N↔N Invoice via splits | #28 high |
| Accounting | JournalEntry | number, source, status, syncStatus, postDate, exportedOn; lines: accountId, debit, credit, BU, customerId, jobId, projectId, sku… | GL export | #28 |
| Accounting | TaxZone | name, color, isTaxRateSeparated, isMultipleTaxZone, rates[{taxName, taxBaseType, taxRate, salesTaxItem}] | Location.taxZoneId | #28 high |
| Accounting | PaymentTerm / PaymentType / CreditMemo / ApBill / ApCredit / ApPayment / RemittanceVendor | PaymentTerm: dueDayType, dueDay, isCustomerDefault, discount and interest settings | Customer.paymentTermId | #28 |
| Pricebook | Category | name, parentId (tree), position, image, categoryType (Services/Materials), businessUnitIds | SKUs | #29 high |
| Pricebook | Service / Material | Not visible in my window. Inferred like Equipment: code, displayName, description, price, memberPrice, addOnPrice, addOnMemberPrice, hours, cost, taxable, categories, assets, recommendations, upgrades, serviceMaterials[], commission/bonus | | inferred high |
| Pricebook | **Equipment (SKU)** | code, displayName, price, **memberPrice, addOnPrice, addOnMemberPrice**, manufacturer, model, manufacturer/serviceProvider warranty{duration, description}, categories, assets[], **recommendations[{skuId,type}], upgrades**, equipmentMaterials[{skuId,qty}], primaryVendor/otherVendors{cost, vendorPart}, GL accounts, paysCommission, bonus, hours, cost, isInventory, isConfigurableEquipment, dimensions, isPriceLocked | | #29 high |
| Pricebook | DiscountAndFee | type, code, amountType, amount, limit, allowCustomAmount, taxable, paysCommission, excludeFromPayroll | Invoice lines | #29 |
| Pricebook | ClientSpecificPricing (rate sheet) | exceptions[{skuId, skuType, value, valueType (Percent…)}] | Customer [I-m] | #29 |
| Memberships | **MembershipType** | name, discountMode, locationTarget, revenueRecognitionMode, durationBilling[{duration, billingFrequency, salePrice, billingPrice, renewalPrice}], discounts[{targetId, discount}], recurringServices[{recurringServiceTypeId, offset, offsetType, allocation}], useMembershipPricingTable, showMembershipSavings, billingTemplateId | Template | #30 high |
| Memberships | **CustomerMembership** | customerId, locationId, membershipTypeId, from, to, duration, billingFrequency (OneTime/Monthly/EveryOtherMonth/Quarterly/BiAnnual/Annual), nextScheduledBillDate, status, followUpStatus, paymentMethodId, renewal*, cancellation* invoices, soldById | | #30 high |
| Memberships | RecurringServiceType / LocationRecurringService | recurrenceType, interval, months, daysOfWeek, week, dayOfNthWeek, daysOfMonth, durationType/Length, jobTypeId, BU, campaignId, priority, jobSummary, jobStartTime, invoiceTemplateId, **preferredTechnicianIds**, estimatedPayrollCost | Location, Membership | #30 high |
| Memberships | **RecurringServiceEvent** | locationRecurringServiceId, membershipId, status, date, jobId; mark-complete/incomplete | → Job when booked | #30 high |
| Memberships | InvoiceTemplate | items[{skuId, skuType, qty, unitPrice, isAddOn, cost, hours}] | Recurring billing / visits | #30 |
| Sales | **Estimate** | jobId, projectId, locationId, customerId, name, status{value,name}, reviewStatus, summary, soldOn, soldBy, items, subtotal, tax, BU, **isRecommended**, isChangeOrder, proposalTagName, **depositAmount/Percent, requireDepositOnSignature**; actions sell/unsell/dismiss; status-change log | Job (N estimates); options are sibling estimates grouped by proposal [I-m] | #31 high |
| Sales | EstimateItem | sku{id,name,type,soldHours}, description, membershipTypeId, qty, unitRate, total, unitCost, totalCost, itemGroupName/RootId, chargeable, invoiceItemId, membershipBillingFrequency | Estimate → InvoiceItem | #31 |
| Sales | EstimateTemplate / ProposalTemplate / ProposalType / Contract | Contract status Draft/Sent/Accepted/Dismissed/Expired/Failed; sub-status PendingESign/ESigned/ReadyForCountersign/AwaitingCustomerSignature/Declined | | #31 |
| Settings | **BusinessUnit** | name, officialName, email, phone, currency, invoiceHeader/Message, defaultTaxRate, authorization/acknowledgement paragraphs, address, quickbooksClass, trade{id,name}, division{id,name}, tagTypeIds | Everything is BU-scoped | #32 high |
| Settings | **Technician** | name, roleIds, businessUnitId, **mainZoneId, zoneIds**, team, skills[], dailyGoal, isManagedTech, burdenRate, commissionRate, hourlyRate, soldByRate, payrollProfileId, location{lat,lng,updatedOn}, shiftStart/End, status, allowMobileAccess, positions | | #32 high |
| Settings | Employee | role, roleIds, businessUnitAccessIds, hourlyRate, overtimeProfileId, permissions[] | | #32 |
| Settings | TagType | name, color, code, importance, isConversionOpportunity, allowToUseOnTimesheetActivity, **isVisibleOnDispatchBoard** | | #32 high |
| Settings | UserRole | name, employeeType, roleSource | | #32 |
| Marketing | Campaign | name, category{id,name}, source, medium, businessUnit, **campaignPhoneNumbers** (DNIS), isDefaultCampaign | Job.campaignId, Call | #36 high |
| Marketing | CampaignCategory / CampaignCost | type Regular/GoogleHomeServices; cost per year/month as dailyCost | ROI reporting | #36 high |
| Telecom | Call | Inferred: direction, from/to, duration, recordingUrl, callType (booked/not booked/…), reason (CallReason with isLead flag), agent, campaignId, customerId, leadId, jobId | Lead.callId, Job.leadCallId | #37 path only, #6; inferred medium |
| Forms | Form, FormSubmission | Inferred: form definition, required flag per job type, attachments, findings → estimate | Job | #37 path, #13; medium |
| Inventory | **PurchaseOrder** | number, status, typeId, vendorId, jobId, projectId, technicianId, shipTo, BU, inventoryLocationId, requiredOn, sentOn, receivedOn, total, tax, shipping, items[{skuId, qty, qtyReceived, cost, serialNumbers, chargeable}]; approval requests | | #33 high |
| Inventory | Receipt / Return / Transfer / Adjustment | Transfer: fromLocationId, toLocationId, status, pickedDate, receivedDate, items[qty, qtyPicked]. Receipt: landed costs | Truck and Warehouse are inventory locations [I-h] | #33 |
| Inventory | Truck, Warehouse, Vendor | Not visible in my fetch | | #33 paths only; medium |
| Payroll | GrossPayItem | employeeId, payrollId, date, activityCode, amount, grossPayItemType, paidDurationHours, paidTimeType, jobId, invoiceId, invoiceItemId, laborTypeId, isPrevailingWageJob | | #34 high |
| Payroll | Timesheet (job) | jobId, appointmentId, technicianId, **dispatchedOn, arrivedOn, canceledOn, doneOn** | Status timestamps = drive and work time | #34 high |
| Payroll | PayrollAdjustment, TimesheetCode (rateInfo, multiplier), JobSplit (technicianId, split %), LaborType, ActivityCode, Payroll (status Pending/Expired/Approved/Paid/Locked) | | | #34 |
| Equipment Systems | **InstalledEquipment** | equipmentId (SKU), locationId, customerId, systemId, invoiceItemId, name, serialNumber, barcodeId, manufacturer, model, cost, status ("Installed"…), installedOn, manufacturedOn, manufacturer/serviceProvider warranty start/end, **predictedReplacementMonths/Date**, actualReplacementDate, parent{id, type Equipment/System}, tags, attachments | Location; System groups units | #35 high |
| Service Agreements | ServiceAgreement | Commercial contract with visits, invoices, equipment; PDF [E #14] | Customer, Location | #37 path; medium |
| Task Management | Task | "Log Task" from Job Actions [E #9]; Customer › Tasks section | Job, Customer | #37 path; low on fields |
| JBCE / Scheduling Pro | Scheduler, session, capacity rules | | | #37 paths; low |
| Webhooks | v1 closed to new subscriptions | | | #37 |
| Platform | Auth | OAuth2 client credentials, 15-min token, 600 req/10 s per app per tenant | | #38 third-party; medium |

**Key modeling takeaways:**
- Customer ≠ Location. Equipment, zone, tax zone and recurring services hang off the location.
- Job ≠ Appointment. Status lives on both.
- Assignment is a join table with its own status.
- Membership pricing is per-SKU columns (memberPrice, addOnPrice), not computed.
- Recurring service events are materialized about 12 months ahead and converted to jobs in bulk.
- Status-change timestamps on the Timesheet power job costing.
- Opportunity follow-up status is a 5-state enum reused across estimates and memberships.

---

## 7. Feature matrix

Priority is from the perspective of a 10-tech residential HVAC shop. `original` = yes (core) / pro-addon / no.

```csv
feature,area,priority,original,notes
Customer record (bill-to) separate from location (service site),CRM,must,yes,"#8; equipment, zone, tax zone on location"
Residential/Commercial customer type,CRM,must,yes,#8
Multiple contacts per customer and location with per-method preferences,CRM,must,yes,"#26 jobReminders/marketing/invoice flags"
Do-not-text per phone,CRM,must,yes,#26 phoneSettings.doNotText
Do-not-service flag,CRM,must,yes,#26
Do-not-mail flag,CRM,should,yes,#26
Customer KPIs (lifetime revenue avg job balance credit),CRM,should,yes,#8
Customer since date (first completed job),CRM,could,yes,#8
Pinned notes on customer/location/job,CRM,must,yes,"#8 #26 pinToTop, addToLocations"
Customer and location tags,CRM,must,yes,"#26; location-level tags drive automations"
Merge customers / merge locations,CRM,should,yes,#8 Settings > Tools
Move location to another customer,CRM,could,yes,#8
Customer relocation workflow,CRM,could,yes,#8
Preferred technician per location,CRM,should,yes,#8 conflicts with ACP
Credit limit and payment terms per customer,CRM,could,yes,#26 #28
Customer statements (email/print/log),CRM,should,yes,#8
Saved payment methods on customer,CRM,should,yes,#8
Marketing activity log (email/SMS sent),CRM,should,yes,#8
Audit trail on records,CRM,must,yes,#8
Custom fields on customer/location/job/membership,Settings,should,yes,#26 #25 #30
National account flag,CRM,could,yes,#26 commercial
Global search by name phone address,CRM,must,yes,#6
Inbound call screen with call bubbles,Call booking,must,yes,#7
Caller ID auto-pop customer record,Call booking,must,yes,#7
Unlink mismatched caller from record,Call booking,should,yes,#7
Close call with call reason (lead / non-lead),Call booking,must,yes,#6 #7
Lead capture from non-booking call,Call booking,must,yes,#7 #26 Lead
Convert existing lead to job,Call booking,must,yes,#7
Manual job (no call),Call booking,must,yes,#7
Configurable required booking fields,Call booking,should,yes,#6 Settings > Operations > Job Booking
Job type filters business unit,Call booking,should,yes,#6
Campaign auto-attribution from tracking number,Call booking,should,yes,"#6 #36 campaignPhoneNumbers"
Attach existing equipment to job at booking,Call booking,should,yes,#7 setting-gated
Duplicate job,Call booking,could,yes,#7 needs support config
Bookings inbox for web/partner leads,Call booking,must,yes,#6 #26
Booking provider integrations (Google LSA Thumbtack Reserve with Google),Call booking,should,yes,#6 #36 GoogleHomeServices
Call scripts,Call booking,could,yes,help.servicetitan.com/docs/call-scripts.md (title only)
Abandoned/unbooked calls view,Call booking,should,yes,#6
Embedded dialer / outbound call,Telephony,should,yes,#6
Call recording on job,Telephony,should,yes,#12 call recordings on FMA job tab
Call center dashboard,Telephony,could,pro-addon,#6 Contact Center Pro
Contact Center Pro inbox and call bar,Telephony,could,pro-addon,#6
AI virtual agent overflow/after-hours booking,AI,must,pro-addon,"#21; our existing moat"
Job-value-based call routing (AI vs CSR),AI,could,pro-addon,#21
Booking confirmations to customer,Notifications,must,yes,#6
Text-to-confirm appointment feeding board,Notifications,should,yes,#3
Tech on-the-way notification with tracking,Notifications,should,yes,#3 dispatch notifications
Job record with Job Actions menu,Jobs,must,yes,#9
Job priority Low/Normal/High/Urgent,Jobs,must,yes,#25
Job summary,Jobs,must,yes,#6
Job tags,Jobs,must,yes,#25
Recall link to original job,Jobs,should,yes,#25 recallForId
Warranty link to original job,Jobs,should,yes,#25 warrantyId
No-charge job flag,Jobs,should,yes,#25
Job hold with reasons,Jobs,must,yes,#25
Job cancel with reasons and memo,Jobs,must,yes,#25
Remove cancellation,Jobs,should,yes,#25
Job history event log,Jobs,must,yes,#25 #9
History filter tabs (events calls notes files email),Jobs,should,yes,#9
Multiple appointments per job (multi-day),Jobs,must,yes,#6 #25
Appointment special instructions,Jobs,must,yes,#25
Appointment confirmation flag,Jobs,should,yes,#25 isConfirmed
Appointment AI summaries,Jobs,could,yes,#25 private preview
Job media gallery with download/rename,Jobs,must,yes,#9
Email delivery status tracking (sent/opened/bounced),Jobs,should,yes,invoice-your-customers
Customer PO on job,Jobs,could,yes,#25
Sold-by attribution,Jobs,must,yes,#10 #25
Job splits for commission,Payroll,should,yes,#34
Findings,Jobs,could,yes,#9 optional
Projects with multiple jobs,Projects,could,yes,#6 #25
Project status/sub-status,Projects,could,yes,#25
Daily logs and budget codes,Projects,could,yes,#25 commercial
Dispatch board daily timeline by tech,Dispatch,must,yes,#4
Weekly dispatch board,Dispatch,should,yes,#4
Status color legend on appointment cards,Dispatch,must,yes,#4
Configurable card fields,Dispatch,should,yes,#4
Unassigned jobs tray,Dispatch,must,yes,#4 #5
Jobs tray tabs by status,Dispatch,should,yes,#4 13 tabs
Holding area visual matching,Dispatch,could,yes,#4
Drag-drop assign/reassign,Dispatch,must,yes,#4
Edit arrival window prompt on move,Dispatch,must,yes,#4
Block reassign of working/dispatched/done,Dispatch,must,yes,#4 #5
Multi-tech appointments,Dispatch,should,yes,#4 #27
Late/alert outline on cards,Dispatch,should,yes,#4
Status counts filter (idle dispatched working meal),Dispatch,should,yes,#4
Filter by BU team skill,Dispatch,should,yes,#4
Teams grouping,Dispatch,should,yes,#27
Zones on techs and locations,Dispatch,should,yes,"#27 #32 #26"
Technician skills and skill-based availability,Dispatch,should,yes,#27
Technician shifts (normal on-call time-off) with repeat,Dispatch,must,yes,#27
Non-job events (meetings PTO) with capacity removal,Dispatch,must,yes,#27
Mass reschedule,Dispatch,could,yes,#4
Tech route view,Dispatch,should,yes,#4 Google Maps
Route optimization per tech,Dispatch,could,yes,#4
Dispatch map with validated addresses,Dispatch,should,yes,#4 Map 2.0
Activity/notification center with mass text to techs,Dispatch,should,yes,#3 #4
Office check-in of technicians,Dispatch,could,yes,#13
Live GPS pings from telematics,Dispatch,could,yes,#27 gps-provider
Schedule Assistant (suggest slot/tech),Dispatch,should,yes,#4 #3
ML auto-dispatch by predicted job value,Dispatch,could,pro-addon,#20 Dispatch Pro
Dispatch Pro shift extension window,Dispatch,could,pro-addon,#4
Auto-dispatched flag on job,Dispatch,could,pro-addon,#25 isAutoDispatched
Arrival windows per BU,Scheduling,must,yes,#6 #27
Custom one-off arrival window,Scheduling,should,yes,#6
Business hours,Scheduling,must,yes,#27
Capacity API (open vs total hours per slot),Scheduling,must,yes,#27
Adjustable capacity planning board,Scheduling,should,yes,#16
Base capacity and threshold buffers,Scheduling,should,yes,#16
Manual capacity override permission,Scheduling,could,yes,#16
Ideal booking percentage warning,Scheduling,should,yes,#27
Job type default duration,Scheduling,must,yes,#6
Online scheduler widget,Scheduling,must,pro-addon,#17 Scheduling Pro
Abandoned online session SMS recovery,Scheduling,should,pro-addon,#17
Scheduler webhooks,Scheduling,could,pro-addon,#17
Scheduling funnel report,Scheduling,should,pro-addon,#17
Adaptive capacity strategic rules (NL via Atlas),Scheduling,could,pro-addon,#18
Mobile app home: today/upcoming/previous/paused,Mobile,must,yes,#12
Dispatch (en route) / arrive / working statuses,Mobile,must,yes,#12 #13
Pause appointment,Mobile,must,yes,#12
Hold and reschedule with reason from field,Mobile,must,yes,#12
Schedule another appointment from field,Mobile,should,yes,#12
Mark myself done vs close out job,Mobile,must,yes,#12
Required forms block close-out,Mobile,should,yes,#13
Job forms/checklists,Mobile,must,yes,#12
Non-job forms (My Forms),Mobile,could,yes,#12
Photos/video/files upload,Mobile,must,yes,#12
Media upload quality setting,Mobile,could,yes,#12
Equipment add/replace from field,Mobile,must,yes,#12
Equipment barcode/serial capture,Mobile,should,yes,#35 barcodeId
Location info tab (history opportunities recurring),Mobile,must,yes,#12
Call recordings visible to tech,Mobile,could,yes,#12
Present estimate with options,Mobile,must,yes,#11 #12
Customer signature on estimate,Mobile,must,yes,#11
Sold items onto invoice now vs later,Mobile,must,yes,#11
Invoice presentation and signature,Mobile,must,yes,#12
Take payment in field (card reader),Mobile,must,yes,#12 Adyen/BBPOS/ID TECH
Financing application history in app,Mobile,should,yes,#12
Tech book-a-job / lead from field,Mobile,should,yes,#6 #12
Tech scorecard in app,Mobile,should,yes,#12
Offline pricebook sync,Mobile,should,yes,#12 Update Pricebook
Timeclock in mobile,Mobile,must,yes,#12
Location tracking toggle,Mobile,should,yes,#12
Residential vs commercial terminology toggle,Mobile,could,yes,#12
Atlas tech Q&A,AI,should,yes,#18 Core
Atlas troubleshooting/diagnostics/parts,AI,could,pro-addon,#18 Field Pro
Sales coach from tech recordings,AI,could,pro-addon,#18 preview
Pricebook category tree,Pricebook,must,yes,#29
Services materials equipment SKUs,Pricebook,must,yes,#29
Member price and add-on price columns,Pricebook,must,yes,#29
Service-material kits (materials bundled in a service),Pricebook,should,yes,#29 equipmentMaterials (inferred same for services)
Recommendations and upgrades on SKUs,Pricebook,should,yes,#29
Vendor costs per SKU (primary/other),Pricebook,should,yes,#29
Images/assets per SKU,Pricebook,should,yes,#29
Sold hours per SKU,Pricebook,should,yes,#29 hours
Commission/bonus per SKU,Pricebook,should,yes,#29
Price lock / cost lock,Pricebook,could,yes,#29
Discounts and fees,Pricebook,must,yes,#29
Client-specific pricing rate sheets,Pricebook,could,yes,#29
Pricebook bulk export/import,Pricebook,should,yes,"#10 (estimates); pricebook bulk path not visible"
Managed pricebook content updates,Pricebook,could,pro-addon,#19
Regional pricing averages,Pricebook,could,pro-addon,#19
One-click good/better/best templates,Pricebook,should,pro-addon,#19
Estimate templates,Estimates,must,yes,#31
Proposal templates and types,Estimates,should,yes,#31
Multiple options per proposal (G/B/B) with recommended flag,Estimates,must,yes,#31 isRecommended #14
Estimate deposit on signature,Estimates,should,yes,#31
E-sign contracts with countersign,Estimates,could,yes,#31 contract sub-status
Sell / unsell / dismiss estimate,Estimates,must,yes,#31
Estimate status change log,Estimates,should,yes,#31
Email multiple estimates at once,Estimates,should,yes,#10
Duplicate estimate,Estimates,should,yes,#10
Estimate XLSX export/import,Estimates,could,yes,#10
Internal estimate notes,Estimates,should,yes,#10
Estimate visibility restriction by creator,Estimates,could,yes,#10
Change orders,Estimates,could,yes,#31 isChangeOrder
Follow Up: sold estimates queue → initiate booking,Sales,must,yes,#11
Follow Up: unsold estimates / opportunities,Sales,must,yes,#11
Log follow-up with templates and next date,Sales,must,yes,#11
Opportunity status (not attempted/unreachable/contacted/won/dismissed),Sales,should,yes,#30
Partial-item booking of sold estimate,Sales,could,yes,#11
Automated unsold-estimate SMS/email,Marketing,should,pro-addon,#22
AI outbound agents for old estimates,Marketing,could,pro-addon,#22
Invoice auto-created at booking,Invoicing,must,yes,invoice-your-customers
Invoice line items from pricebook,Invoicing,must,yes,#30 #31
Tax zones with multiple rates,Invoicing,must,yes,#28
Payment terms,Invoicing,should,yes,#28
Payment types,Invoicing,must,yes,#28
Payment splits across invoices / unapplied,Invoicing,should,yes,#28
Refunds linked to payment,Invoicing,must,yes,#28 refundedPaymentId
Credit memos,Invoicing,should,yes,#28
Partial payments via portal,Invoicing,should,yes,#14
Pay link without login,Invoicing,must,yes,#14
ACH with authorization,Invoicing,should,yes,#14
Batch / post / export transactions,Accounting,should,yes,#23
QuickBooks Online export,Accounting,must,yes,#23
QBO touchless sync,Accounting,could,yes,#23
Journal entries / GL accounts,Accounting,could,yes,#28
AP bills and vendor payments,Accounting,could,yes,#28
Accounting periods close,Accounting,could,yes,#23
Atlas invoice anomaly review,AI,could,pro-addon,#18 preview
Membership types (template) with duration/billing options,Memberships,must,yes,#30
Membership discounts per SKU/category,Memberships,must,yes,#30
Recurring service types (annual seasonal monthly…),Memberships,must,yes,#15 #30
Recurring services attached to location,Memberships,must,yes,#15
Recurring service events generated ~12 months,Memberships,must,yes,#15
Bulk book recurring events into jobs,Memberships,must,yes,#15
Membership billing frequency (monthly…annual),Memberships,must,yes,#30
Auto-renew memberships,Memberships,should,yes,#15
Expiring memberships follow-up queue,Memberships,should,yes,#15
Membership status changes log,Memberships,should,yes,#30
Deferred revenue recognition,Memberships,could,yes,#30
Show membership savings on invoice,Memberships,should,yes,#30
Invoice templates for recurring visits,Memberships,should,yes,#30
Service agreements (commercial),Memberships,could,yes,#14 #37
Installed equipment with warranties,Equipment,must,yes,#35
Predicted replacement date,Equipment,should,yes,#35
Equipment systems (group units),Equipment,could,yes,#35 parent System
Equipment service history,Equipment,must,yes,#16 row S16
Equipment custom fields and attachments,Equipment,could,yes,#35
Campaigns with tracking numbers,Marketing,should,yes,#36
Campaign categories,Marketing,could,yes,#36
Monthly campaign cost entry and ROI,Marketing,should,yes,#36
SMS opt-in import,Marketing,should,yes,#36
Email/direct-mail campaigns on live audiences,Marketing,could,pro-addon,#22
Review requests and listings,Marketing,should,pro-addon,#22 third-party claim
Customer satisfaction survey,Reporting,should,yes,"#9 Take Survey, #24 CSAT 0-5"
Modular dashboard with KPI modules,Reporting,must,yes,#24
Custom dashboards,Reporting,should,yes,#24 package-gated
Report builder (template columns filters),Reporting,should,yes,#24
Technician scorecards,Reporting,must,yes,#24
Rollup dashboards multi-tenant,Reporting,could,yes,#24
Atlas owner mobile app KPIs,Reporting,could,pro-addon,#18 Max
Reporting API,Reporting,could,yes,#37 beta
Purchase orders with approval,Inventory,could,yes,#33
Receipts with landed cost,Inventory,could,yes,#33
Transfers warehouse ↔ truck,Inventory,could,yes,#33
Inventory adjustments,Inventory,could,yes,#33
PO markups,Inventory,could,yes,#33
Job timesheets from status timestamps,Payroll,must,yes,#34
Timesheet codes with rate multipliers,Payroll,should,yes,#34
Gross pay items,Payroll,should,yes,#34
Payroll adjustments,Payroll,should,yes,#34
Payroll periods with approve/lock,Payroll,should,yes,#34
Commission tracking,Payroll,should,yes,#1 The Works
Flexible/continuous timekeeping,Payroll,could,yes,#4 #12
Prevailing wage / labor types,Payroll,could,yes,#34
Business units with invoice header/message/tax default,Settings,must,yes,#32
Trades and divisions on BU,Settings,could,yes,#32
Job types,Settings,must,yes,#25
Tag types with color importance dispatch-visible,Settings,must,yes,#32
Roles and granular permissions,Settings,must,yes,#32 #10
Employees vs technicians,Settings,must,yes,#32
Technician burden/commission/hourly rates,Settings,should,yes,#32
Technician daily goal,Settings,could,yes,#32
Task management (log task),Ops,could,yes,#9 #37
Customer portal: invoices pay proposals jobs equipment memberships,Portal,should,yes,#14 (portal is an add-on per #6)
Portal: compare and sign estimate options with deposit,Portal,should,yes,#14
Portal: equipment search and next service,Portal,could,yes,#14
Portal: Apple Pay / Google Pay / pay-by-bank,Portal,could,yes,#14 planned
Public REST API with export feeds,Platform,should,yes,#37 #38
Webhooks,Platform,could,yes,#37 v1 closed
Fleet vehicle service log,Fleet,could,pro-addon,release-hub
Telematics hardware,Fleet,could,pro-addon,not cloneable
Atlas plain-language admin assistant,AI,should,yes,#18
```

(264 rows)

---

## 8. What cannot be cloned (or shouldn't be)

| Item | Why | Clone alternative |
|---|---|---|
| ServiceTitan Payments (processor relationship, card readers Adyen/BBPOS/ID TECH [E #12]) | Merchant-of-record or PayFac contracts and certified hardware; payment revenue share is a ST revenue line | Stripe Terminal + Stripe Connect; pay links |
| Carrier telephony and Contact Center Pro numbers, call tracking (DNIS pools) | Carrier and CNAM, number porting, A2P 10DLC registration | Twilio (already in our stack) |
| Consumer financing partners (GreenSky / Service Finance / Wisetack, "Financing History" in FMA [E #12]) | Lender contracts, credit underwriting | Wisetack or Affirm partner links; out of scope |
| Titan Intelligence models trained on cross-tenant data (Job Value Predictor [E #20], Regional Pricing Averages [E #19], Smart Recommendations) | Needs thousands of tenants' job and invoice history | Per-tenant heuristics; our own LLM agents on tenant data only |
| Pricebook Pro content library (images, descriptions, sold hours, regional pricing) | Licensed and curated content (ST also owns Pricebook-adjacent acquisitions) [I-m] | Manufacturer CSV import plus an AI-assisted description generator |
| Integration marketplace (Google LSA, Thumbtack, Reserve with Google booking providers [E #6]) | Partner agreements and certifications | Google LSA API direct; Zapier |
| Fleet Pro hardware and telematics | Physical devices | Accept GPS pings from Samsara/Verizon APIs (ST's own GPS-provider ingest [E #27] shows the shape) |
| Homh demand-gen network [E #43] | Network effect | — |
| Intacct / enterprise GL integrations | Partner certification | QBO only |
| Atlas "Max" owner app | Bundle | Our admin is already mobile web |

---

## 9. What ServiceTitan users complain about (do-better list)

The direct G2, Capterra and Software Advice pages returned 403. Those quotes came from search-engine snippets of those pages, with the review page URL given. No Reddit thread was reachable; the Reddit quotes are second-hand via checkthat.ai. Trustpilot and App Store quotes were read directly.

| # | Theme | Quote | Source |
|---|---|---|---|
| 1 | Price | "not everything needs to have a price point" (Katie, 2★, Oct 6 2026) | https://www.trustpilot.com/review/servicetitan.com |
| 2 | Price | "albeit cost prohibitive" (same review) | https://www.trustpilot.com/review/servicetitan.com |
| 3 | Price | "This one is over priced and over promised on capability/features." (01/27/2023) | https://apps.apple.com/us/app/servicetitan-mobile/id1037989976?see-all=reviews |
| 4 | Price | "most expensive FSM out there" (search snippet) | https://www.g2.com/products/servicetitan/reviews |
| 5 | Price | "One of our clients just got a massive increase from around 3K to around 10K/month" (Reddit r/CRM, second-hand) | https://checkthat.ai/brands/servicetitan/reviews |
| 6 | Price | "total cost is about $200/month vs the $600+ ServiceTitan was charging." (8-tech HVAC owner on Reddit, second-hand) | https://checkthat.ai/brands/servicetitan/reviews |
| 7 | Small-shop fit | "It's to much for our small company. We never left Housecall Pro." (search snippet) | https://capterra.com/p/150053/ServiceTitan/reviews/?page=8 |
| 8 | Contract | "lengthy contract you have to sign before you can see if it will work" (search snippet) | https://capterra.com/p/150053/ServiceTitan/reviews/?page=7 |
| 9 | Contract | "hid behind the contract: once you are locked in, it is too bad." (Johnathan Euell, 1★, Oct 2 2026) | https://www.trustpilot.com/review/servicetitan.com |
| 10 | Onboarding | "Their data specialists caused multiple delays because they did not know how to transfer the data correctly." (same) | https://www.trustpilot.com/review/servicetitan.com |
| 11 | Onboarding | "Onboarding was never completed" (search snippet) | https://www.capterra.com/p/150053/ServiceTitan/reviews/ |
| 12 | Onboarding / complexity | "it will take minimum 3 months to figure out how to use it" (search snippet) | https://www.g2.com/products/servicetitan/reviews |
| 13 | Onboarding | "The initial setup was terrible, involving long hours, stressful nights" (Hunter L., second-hand) | https://checkthat.ai/brands/servicetitan/reviews |
| 14 | Sales promises | "I think they need to do a better job following through on the promises made by the sales team." | https://www.trustpilot.com/review/servicetitan.com |
| 15 | Support | "Once they get your money, they stop caring." (Bill Carroll, 1★, Jul 30 2026) | https://www.trustpilot.com/review/servicetitan.com |
| 16 | Support | "Service Titan is all about growing and not at all about customer support." (05/09/2025) | https://apps.apple.com/us/app/servicetitan-mobile/id1037989976?see-all=reviews |
| 17 | Support | "long wait times, getting passed between teams, inconsistent answers" (search snippet) | https://www.g2.com/products/servicetitan/reviews |
| 18 | Support | "tech support is a joke and waste of time" (search snippet) | https://capterra.com/p/150053/ServiceTitan/pricing/ |
| 19 | Mobile app | "The forms will randomly close, or randomly scroll itself all the way to the bottom of the form." | https://www.trustpilot.com/review/servicetitan.com |
| 20 | Mobile app | "Every 3 seconds or every button press on this app, a little window pops up" (09/17/2024) | https://apps.apple.com/us/app/servicetitan-mobile/id1037989976?see-all=reviews |
| 21 | Mobile app | "The last update now runs the battery down, something like 4 times faster." (07/09/2021) | https://apps.apple.com/us/app/servicetitan-mobile/id1037989976?see-all=reviews |
| 22 | Mobile app | "The app auto focuses on many screens and text boxes when you type." (03/24/2020) | https://apps.apple.com/us/app/servicetitan-mobile/id1037989976?see-all=reviews |
| 23 | Mobile (connectivity) | Android reviewers say the app "only works when you have great cell service" (search snippet, paraphrase-adjacent) | https://play.google.com/store/apps/details?id=com.servicetitan.work&hl=en |
| 24 | Reporting | "somewhat restrictive when it comes to reports" (search snippet) | https://www.capterra.com/p/150053/ServiceTitan/reviews/ |
| 25 | Pricebook | pricebook build-out "very painstaking" (G2 search snippet) | https://www.g2.com/products/servicetitan/reviews |
| 26 | Pricebook | "managing the pricebook ... can sometimes be complicated and require significant time to adjust properly." (Janet T., second-hand) | https://checkthat.ai/brands/servicetitan/reviews |
| 27 | Pricebook/inventory | "I would say that the hardest for us is inventory and the pricebook." (Bob B., second-hand) | https://checkthat.ai/brands/servicetitan/reviews |

Supporting stats: an informal Facebook poll found 42% of users' pricebooks still weren't set up after 3 months (second-hand: https://checkthat.ai/brands/servicetitan/reviews, via winktoolbox). G2 lists implementation at about 3 months and ROI at about 15 months (search snippet). The legacy iOS app is rated 2.9★ on 1.7K ratings [E #39]; the Android Field app is about 3.2-3.4★ (snippet). Trustpilot is 4.0★ on 423 reviews, so overall sentiment is mixed rather than uniformly negative.

### Do-better list for a 10-tech clone (derived)
1. **Transparent month-to-month price with no implementation fee.** This answers quotes #1-9.
2. **Day-one pricebook.** AI-generated starter pricebook from the shop's past invoices (we have FieldPulse/HCP mirrors) plus a CSV importer, instead of a 3-month build (#25-27).
3. **Self-serve onboarding in hours.** Import from FieldPulse/HCP, which we already mirror (#10-13).
4. **Mobile web that's light and offline-tolerant.** No modal spam, form state autosaved (#19-23).
5. **One-screen booking.** AI intake already books; keep the CSR screen to 1 page, with no BU/campaign busywork for single-BU shops.
6. **Readable reports with defaults** for the 10 KPIs a small owner needs, before any builder (#24).
7. **Human support SLA.** In-app chat backed by Atlas-like answers grounded in our docs (#15-18).
8. **Keep ST's good primitives:**
   - arrival-window prompt on drag
   - no reassign of Working/Done
   - Follow Up queues
   - bulk-book recurring events
   - Customer/Location split
   - status timestamps feeding job costing
