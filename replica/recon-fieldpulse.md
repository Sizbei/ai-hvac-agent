# FieldPulse clean-room recon map

Date: 2026-10-31. Method: public sources only (marketing site, help center at help.fieldpulse.com, which is a Mintlify site with an `llms.txt` index and per-page `.md`, the published OpenAPI spec, the changelog, App Store reviews, Trustpilot, and third-party review and pricing write-ups). No login, no JS bundles, no private endpoints. About 45 page fetches in total.

**Conventions.** Source IDs in square brackets (e.g. `[H7]`) resolve to the URLs in section 1. "INFERENCE (conf)" marks anything not stated by a source, with confidence high/med/low.

**Blocked or absent sources (gaps).**
- G2, Capterra, Software Advice and GetApp all returned HTTP 403 to the fetcher. The Capterra quotes below are therefore second-hand, via a review write-up that reproduces them with reviewer names `[P6]`.
- The Google Play listing returned no readable content.
- A Reddit search returned no FieldPulse threads.
- Web-app URL routes are **not evidenced** anywhere public. Help docs describe navigation (left menu → tab), so screens below are keyed by navigation path, not URL.

---

## 1. Sources

| ID | URL | What it gave |
|---|---|---|
| P1 | https://www.fieldpulse.com/pricing | No public prices; "seat-based"; add-on list (Engage "line and license-based", Operator AI, Chat AI, Maverick "included on all plans", Pricebook, Custom Forms, ClearPath, Payments, Financing, Fleet Tracking, QuickBooks) |
| P2 | https://www.fieldpulse.com/ | Positioning ("#1 Field Service Management Software"), 12 industries, 4.8/5 from 2,537 reviews, full product nav list |
| P3 | https://www.forz.io/blog/fieldpulse-pricing/ | (Competitor blog, cites FieldPulse ToS) Essentials/Professional/Enterprise names; full vs field-only seats; 1-yr auto-renew, non-refundable, month-to-month +≤50%; add-on billing models; onboarding tiers; paid migration; no free trial |
| P4 | https://www.thetechyside.com.au/software/field-pulse | 3rd-party price estimates; API "27+ endpoints"; read-only resources; criticisms (webhooks limited, API key via support, offline issues, QBD dupes) |
| P5 | https://fieldcamp.ai/reviews/fieldpulse/ | 3rd-party pricing (~$89 first user + ~$30/user; fleet ~$30/vehicle via Azuga; 2.9% card); 2 Capterra cons quotes |
| P6 | https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/ | 10 attributed Capterra cons quotes (reviewer name/role/rating) |
| P7 | https://apps.apple.com/us/app/fieldpulse/id1575955293?see-all=reviews | iOS rating 4.0 (117 ratings); 6 critical reviews verbatim |
| P8 | https://www.trustpilot.com/review/fieldpulse.com | TrustScore 2.8 (3 reviews, all 1-star: contract/sales complaints) |
| P9 | WebSearch result summary (fieldservicesoftware.io, softabase.com, capterra.com/p/153475, itqlick) | Conflicting 3rd-party per-user estimates ($65/$90/$115); not fetched directly. LOW confidence |
| A1 | https://help.fieldpulse.com/openapi/fieldpulse-api.json | **Full OpenAPI 3.0 spec**: 30 resource groups, request-body field lists + enums, `x-api-key` auth, AWS API Gateway base URL, `{error,total_count,response}` envelope |
| A2 | https://help.fieldpulse.com/api-reference/overview | API use cases; webhooks for job status; key via support@ |
| A3 | https://help.fieldpulse.com/api-reference/webhooks | Webhook events: Job Created / Custom Status Update / Start/End Time Update; Estimate Created / Status Update; Invoice Created / Status Update |
| A4 | https://help.fieldpulse.com/llms.txt and https://help.fieldpulse.com/_llms/en/home.txt | Full help-center IA (428 pages): every feature area's article titles |
| A5 | https://help.fieldpulse.com/integrations/developer-api/zapier-triggers-actions | Zapier triggers/actions + fields |
| C1 | https://help.fieldpulse.com/changelog | Recent releases (Maverick, MA rebuild, Tap to Pay, Bill-to-Parent, Duplicate Dispatch Checker, etc.) |
| H1 | https://help.fieldpulse.com/getting-started/quick-start/customers-scheduling | Customer add (manual/import/QB), job creation, scheduling from job or Dispatch View |
| H2 | https://help.fieldpulse.com/getting-started/role/dispatcher | Dispatcher day: Dispatch/Map views, Job Queue (hourglass), Team Members > Map, Jobs > Unassigned |
| H3 | https://help.fieldpulse.com/getting-started/quick-start/estimates-invoices | 3 entry points for estimates/invoices; Convert to Invoice; left-nav groups (Work, Sales) |
| H4 | https://help.fieldpulse.com/getting-started/role/field-technician | Mobile tech loop: clock in, navigate, status bar, files, comments, invoice, payment, offline table |
| H5 | https://help.fieldpulse.com/getting-started/mobile-app/service-agents | Mobile tabs (Schedule/Work/Customers/Sales/Timesheets + Full Menu), schedule views List/Calendar/Dispatch/Map, custom job tile |
| H6 | https://help.fieldpulse.com/scheduling-dispatch/dispatch/using-schedule-map-view | Team Schedule tabs List/Calendar/Dispatch/Map; map Day/Custom modes; filters; color by status/team member |
| H7 | https://help.fieldpulse.com/jobs/jobs-tasks/creating-a-job | Full job form (web+mobile), skill tags in assignee dropdown, Find Availability, conflicts, arrival window, site visits, assets, "Refine" AI; job cannot be deleted, customer cannot change |
| H8 | https://help.fieldpulse.com/jobs/jobs-tasks/completing-a-job | Mobile job record Info/Files/Comments, status bar, navigate, mark-payment pop-up |
| H9 | https://help.fieldpulse.com/scheduling-dispatch/availability/overview | Dispatch View mechanics, filter by team/skill, Find Availability parameters |
| H10 | https://help.fieldpulse.com/jobs/jobs-tasks/recurring-jobs | Recurring tab, frequency, edit scope (future/all/past), 12-month horizon, archive options |
| H11 | https://help.fieldpulse.com/jobs/assets/maintenance-agreements | Maintenance agreement 4-level model, Scheduled vs On-Demand, job-gen rules, billing, reminders, contract e-sign, templates |
| H12 | https://help.fieldpulse.com/jobs/workflows/custom-status-workflows | Custom status workflows (jobs/projects/material lists/MAs), status types (Travel Time, In Progress), default statuses |
| H13 | https://help.fieldpulse.com/jobs/workflows/clearpath/overview | ClearPath: Status Action Flows, Instructions, 0–10 Action Buttons from 27 actions, Focus View, 32 widgets |
| H14 | https://help.fieldpulse.com/jobs/booking-portal/booking-portal-setup | Booking portal config: contact methods, pricing/deposit options, Smart Scheduler settings, iframe embed |
| H15 | https://help.fieldpulse.com/customers/customer-portal/customer-portal | Customer portal tabs + every visibility toggle |
| H16 | https://help.fieldpulse.com/customers/communications/automatic-triggers | Trigger list + trigger actions; Engage vs toll-free sending |
| H17 | https://help.fieldpulse.com/estimates-invoices/creating/estimate | Estimate builder: Add Item panel, options, groupings, bundles, PO items, pricebook, markup/margin, add-ons, Dynamic Estimate/PDF/Variant Proposal, barcode scan |
| H18 | https://help.fieldpulse.com/estimates-invoices/options/options-add-ons | Multi-option estimates (Option 1..n tabs) and add-on options |
| H19 | https://help.fieldpulse.com/estimates-invoices/recurring/recurring-billing | Recurring billing settings, link to recurring job/MA, card retry schedule (Day 0/3/7/14) |
| H20 | https://help.fieldpulse.com/payments/getting-started/fieldpulse-payments | Payments: 3 collection methods, next-day funding, card fee recovery, funding timelines, US-only |
| H21 | https://help.fieldpulse.com/payments/collecting/collecting-payments-3-methods | Invoice → Paid/Partially Paid; web/mobile/email collection |
| H22 | https://help.fieldpulse.com/scheduling-dispatch/dispatch/route-optimization | "Schedule Route": manual click-order on map + first-job time + default job/travel durations |
| H23 | https://help.fieldpulse.com/inventory-materials/purchase-orders/managing | PO create (19 steps), suppliers, receiving labels, auto-replenishment |
| H24 | https://help.fieldpulse.com/inventory-materials/item-list/inventory-hubs | Inventory hubs (truck/warehouse), one default deduction hub per user |
| H25 | https://help.fieldpulse.com/reporting/pulse/pulse-dashboard | Pulse Dashboard widgets, Default Homepage options, Configure Dashboard |
| H26 | https://help.fieldpulse.com/settings/users-teams/user-roles | 5 roles + full permission matrix |
| H27 | https://help.fieldpulse.com/add-ons/engage/overview | Engage: Conversations/Calls/Voicemails/Customers views, routing, 10DLC, AI transcripts, roles |
| H28 | https://help.fieldpulse.com/add-ons/sales-suite/pricebook | Pricebook: labor/overhead rates, markup categories, categories (List or Good/Better/Best), add-on lists, flat-rate jobs |
| H29 | https://help.fieldpulse.com/jobs/timesheets/employee-timesheets | General vs Job timesheets, backdated time, clock locations, status-triggered clock prompts |
| H30 | https://help.fieldpulse.com/customers/leads-pipeline/sales | Custom Sales Pipeline, Customers > By Pipeline kanban |
| H31 | https://help.fieldpulse.com/jobs/jobs-tasks/unassigned-unscheduled-jobs | Jobs > Unassigned tab, drag from Job Queue |
| H32 | https://help.fieldpulse.com/integrations/accounting/quickbooks-online/overview | QBO sync matrix per entity + direction |
| H33 | https://help.fieldpulse.com/integrations/accounting/quickbooks-online/sync | QBO connect steps (access requested via support), initial sync 24h to 2 weeks |
| H34 | https://help.fieldpulse.com/add-ons/ai/operator-ai | Operator AI (AI phone agent) config: service areas, matching, scheduling modes, job-creation modes |
| H35 | https://help.fieldpulse.com/add-ons/fleet/pulse-fleet-tracking | Fleet = Azuga GPS / Surfsight dashcam, vehicles on schedule map |
| H36 | https://help.fieldpulse.com/add-ons/custom-forms/overview | Custom forms: templates, PDF import/overlay, required/internal fields, record-field pull-in |
| H37 | https://help.fieldpulse.com/getting-started/next-steps/features-plugins-overview | Company Settings > Features & Plugins = central enable switchboard |
| H38 | https://help.fieldpulse.com/customers/communications/sending (fetched, skimmed only) | Sending comms |

---

## 2. Positioning and pricing

**Positioning.**
- Tagline: "#1 Field Service Management Software… Turn Chaos into Predictable Growth"; "Built to adapt. Simple to run. Backed by people." `[P2]`
- Industries: HVAC, Electrical, Plumbing, Garage Door, Locksmith, Property Mgmt, Appliance, Commercial Equipment, Fire & Security, Contractors, Septic, A/V. Also residential and franchise segments. `[P2]`
- Founded 2015; claims 4.8/5 across 2,537 reviews. `[P2]`
- Differentiators FieldPulse pushes: ClearPath (guided tech workflow), Operator AI (AI phone booking), Maverick (AI assistant, all plans), US-based support. `[P2][P1]`
- Migration guides target ServiceTitan, Housecall Pro, Jobber, Service Fusion and FieldEdge, which tells you who they take share from. `[A4]`

**Pricing model.**

| Item | Fact | Source / confidence |
|---|---|---|
| Public price | None. "Get a Custom Quote"; "seat-based" | `[P1]` high |
| Plan names | Essentials / Professional / Enterprise (quoted per business after demo) | `[P3]` citing a FieldPulse article, med |
| Seat types | Full-access seats + lower-priced field-only seats | `[P3]` med |
| Per-user estimates | ~$65 / $90 / $115 per user/mo (Essentials/Pro/Enterprise); alt. ~$89 first user + ~$30/additional | `[P9][P5]` LOW (unverified, conflicting) |
| What tiers gate | Third-party claim: Essentials = scheduling, dispatch, CRM, estimates, invoicing, mobile. Pro adds payments, QuickBooks sync, custom forms, advanced reporting. Enterprise adds pricebook, multi-location, priority support | `[P9]` LOW. Conflicts with `[P1]`/`[P3]`, which list Pricebook and Custom Forms as separately billed add-ons |
| Contract | 1-year term, auto-renew unless 60 days' notice; fees non-refundable "regardless of usage"; month-to-month at up to +50%; removing users doesn't reduce billed seats | `[P3]` citing ToS, med-high |
| Trial | Conflicting: "none, demo only" `[P3]` vs "14 days" `[P4][P5]` | low |
| Onboarding | Included, ~30 days; tiered by seat count (self-serve 1 user → structured 10+); data migration is a paid separate contract | `[P3]` med |

**Add-ons (feature gating by money = features that matter).**

| Add-on | Billing | What it unlocks | Source |
|---|---|---|---|
| Engage | Per line + license | Business phone/SMS/voicemail/email inbox tied to customer records, call routing/IVR, recording, AI transcripts and summaries, 10DLC | `[P1][P3][H27]` |
| Operator AI | Usage-based; requires Engage | AI voice agent answers missed/after-hours calls and books jobs on the schedule | `[P3][H34]` |
| Chat AI | Usage-based | Web chat lead capture (not researched further) | `[P1][P3]` |
| Sales Suite: Pricebook | Flat monthly | Flat-rate pricebook, Good/Better/Best, dynamic proposals, dimensional pricebook | `[P3][H28][A4]` |
| Custom Forms | Flat monthly | Form builder, PDF form filler, checklists | `[P3][H36]` |
| Fleet Tracking | Per vehicle/device (~$30/vehicle est.) | Azuga GPS, Surfsight AI dashcam, vehicles on schedule map | `[P3][P5][H35]` |
| FieldPulse Payments | Processing fees + a monthly cost (rates unpublished; ~2.9% est.) | Card/ACH, Tap to Pay, next-day funding, card fee recovery, saved payment methods, booking deposits | `[H20][P5]` |
| FieldPulse Financing | No FP fee | Wisetack / Acorn / FieldPulse Capital | `[P3][A4]` |
| Included free | Maverick AI, ClearPath, Customer Portal | — | `[P1][H13][H15]` |
| QuickBooks Online/Desktop, Xero | Not priced; QBO **access must be requested from support** | — | `[H33]` |

**Plan-gating table (what FieldPulse charges extra for → priority signal).** Phone/SMS inbox, AI call answering, flat-rate pricebook, forms/checklists, GPS, and payments are all monetized. INFERENCE (high): these are the features HVAC buyers value and pay extra for. The core loop (CRM → job → schedule → invoice) is table stakes.

---

## 3. Screen inventory

Web routes are not public. The "Nav path" column is from help docs. States: **F** = filled (described), **E** = empty (described), **O** = offline (described), **M** = mobile variant exists. Loading and error states are **not evidenced** for any screen unless noted.

| ID | Screen | Nav path (web unless noted) | Purpose | Key components | States evidenced | Source |
|---|---|---|---|---|---|---|
| S01 | Pulse Dashboard | Left menu > Pulse Dashboard | At-login business snapshot | Widget grid (Tech Scorecard, Jobs-Today, Profit by Lead Source, Sales by Technician, Payments Collected, Invoice & Estimate Sales by Created Date); **Default Homepage** dropdown (Pulse / Team Schedule / Team Timesheets / Estimates / Invoices / Customers / Projects); Configure Dashboard (delete/reorder); column-header filter icon | F, M (mobile Pulse Dashboard with today's jobs, clock in/out, Create Job) | `[H25][H5][H7]` |
| S02 | Custom Reporting Dashboard | Reporting | Dashboard with user-built reports, per-widget date range, resizable widgets/rows | Report widgets | F (described only) | `[H25]` |
| S03 | Customers list | Left menu > Customers | Find/manage customers | Search, filters, tags, tabs incl. **By Pipeline**, By-Tag views | F | `[H1][H30][C1]` |
| S04 | Customers > By Pipeline | Customers > By Pipeline tab | Sales kanban | Column per pipeline status; card shows next steps + latest estimate amount; drag to change status; lost/completed auto-hide after 1 week | F | `[H30]` |
| S05 | Customer detail | Customers > (customer) | 360° record | Header contact info; **Actions** dropdown (Related: Create Estimate/Invoice/Job); tabs incl. Jobs, Recurring Billing, Maintenance Agreements (with Status column); portal link + Password Protected checkbox; multi-location/multi-contact; Assigned To | F, M | `[H3][H15][H19][C1]` |
| S06 | Jobs list | Left menu > Work > Jobs | All jobs | Search & Filter (incl. Is Archived); tabs **Unassigned**, **Recurring**; Create Job | F, M (All/Open/Closed/Tasks filter; hide recurring) | `[H7][H31][H10][H5]` |
| S07 | Create/Edit Job form | Jobs > Create Job (also from Customer, Schedule, Dashboard on mobile) | Book work | Customer Name picker (create inline); Contact (Location Contacts / All Customer Contacts tabs); Title, Subtitle (≤150 chars); Assigned Users (people/teams with Select All, skill tags shown, search by tag); Job Tags; Status Workflow; Status Action Flow; Dates (date/start/end, multi-day); **Find Availability**; Check scheduling conflicts; Customer Arrival Window (+Insert Job Date/Time); Add Site Visit; Notes (with AI **Refine**) + Upload File; Assets (Select/Add); custom fields; Import Template / Save as Template; "Create recurring job" link | F, M (Save appears only when required fields complete) | `[H7]` |
| S08 | Job detail | Jobs > (job) | Work record | Status bar; Actions (Clock In/Out, Create Estimate/Invoice, Send Customer Communication, Connect to Maintenance Agreement, Create MA); tabs Info / Files / Comments / Estimates; time-in-status fields (travel, duration); linked MA at top | F, M, O | `[H4][H8][H11]` |
| S09 | Find Availability panel | Job form > Find Availability | Suggest time slots | Scheduling Parameters (duration, buffer before/after, starts after, ends before, team members, # needed, skills); Suggest Times → slots grouped by day → Confirm Selection; manual pick grid (day → member → slot → ✓) | F | `[H9]` |
| S10 | Team Schedule: List | Schedule > List | Jobs list by date | — | F (thin evidence) | `[H6]` |
| S11 | Team Schedule: Calendar | Schedule > Calendar | Calendar | Task colors follow status; date persists across view switches | F (thin) | `[H6][C1]` |
| S12 | Team Schedule: Dispatch View | Schedule > Dispatch | Time-grid dispatch board (rows = team members) | Left column of members (click to select, highlights blue); All Team Members dropdown (drag-reorder teams, session-only); Filter by Skill multi-select; click grid start time → Create Job (1h default); side-by-side drawers; Job Queue (hourglass) drag-to-schedule | F | `[H9][H2][H31][C1]` |
| S13 | Team Schedule: Map | Schedule > Map > Day / Custom | Geographic dispatch | Team dropdown (Teams, Deactivated Users, Unassigned Jobs, Unscheduled Jobs, which need a location); From/To + Apply (Custom); Filter by Job Status (funnel); Job Queue Panel; ⋮ View By Status / By Team Member Color; job markers → detail; live vehicle GPS (Fleet add-on); **Schedule Route** | F | `[H6][H35][H22]` |
| S14 | Schedule Route wizard | Schedule > Map > Schedule Route | Sequence a day's stops | Click markers in order (numbers appear) → Next → Set Route Schedule (first job date/time, default job duration, default travel duration, assign teams/members) → Finalize New Route (per-job start/end editable, Re-Order, Confirm Changes) | F | `[H22]` |
| S15 | Job Queue panel | Schedule > hourglass icon | Unassigned/unscheduled backlog | Filter (e.g. MA jobs); drag onto date/time | F | `[H2][H11][H31]` |
| S16 | Team Members map | Left menu > Team Members > Map | Last-known tech location + timestamp (from app activity) | Map | F | `[H2]` |
| S17 | Recurring jobs | Jobs > Recurring tab | Manage series | Create Recurring Job form (customer, title, status workflow, action flow, frequency, first occurrence, No End Date / last occurrence, team, tags, notes); edit-scope modal (Only Future / All / Only Past); archive modal | F | `[H10]` |
| S18 | Projects | Left menu (Projects) | Multi-job long work | Status workflow (opportunity → canceled), completion % | Not screenshotted; F (API + portal evidence) | `[A1][H15]` |
| S19 | Estimates list | Sales > Estimates | Sales docs | Status column (Draft/Sent/Accepted auto; others manual); Create Estimate | F, M (status filter) | `[H3][H17]` |
| S20 | Estimate builder | Estimates > Create | Build quote | Customer/job link; Import Template; Expiration Date; **Add Item** right-side panel (search item list, "Add to Estimate and Add Next Item", Create New Line Item); row icons eye/pen/trash; Add Estimate Option (tabs, rename ≤30 chars, duplicate/delete); Add Grouping (drag items, visibility); Insert Bundle; Insert PO Items; Pricebook; Apply Markup/Margin; Create Add-On Options; Estimate Notes vs Internal Notes; Files tab; Contract tab; totals; Save → Draft | F, M (line-item photo with markup, barcode scan, Save as Template) | `[H17][H18]` |
| S21 | Estimate preview / send | Estimate > View Estimate | Customer-facing render | View modes **Dynamic Estimate / PDF / Variant Proposal**; Send / **Present** (in person); Settings (company profile, contract & signature lines, line-item detail visibility, theme); Convert to Invoice | F, M | `[H17]` |
| S22 | Invoices list | Sales > Invoices | Billing | Tabs incl. **Recurring Billing** (Customers filter); real-time payment status badges | F | `[H19][C1]` |
| S23 | Invoice builder/detail | Invoices > Create / Convert | Bill | Same layout as estimate; Finalize Invoice; Payment button (Collect Payment / Send Payment Request / Mark Payment); Payments tab; lock-edits milestones | F, M, O (preview/sign cached) | `[H3][H4][H21][C1]` |
| S24 | Recurring billing form | Invoices > Recurring Billing / Customer tab / Recurring job Actions / MA Billing step | Auto-invoicing | Invoice Frequency, Occurrence Date, Starting Month, Auto-send?, Default Invoice Status, Next Occurrence, End Date?, End Method, # Occurrences | F (web only) | `[H19]` |
| S25 | Payment collect sheet | Invoice > Payment | Take money | Card keyed/scanned/swiped (mobile), Tap to Pay iPhone, ACH, email request toggles (Include Payment Request, Card, Bank Transfer) | F, M; offline: **not possible** | `[H20][H21][H4][C1]` |
| S26 | Payments portal / statements | (FieldPulse Payments portal) | Deposits & fees | Deposit tracking, monthly statements | described only | `[H20][C1]` |
| S27 | Pricebook builder | Sales > Pricebook (add-on) | Flat-rate catalog | Basic info (labor cost/hr, overhead/hr, markup %, markup categories, grouping visibility); Pricebook Builder tab: categories (List or Good/Better/Best), Add-On Lists (single/multi select), All Flat Rate Jobs (labor & overhead line, items, drag reorder) | F, M (category → multi-select → add to invoice/estimate/variant proposal) | `[H28]` |
| S28 | Item list / inventory | Company Settings > Estimates & Invoices > Inventory (settings); item list | Products/services/parts | Item fields (see §6), serialized inventory, hubs, deduct/count | F | `[H24][A1][A4]` |
| S29 | Inventory hubs | Settings > Estimates & Invoices > Inventory > Inventory Settings | Truck/warehouse stock | Enable multiple hubs, Add New Hub (name, Assigned To) | F | `[H24]` |
| S30 | Purchase Orders | Left menu > Purchase Orders > Create Order | Supplier ordering | Supplier picker/create; Order Number; Delivery/Pickup + address; Expected Delivery (≥2h ahead, validation); Customer; Assigned Team Member; Title; Link (Project/Job/Invoice/Estimate/None); items; tags; custom fields; Instructions tab (on PDF); Notes (internal); Tax %; Save → Send Email / Download Order; receiving labels | F, M | `[H23][C1]` |
| S31 | Material Lists | Sales tab (mobile) / material lists | Internal parts lists with status workflow | Groupings, line items, statuses | F (thin); O ("Offline Draft") | `[A1][H5][C1]` |
| S32 | Team Timesheets | Left menu > Timesheets | Hours review | General vs Job Tracking categories; clock-in/out location; Log Backdated time; per-job hours | F, M, O | `[H29]` |
| S33 | Reporting: Raw Data | Reporting > Raw Data | Tabular exports | 26 report types (Asset, Commission, Custom Forms, Customer, Estimate, Inventory audit/count, Invoice, Invoice Item, Item Usage, Job, MA, Payment, Project, PO, Reminder, Review Mgmt, Serialized Inventory, Site Visit, Subtask, Task, Timesheet, User); relative-date filters; Time-in-Status columns | F | `[A4][C1]` |
| S34 | Agreements | Left menu > Agreements (tabs Agreements / Occurrences / Templates) | Maintenance agreements | Expandable rows (per routine next occurrence/due date); filter panel; **Save as View**/Manage Views; occurrence status chips; + (create job) and link icons | F, M | `[H11]` |
| S35 | Create Maintenance Agreement | Agreements > Create (or + menu) | Sell/set up plan | **Single Page View** or **Easy Flow View** (5 steps: General → Routines → Billing → Communications → Review); Import Template; Overlapping Routines Detected banner; Save as Draft / Save and Activate (loading page, minutes) | F | `[H11]` |
| S36 | Assets | Customer / job / asset record | Equipment | Fields: make/model/serial/install/warranty; Create Maintenance Agreement action; transfer between customers | F | `[A1][H11][C1]` |
| S37 | Company Settings hub | Left menu > Company Settings (Admin only) | Configuration | Top-menu tabs incl. **Features & Plugins** (enable tiles), Jobs (General: Next Job #, mark-payment pop-up; Custom Status), Projects, Material Lists, Maintenance Agreements (rename entity), Customer Communications (Automatic Triggers, templates, Notification Settings), User Accounts (Teams, Inventory Permissions), Estimates & Invoices (Inventory), Orders (Custom Fields), Suppliers, Tags | F | `[H37][H7][H12][H16][H24][H23][C1]` |
| S38 | Custom Status Workflow editor | Settings > Jobs > Custom Status | Define job lifecycle | Statuses with name/color/symbol/type (Travel Time, In Progress, pause, completion); drag into workflow; set default; must **activate** (MA) | F | `[H12]` |
| S39 | ClearPath config | Settings (ClearPath) | Guided tech flows | Status Action Flows per workflow; Status Instructions; Action Buttons (0–10/status from 27 actions); Focus View widget picker (32 widgets) | F | `[H13]` |
| S40 | Automatic Triggers | Settings > Customer Communications > Automatic Triggers > Create New | Comms automation | Trigger dropdown (§4 F05), Trigger Action (Auto / Prompt / Scheduled / Scheduled+Confirm), template picker | F | `[H16]` |
| S41 | User Accounts / roles | Settings > User Accounts | Users & permissions | Role dropdown (Admin via "Assign as Company Admin" toggle), User Feature Permissions toggles, permission templates, skill tags | F | `[H26][C1]` |
| S42 | Customer Portal (customer-facing) | Tokenized link (optionally password) | Self-service | Tabs Home (edit profile), Submit Request, My Jobs, My Projects, My Estimates (accept/download/print), My Invoices, My Payments, My Assets | F | `[H15]` |
| S43 | Booking Portal (customer-facing) | Custom URL or iframe embed | Online booking | Welcome text; service categories → services; price/deposit display; time slots (Smart Scheduler); custom fields; photo upload | F | `[H14]` |
| S44 | Booking Portal setup | Settings > Features & Plugins > Booking Portal | Configure | Contact method, URL, auto-schedule toggle, timezone, custom fields, General vs Smart Scheduler availability, services (booking method, team needed, eligible members, duration, buffers, lead time, skills, windows, items), notifications, Embed Iframe (manual size) | F | `[H14]` |
| S45 | Engage: Conversations | Engage > Conversations | Unified SMS/call/VM/email thread per customer | Filter All/Main/Selected numbers; search; per-thread filter by type/member; **Notes** toggle (internal); **Sending From** line picker; All/Follow Up buttons; Mark as Read for Everyone; tag filter | F, M | `[H27][C1]` |
| S46 | Engage: Calls / Voicemails / Customers | Engage tabs | Call log, VM, contact list | Playback, call notes, link call → job/estimate/invoice/project/MA, AI transcript+summary, "Outside of Working Hours" tag | F, M | `[H27][C1]` |
| S47 | Fleet Tracking dashboard | Management > Fleet Tracking | Azuga GPS | Vehicle profile, connected hardware, events, geofences | described | `[H35]` |
| S48 | Operator AI portal | webai.fieldpulse.com (separate app) | AI phone agent config | My Company > Configuration (timezone, service areas incl/excl, service matching policy, scheduling mode, job-creation mode, arrival window phrasing, booking limits, pricing & offers text, notification recipients) | F | `[H34]` |
| S49 | Maverick AI assistant | Web app panel | NL search/report/create (e.g. job from pasted email/PDF → review card → Create) | Chat panel, record cards | described | `[H7][C1]` |
| M01 | Mobile: Pulse Dashboard | Full Menu > Pulse Dashboard | Today's jobs, clock in/out, Create Job | — | M | `[H5][H7]` |
| M02 | Mobile: Schedule | Bottom tab Schedule | Views **List** (day/week/month), **Calendar** (week), **Dispatch**, **Map**; month picker; **Customize Job Tile** (choose fields); live time line | M | `[H5][C1]` |
| M03 | Mobile: Work | Bottom tab Work | Jobs (All/Open/Closed/Tasks), subtasks, Actions; admins also see projects, MAs, payments, POs | M | `[H5]` |
| M04 | Mobile: Job record | Tap a job | **Info** (customer, address → Navigate to Location, yellow internal notes, tags, status bar, field notes), **Files** (Attach / Upload Photo / Take Photo+video), **Comments** (Notify Team Manager / Notify Assigned toggles), **Estimates**; Actions (Clock In/Out, Create Invoice, Send Customer Communication) | M, O | `[H4][H8]` |
| M05 | Mobile: ClearPath Focus View | Job (when flow attached) | Per-status instructions, action buttons, widgets (incl. Site Visit widget) | M | `[H13][C1]` |
| M06 | Mobile: Customers | Bottom tab Customers | Only assigned/related customers for Service Agents; Create New if permitted | M | `[H5]` |
| M07 | Mobile: Sales | Bottom tab Sales | Estimates, invoices, material lists, pricebooks, variant proposals, dynamic proposals | M, O | `[H5][H28]` |
| M08 | Mobile: Timesheets | Bottom tab Timesheets | Clock in/out (general + job), past days/weeks, team view (managers); My Settings → status-triggered clock prompts | M, O | `[H5][H29]` |
| M09 | Mobile: Custom forms | Job > forms | Fill checklist/inspection, signatures, photos | M, O | `[H36][A4]` |
| M10 | Mobile: Engage | Engage mobile app section | Calls/texts on assigned line | M | `[A4][H27]` |

**Not evidenced (do not invent):** a dedicated "Payments" list screen in web nav (payments are per-invoice tabs plus raw-data report plus a separate payments portal; INFERENCE med that no top-level web Payments list exists for non-admins), loading/error/empty states for any screen, a signature-capture UI screen (help articles exist: `estimates-invoices/options/customer-signature`, not read), the inventory count UI, and the reporting template builder UI.

---

## 4. User flows

Click counts are INFERENCE (med) from the documented step lists.

**F01: New customer → job → schedule → dispatch → tech completes → invoice → payment (core loop)**
1. **Office.** Customers > Create (or create inline in the job form) → Jobs > Create Job → pick customer → contact → title → Assigned Users → tags → Status Workflow → Date/Start/End (or Find Availability → Suggest Times → Confirm) → arrival window → Save Job. Assignees are notified. `[H1][H7][H9]`
2. **Alternative office path.** Schedule > Dispatch → click member → click time → Create Job (prefilled, 1h). `[H9]`
3. **Tech.** Mobile Schedule → job → Actions > Clock In → address > Navigate → status bar → On the Way (fires SMS trigger) → In Progress (time tracked) → field notes → Files > Take Photo → Comments → status Completed → Clock Out. `[H4][H8][H12][H16]`
4. **Invoice.** Job Actions > Create Invoice (or Estimates tab > Convert to Invoice) → add items → Finalize Invoice. `[H4]`
5. **Payment.** Invoice > Payment → Collect Payment (card/ACH/Tap to Pay) or Send Payment Request (email link) or Mark Payment (cash/check) → status becomes Paid / Partially Paid. `[H4][H21]`

Edge cases:
- A job cannot be created without a customer (use a Task instead). `[H1]`
- The customer **cannot be changed** after the job is saved. `[H7]`
- Jobs **cannot be deleted**, only archived. `[H7]`
- Scheduling conflicts are flagged, and the warning can be turned off. `[H7]`
- Payments are unavailable offline, as is creating a new customer or job. `[H4]`
- Completing a job pops a "mark payment?" prompt, which can be disabled. `[H8]`
- The Duplicate Dispatch Checker warns when a site was already worked under a different customer record. `[C1]`

Click estimate: office ~12–15 clicks (create + schedule); tech ~10 taps to complete; invoice + collect ~8 taps.

**F02: Estimate → approve → convert**
1. Estimates > Create (or from Customer/Job Actions) → Import Template? → Expiration → Add Item panel (×n) or Pricebook / Bundle → + Add Estimate Option (Good/Better/Best) → Create Add-On Options → notes/files/contract → Save (Draft). `[H17][H18]`
2. View Estimate → Dynamic/PDF/Variant → Send (email; the "estimate sent" trigger can auto-follow-up) or Present on site → customer accepts (Dynamic link / portal / e-sign; Variant Proposals can be accepted online with an auto-signed PDF). `[H17][H16][C1][H15]`
3. Convert to Invoice → all lines carry over. Can also create a Maintenance Agreement from a template-linked line item. `[H17][H11]`

Edge cases:
- Status moves automatically through Draft/Sent/Accepted; other statuses are manual. `[H17]`
- Edits can be locked on convert, finalize or paid. `[C1]`
- "Disable Estimates if Expired" setting. `[H15]`
- No explicit "convert to job" step is documented. The estimate is attached to a job or started from one. INFERENCE (med): an accepted estimate does not auto-create a job.

Click estimate: ~15–25 for a 3-option estimate.

**F03: Recurring / maintenance agreements**
- **(a) Simple recurring job.** Jobs > Recurring > Create Recurring Job → customer → title → workflow → frequency → first occurrence → end → team → Save. Occurrences are generated 12 months out. `[H10]`
- **(b) Maintenance agreement.** Agreements > Create (or from job/asset/estimate/invoice) → 5 steps:
  - General: customer, location, status, contact, dates, notes, job notes.
  - Routines: Scheduled or On-Demand, ≤5 per agreement here (changelog says up to 10), frequency, assets, job template, generation rule (none / unscheduled / auto-schedule at earliest availability / fixed day-time), window.
  - Billing: link or create recurring billing, or manual schedule.
  - Communications: occurrence reminders by email/SMS N days before; renewal reminders.
  - Review: Save and Activate (async generation).
  - Then the contract tab → Send → customer e-signs. `[H11][C1]`
- **(c) Recurring billing.** Card auto-retry Day 0/3/7/14. `[H19]`

Edge cases:
- An edit-scope modal applies to recurring jobs and agreements; frequency changes are always future-only. `[H10][H11]`
- Editing a series **overwrites individual occurrence edits** in scope. `[H10]`
- A 5th-weekday occurrence that doesn't exist that month is skipped. `[H10]`
- When a job links to an MA, a modal asks whether to treat the existing invoice as Billing Sequence 1 (dedupe). `[H11]`
- Customers **cannot** claim On-Demand visits in the portal. `[H11]`
- Completing an MA requires end date ≤ today, all jobs completed or canceled, and all invoices paid or void. `[H11]`

Click estimate: MA ~30–40.

**F04: Booking portal**
1. **Admin.** Features & Plugins > Booking Portal > Enable → contact method → URL/text → auto-schedule toggle → availability (General vs Smart Scheduler) → services (category, booking method incl. deposit/full payment via FP Payments, team needed, eligible techs, duration, buffers, lead time, skills, windows, items) → notifications → Embed Iframe. `[H14]`
2. **Customer.** Website iframe → pick service → pick slot → details/custom fields/photos → (pay deposit) → submit. The request goes to an approval queue, or straight to a scheduled job if auto-schedule is on. A confirmation email is optional. `[H14]`
3. Edge cases: duplicate-customer matching exists (FAQ titles only; rule not read); General Availability ignores real schedules. `[H14]`

**F05: Two-way SMS (Engage) + automated comms**
1. **Inbound.** A customer texts the business number → Engage Conversations thread (matched to customer record) → reply with Sending From line → internal Notes → Follow Up filter → Mark as Read for Everyone. `[H27][C1]`
2. **Automated.** Settings > Customer Communications > Automatic Triggers. The triggers are:
   - Estimate sent and not accepted (with or without dynamic link)
   - Estimate accepted
   - Invoice sent and unpaid (+N days)
   - Invoice overdue (with link)
   - Invoice past due
   - Payment record created
   - Job created
   - Job status → X
   - Site visit status → X
   - Time relative to job start

   Actions are Auto / Prompt / Scheduled / Scheduled+Confirm. `[H16]`
3. Without Engage, messages send from a **no-reply toll-free FieldPulse number**, so there is no two-way thread. `[H16]`
4. Edge cases: 10DLC registration is required before texting US numbers; Engage lines can't receive OTPs; working hours, after-hours 24/7 line redirect, and phone tree / sequential ring are supported. `[H27][C1]`

**F06: QuickBooks Online sync**
1. Request access from support → Settings > Features & Plugins > QuickBooks Online tile → Connect (OAuth) → choose time period + entities (invoices require customers + items) → default tax / sales account / purchase account → accept T&C → initial sync. `[H33]`
2. The initial sync takes **24–48h for ≤5k records, up to 2 weeks for 20–50k**. `[H33]`
3. Sync directions:
   - Two-way: customers (primary contact and addresses only), line items, estimates, invoices (from Invoiced status), payments (no tips/refunds/voids).
   - Opt-in: POs (one- or two-way), timesheets (one-way to QBO). `[H32]`

**F07: Dispatcher daily triage (bonus)**
Schedule > Map → filter Unassigned/Unscheduled → Job Queue → drag onto a member → Team Members > Map for real location → Schedule Route (manual stop ordering). `[H2][H6][H22]`

---

## 5. Components (repeated UI parts)

| Component | Variants / states | Used on | Source |
|---|---|---|---|
| Green **Actions** dropdown (record-level) | Sections like "Related"; role-gated items | Customer, Job, Estimate, Invoice, MA, Recurring job, Asset | `[H3][H7][H11][H17]` |
| Status bar / status chip (custom workflow) | Name, color, symbol, type (Travel/In Progress/Pause/Complete); default; time-in-status | Job, Site Visit, Project, Material List, MA, Estimate/Invoice workflows | `[H12][A1]` |
| Assignee multi-select | People + teams with Select All; skill-tag chips; search by name or tag | Job form, recurring job, MA, service config | `[H7][C1]` |
| Tag input | Type + Enter to create, colored; per-object tag types | Customers, jobs, subtasks, invoices, items, flat-rate jobs, users, timesheets, projects, orders | `[A1][H7]` |
| Right slide-out panel | Add Item panel; routine template slide-out; filter panel | Estimate/Invoice/PO builder, MA templates, list filters | `[H17][H11]` |
| Line-item table | Eye (customer visibility) / pen / trash icons; drag handle; groupings; options as tabs; add-on options | Estimate, Invoice, Material List, PO, Pricebook flat-rate job | `[H17][H18][H28]` |
| Import Template / Save as Template | Toggle on mobile, button on web | Job, Estimate/Invoice, MA, routine, custom form | `[H7][H17][H11]` |
| Saved Views | Save as View, Manage Views (reorder tabs) | Agreements/Occurrences lists (INFERENCE med: others too) | `[H11]` |
| Scope-of-change modal | Only Future (default) / All / Only Past | Recurring job edit, MA edit; archive variants | `[H10][H11]` |
| Hourglass Job Queue | Filterable, drag-to-calendar | Schedule (all views), Map | `[H2][H6]` |
| Notes field with AI **Refine** | Replace / Add Below | All notes fields, customer messages (with Translate) | `[H7][C1]` |
| Notes vs Field Notes vs Internal Notes vs Comments | Yellow highlight for internal notes on mobile; comments with notify toggles and portal sharing | Job, Estimate/Invoice, Project | `[H4][H8][H15]` |
| Files tab | Attach / Upload Photo / Take Photo (video); per-file "Can team manager see file?"; markup + compression + timestamp | Job, Estimate/Invoice, MA template, Assets, Payments | `[H8][H17][C1]` |
| Dynamic link documents | Dynamic Estimate/Invoice link, PDF, Variant Proposal, Present mode | Estimate, Invoice | `[H17][H16]` |
| Payment status badges | processing / failed / succeeded…; filterable | Invoices, Estimates, Payments, Portal | `[C1]` |
| Customizable job tile | Choose fields | Mobile Schedule list | `[H5]` |
| Dashboard widget | Configurable order/delete; column filter | Pulse Dashboard, Custom Reporting Dashboard | `[H25]` |
| Feature/plugin tile | Enable button | Company Settings > Features & Plugins | `[H37]` |
| Two-layout wizard | Single Page View ↔ Easy Flow View (stepper) | MA create | `[H11]` |
| Template variable insertion | Customer/job fields, "Your Company Name" | Email/SMS templates, custom forms | `[H11][C1]` |

---

## 6. Inferred data model

The primary source is the OpenAPI spec `[A1]`, so confidence is high where it is cited. Envelope: `{error:boolean,total_count:int,response:[…]}`. Auth: `x-api-key` header (key issued by support). Base URL: `https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage` (AWS API Gateway). List params are consistently `limit, page, sort_by, sort_dir, search, filter, sort, rel, calculate_count, asn`, where `rel` is relationship expansion, e.g. `rel[public_link]`. The `GET` response schemas are untyped ("The requested record"), so response fields beyond the POST bodies are not evidenced.

**API resources** (CRUD = GET list / POST / GET id / PUT / DELETE):

| Resource | Ops | Notable fields (POST body) + enums |
|---|---|---|
| customers | CRUD | first/last/display_name, company_name, `account_type`[individual\|company], email, alt/secondary email, phone, secondary_phone, billing_* & service_address_* (separate), has_different_billing_address, `status`[lead\|opportunity\|current customer\|lost\|other\|inactive], pipeline_status_id, lead_source_id, assigned_to, notes, job_notes, tags, customfields[{id,field_instance_id,value}], locations, notify_self_assigned |
| customers/{id}/customer-contact | CRUD | first/last_name, email, phone, notes, order |
| locations | CRUD | polymorphic `object_type`/`object_id`, title, address_1/2, city, state, zip, notes, is_main_location, is_primary_location, primary_customer_contact_id |
| jobs | CRUD | customer_id, project_id, customer_contact_id, location_id, job_type, subtitle, `type`[task\|job], `status`[1 new,2 in progress,3 pending,4 completed,5 canceled,6 on the way] or status_id + status_workflow_id, start_time, end_time, due_date, customer_arrival_window_start/end_time, notes, field_notes, billing, generate_invoice, is_template, template_id, recurring_parent_id, maintenance_agreement_id, maintenance_occurrence_id, task_category_id, assignments[{team_id, assigned_members}], visits[{status,title,subtitle,is_visible,start_time,end_time}], asset_ids, tags, customfields, qb_time_class_id, hazardco_swms_id |
| jobs/status-workflows, /status-workflow-statuses | R | custom workflow defs |
| estimates / invoices | CRUD (+ `invoices/{id}/price-update`, `qb-classes`) | Shared shape. customer_id, job_id, location_id, contract_id, author_id, company_profile_id, theme_id, title, reference, notes, internal_notes, invoiced_date, due_date, tax_rate, invoice `status`[2 draft,3 invoiced,4 paid,5 partially paid,6 void] or status_id/workflow, estimate_status, commission_type/percent, hvi, maintenance_agreement_id/occurrence_id/occurrence_date, ~15 `invoice_show_*` display toggles, `invoice_amount_due_display_type`[remaining_balance\|set_amount\|percentage_of_total\|none], invoice_pdf_title, display_settings, line_items[{line_number,line_type,line_title,line_description,line_price_visibility,line_visibility,line_quantity,is_selected,is_optional,group_number,source,pricebook_id,flat_rate_job_id,commission_amount,hvi_amount,qbo_group_item_ref,line_components}], options[{is_selected,is_default,group_number,title,description,photo_id,tab_title,line_discount}], add_on_options, optional_line_items, expenses[{amount,description,title,type}], payments[…], qbd_class_id, qbd_discount_id, qbo_sales_tax_code_id, emaildata |
| payments | CRUD | invoice_id, payment_date, amount, `method`[cash\|check\|card\|square\|bank_transfer\|other], payment_method_id, notes, square_transaction_id, qbd_discount_* |
| items | CRU (no delete) | name, `type`[service\|product\|reece-item], sku, upc, default_unit_price/cost/quantity/description, default_taxable, tax_rate, is_labor_item, is_active, track_inventory, `inventory_mode`[default\|serialized_inventory], quantity_available, unit_measure (+ per-unit cost/price, dimensional sizes), vendor_id/`vendor_type`[integrated\|third_party], supplier_item_id, auto_reorder_level, replenishment_level, minimum_order_quantity, is_automatic_replenishment_by_purchase_order_enabled, `price_update_method`[set_price_manually\|automatic_markup\|use_cmp_pricing], automatic_markup_percentage, item_price_tiers[{tier_id,adjustment_property,adjustment_value}], inventory_hub_items, serialized_inventories, item_links, QBO/Xero account ids, external_id/type/sync_status, tags, customfields |
| material-lists | CRUD + connect/disconnect/item-connect to entity | title, customer_id, author_id, notes, internal_notes, status_id/workflow, groupings[{title,type,quantity,price_visibility,component_visibility,pricebook_id,flat_rate_job_id,line_items}], assignments, tags |
| purchase-orders | CRUD | vendor_type/vendor_id/vendor_name, title, `status`[compose\|draft\|ordered\|pending\|route\|ready_for_pickup\|partially_received\|received\|completed\|canceled\|issue], `payment_status`[unpaid\|partially_paid\|paid], order_at, expected_delivery_at, received_at, customer_id, job_id, project_id, invoice_id, assigned_id, `delivery_method`[delivery\|pickup], delivery address fields, pickup_branch_id, order_number, items[{item_id,title,unit_cost,quantity,is_taxed,tax_rate,payment_status}], tax_rate |
| assets | CRUD | title, `status`[uninstalled\|installed\|retired], `asset_type`[company\|customer], customer_id, location_id, asset_category_id, maintenance_agreement_id, manufacturer, model, model_number, serial_number, model_year, install_date, warranty_expiration, labor_warranty_expiration, warranty/labor info, condition, issues, notes, job_ids, tag, is_template |
| assets-category | CRUD | title |
| projects | CRUD | customer_id, name, description, `status`[1 opportunity…7 canceled], status_id/workflow, location, start/end_time, completion_percentage, notes, job_notes |
| subtasks | CRUD | title, status(1–5), due_date, customer/job/project/recurring_job_id, description, is_template, **is_required_for_job**, assignments |
| timesheets | CRUD | user_id, `type`[general\|job], job_id, subtask_id, clock_in/out_time, `clock_in/out_method`[automatic\|manual], clock_in/out_location, notes, titles, is_historical |
| comments | CRUD | text, polymorphic commentable_id/commentable_type |
| custom-fields | CRUD | name, position, permission, is_active, `object`[customer\|job\|project\|invoice\|asset\|job_visit\|maintenance_agreement\|order], can_customer_view, field_widget_id, settings |
| tags | CRUD | `type`[customer\|job\|subtask\|invoice\|item\|flatrate_job\|user\|timesheet\|project\|order], title, color |
| contracts, users, teams, vendors, lead-source, pipeline-status, company-profile | Read-only | (fields not in spec) |
| version | R | — |

**Entities not exposed in the API but evidenced in help.**

| Entity | Evidence | Confidence |
|---|---|---|
| MaintenanceAgreement → Routine (Scheduled/On-Demand, frequency, visit allowance, allowance period, unused-visit policy, job template, generation rule, window) → Occurrence (statuses No Job / Unscheduled / Scheduled / Completed / Auto Schedule Failed; Available / Claimed / Expired) → linked Job; MA statuses Draft/Active/Canceled/Completed | `[H11][H12]` | high |
| RecurringJob (frequency, first/last occurrence, no-end → 12-month horizon) | `[H10]` | high |
| RecurringBilling (frequency, occurrence date, starting month, auto-send, default status, end method, occurrences) | `[H19]` | high |
| SiteVisit (child of job, own status/team/date, own comms triggers) | `[H7][H16][A1 visits]` | high |
| Pricebook → Category (List / GBB) → FlatRateJob (labor hours, items, markup category); AddOnList (single/multi); MarkupCategory | `[H28]` | high |
| InventoryHub (name, assigned users; 1 default deduction hub per user) | `[H24]` | high |
| Supplier (name, email, phone, notes) | `[H23][C1]` | high |
| AutomaticTrigger (event, action mode, template); MessageTemplate (email/SMS) | `[H16]` | high |
| BookingService (category, booking method, team needed, eligible users, duration, buffers, lead time, skills, windows[], items) | `[H14]` | high |
| PortalSettings (≈20 visibility toggles) | `[H15]` | high |
| StatusActionFlow (per workflow) → per-status instructions, buttons, widgets | `[H13]` | high |
| CustomForm template / instance (≤25 pages, field formulas, conditional lock/highlight, PDF overlay) | `[H36][C1]` | high |
| SavedPaymentMethod (tokenized card/ACH on customer) | `[C1]` | high |
| Customer parent/child (Bill to Parent) | `[C1]` | high |
| Engage: PhoneLine (users, managers, working hours, routing), Conversation, Call, Voicemail, Transcript/Summary | `[H27][C1]` | high |
| Commission (per document, splits by person/role, templates) | `[A4][C1]` | med |

**Relationships.**
- Customer 1–n Contacts, Locations (polymorphic), Jobs, Estimates, Invoices, Assets, MAs, Projects.
- Job n–1 Customer (immutable), n–1 Location, n–1 Project, n–m Users/Teams (assignments), 1–n Visits, n–m Assets, 1–n Subtasks, Comments, Files, Timesheets; n–1 RecurringParent; n–m MA Occurrences (a Scheduled-plan job can satisfy multiple occurrences).
- Invoice/Estimate n–1 Job (optional), 1–n Payments, n–1 Contract.
- PO links optionally to Job/Project/Invoice/Estimate.

All high confidence. `[A1][H7][H11][H23]`

**Webhooks** `[A3]`: `Job Created`, `Job Custom Status Update`, `Job Workflow Custom Status Update`, `Job Start Time Update`, `Job End Time Update`, `Estimate Created`, `Estimate (Workflow) Custom Status Update`, `Invoice Created`, `Invoice (Workflow) Custom Status Update`. There are no customer or payment webhooks. Zapier is limited to 6 triggers and 7 actions. `[A5]`

---

## 7. Feature matrix

```csv
feature,area,priority,original,notes
Customer record with service + billing address,CRM,must,yes,separate billing_* / service_address_* fields [A1]
Individual vs company account type,CRM,should,yes,account_type enum [A1]
Multiple contacts per customer,CRM,must,yes,customer-contact sub-resource [A1]
Multiple locations per customer,CRM,must,yes,polymorphic locations + main/primary flags [A1]
Customer status lifecycle (lead→current→lost/inactive),CRM,should,yes,status enum [A1]
Custom sales pipeline kanban (By Pipeline),CRM,could,yes,drag cards; latest estimate $ on card [H30]
Lead sources,CRM,should,yes,read-only via API; Engage number→lead source [A1][H27]
Customer tags + By-Tag views,CRM,should,yes,[A1][C1]
Customer custom fields,CRM,should,yes,custom-fields object=customer [A1]
Merge duplicate customers,CRM,should,yes,help article title only [A4]
Bill to Parent (parent/child accounts),CRM,could,yes,carries billing/tax/saved card [C1]
Customer price tiers,CRM,could,yes,item_price_tiers [A1][A4]
Import customers (CSV/Excel/Sheets),CRM,must,yes,[H1]
Import from QuickBooks,CRM,should,yes,[H1]
Export customers,CRM,should,yes,[A4]
Assign customer to user,CRM,could,yes,[C1]
Job creation with customer/contact/location,Scheduling,must,yes,[H7]
Task (job without customer),Scheduling,should,yes,type=task [A1][H1]
Job templates,Scheduling,should,yes,Import/Save as Template [H7]
Multi-tech + team assignment,Dispatch,must,yes,assignments{team_id,assigned_members} [A1]
Skill tags on techs + filter by skill,Dispatch,should,yes,[H7][H9][C1]
Find Availability slot suggester,Scheduling,should,yes,duration/buffers/# techs/skills [H9]
Scheduling conflict detection,Scheduling,must,yes,toggleable [H7]
Customer arrival window,Scheduling,must,yes,separate from job time [H7][A1]
Multi-day jobs + working hours,Scheduling,could,yes,[A4]
Site visits (multiple trips per job),Scheduling,should,yes,visits[] with own status [A1][H7]
Subtasks with required-for-job flag,Scheduling,could,yes,is_required_for_job [A1]
Projects (multi-job),Scheduling,could,yes,completion % [A1][H15]
Unassigned/Unscheduled jobs tab,Dispatch,must,yes,[H31]
Job Queue drag-to-schedule,Dispatch,must,yes,[H2]
Dispatch board (tech rows × time),Dispatch,must,yes,[H9]
Schedule calendar view,Scheduling,must,yes,[H6]
Schedule list view,Scheduling,should,yes,[H6]
Schedule map view (day/custom range),Dispatch,should,yes,filters by status/team; color modes [H6]
Manual route sequencing (Schedule Route),Dispatch,could,yes,click-order not optimization solver [H22]
Real tech location (last known),Dispatch,should,yes,from app activity [H2]
Live vehicle GPS on map,Dispatch,could,addon,Azuga [H35]
Duplicate dispatch checker,Dispatch,could,yes,[C1]
Recurring jobs with edit scope,Maintenance agreements,must,yes,[H10]
Maintenance agreements (routines/occurrences),Maintenance agreements,must,yes,[H11]
On-Demand visit allowance + banking,Maintenance agreements,should,yes,[H11]
Auto-generate MA jobs (unscheduled/auto-schedule/fixed),Maintenance agreements,must,yes,[H11]
Combine overlapping routines into one visit,Maintenance agreements,could,yes,[H11]
MA occurrence + renewal reminders (email/SMS),Maintenance agreements,must,yes,[H11]
MA contract e-sign,Maintenance agreements,should,yes,[H11]
Sell MA from estimate/invoice line item,Maintenance agreements,should,yes,[H11][C1]
Rename MA entity (Memberships etc.),Maintenance agreements,could,yes,[H11]
Custom status workflows per job type,Scheduling,should,yes,[H12]
Time-in-status tracking (travel/in progress),Scheduling,should,yes,[H12]
Estimates with line items,Estimates,must,yes,[H17]
Multiple estimate options (Good/Better/Best),Estimates,must,yes,option tabs [H18]
Add-on options,Estimates,should,yes,[H18]
Line-item groupings with price visibility,Estimates,should,yes,[H17][A1]
Line-item bundles,Estimates,should,yes,[H17]
Markup/margin tool,Estimates,should,yes,[H17]
Line item photos with markup,Estimates,could,yes,[H17]
Barcode scan to add item,Estimates,could,yes,[H17]
Dynamic (web) estimate link,Estimates,must,yes,[H16][H17]
Present mode (on-site),Estimates,should,yes,[H17]
Variant proposal + online accept,Estimates,could,yes,[C1]
Customer e-signature on estimate/invoice,Estimates,must,yes,[A4]
Contracts attached to documents,Estimates,should,yes,[H17]
Convert estimate to invoice,Invoicing,must,yes,[H3]
Estimate expiration + disable if expired,Estimates,should,yes,[H17][H15]
Document themes + company profiles,Invoicing,could,yes,multi-brand [A1][A4]
Invoice display toggles (qty/price/sku/tax),Invoicing,should,yes,invoice_show_* [A1]
Amount-due display (balance/%/set),Invoicing,could,yes,deposit/progress billing [A1]
Partial/progress payments + deposits,Invoicing,must,yes,[A4]
Automatic deposit invoices,Invoicing,could,yes,[A4][C1]
Lock edits at milestones,Invoicing,should,yes,[C1]
Auto tax rates,Invoicing,should,yes,[A4]
Recurring billing,Invoicing,must,yes,[H19]
Failed card auto-retry (D0/3/7/14),Payments,should,yes,[H19]
Expenses on invoice,Invoicing,could,yes,[A1]
Job costing / profitability,Invoicing,should,yes,cost basis view [A4]
Commissions incl. splits,Invoicing,could,yes,[A4][C1]
Card + ACH processing,Payments,must,addon,FieldPulse Payments [H20]
Email payment request link,Payments,must,addon,[H20]
Tap to Pay on iPhone,Payments,should,addon,[C1]
Card scan/swipe in mobile,Payments,should,addon,[H20]
Save payment method on file,Payments,should,addon,[C1]
Card fee recovery (surcharge),Payments,could,addon,[H20]
Next-day funding,Payments,could,addon,[H20]
Mark manual payment (cash/check),Payments,must,yes,[H4]
Refunds + chargebacks,Payments,should,addon,[A4]
Consumer financing (Wisetack/Acorn),Payments,could,addon,[A4]
Real-time payment status badges,Payments,should,yes,[C1]
Item list (service/product),Pricebook,must,yes,[A1]
Flat-rate pricebook with labor+overhead,Pricebook,should,addon,Sales Suite [H28]
Markup categories,Pricebook,should,addon,[H28]
Good/Better/Best pricebook categories,Pricebook,should,addon,[H28]
Pricebook import,Pricebook,should,addon,[A4]
Dimensional pricebook,Pricebook,could,addon,[A4]
Supplier catalog pricing (Reece/Winsupply),Pricebook,could,yes,[A4]
Inventory tracking on items,Inventory,should,yes,track_inventory [A1]
Multiple inventory hubs (trucks),Inventory,should,yes,[H24]
Serialized inventory,Inventory,could,yes,[A1][H24]
Auto-deduct on invoice + auto-replenish PO,Inventory,could,yes,[H24][H23]
Inventory counts + audit reports,Inventory,could,yes,[A4]
Purchase orders with statuses,Inventory,should,yes,11 statuses [A1]
Supplier management,Inventory,should,yes,[C1]
Receiving labels,Inventory,could,yes,[C1]
Material lists,Inventory,could,yes,[A1]
Mobile schedule (list/calendar/dispatch/map),Mobile tech,must,yes,[H5]
Mobile job status updates,Mobile tech,must,yes,[H8]
Navigate to location,Mobile tech,must,yes,[H8]
Photos/video/files on job,Mobile tech,must,yes,[H8]
Field notes vs internal notes,Mobile tech,should,yes,[H4]
Job comments with notify toggles,Mobile tech,should,yes,[H8]
Offline mode (1-week cache; 50 photos),Mobile tech,must,yes,no offline payments/new records [H4]
Custom forms/checklists,Mobile tech,should,addon,[H36]
PDF form overlay (state forms),Mobile tech,could,addon,[H36]
ClearPath guided status flows,Mobile tech,should,yes,included [H13]
Customizable job tile,Mobile tech,could,yes,[H5]
Spanish mobile app,Mobile tech,could,yes,enabled per user by support [C1]
Timesheets general + job,Mobile tech,must,yes,[H29]
GPS geostamp clock in/out,Mobile tech,should,yes,[H26]
Status-triggered clock prompts,Mobile tech,could,yes,[H29]
Backdated time entries,Mobile tech,should,yes,[H29]
Automatic triggers (job/estimate/invoice/payment),Comms,must,yes,[H16]
On-the-way text,Comms,must,yes,status trigger [H12]
Email/SMS templates with merge fields,Comms,must,yes,[H16][C1]
Manual send customer communication,Comms,must,yes,[H8]
Attach files to communications,Comms,should,yes,[C1]
Two-way SMS inbox,Comms,must,addon,Engage [H27]
Business phone numbers + porting,Comms,should,addon,Engage [H27]
Call routing / IVR / sequential ring,Comms,should,addon,[H27]
Call recording + AI transcripts/summaries,Comms,should,addon,[H27][C1]
Link calls to jobs/invoices,Comms,could,addon,[C1]
AI phone agent booking jobs,Comms,could,addon,Operator AI [H34]
Web chat AI,Comms,could,addon,Chat AI [P1]
Review requests (NiceJob/reviews & referrals),Comms,should,yes,[A4][C1]
AI assistant (Maverick) NL search/create,Automations,could,yes,[C1]
AI Refine/translate for notes and messages,Automations,could,yes,[C1]
Pulse dashboard widgets,Reporting,must,yes,[H25]
Custom reporting dashboard,Reporting,should,yes,[A4]
Raw data reports (26 types),Reporting,should,yes,[A4]
Relative-date filters + time-in-status reports,Reporting,could,yes,[C1]
Franchise roll-up/royalty reporting,Reporting,could,yes,[A4]
QuickBooks Online two-way sync,Integrations,must,yes,request via support [H32][H33]
QuickBooks Desktop sync,Integrations,should,yes,[A4]
Xero sync,Integrations,could,yes,[A4]
Zapier,Integrations,could,yes,6 triggers/7 actions [A5]
Public REST API,Integrations,could,yes,key via support [A1]
Webhooks (job/estimate/invoice),Integrations,could,yes,no customer/payment events [A3]
Lead marketplaces (Angi/Thumbtack),Integrations,could,yes,[A4][C1]
CompanyCam / Google Calendar,Integrations,could,yes,[A4]
Fleet GPS (Azuga),Integrations,could,addon,[H35]
Roles (Admin/TM/Service/Limited/Assignment),Settings/permissions,must,yes,[H26]
Per-user permission toggles + templates,Settings/permissions,should,yes,[H26][C1]
Schedule visibility settings,Settings/permissions,should,yes,[H9]
Features & Plugins switchboard,Settings/permissions,should,yes,[H37]
Google SSO + 2FA,Settings/permissions,should,yes,[A4]
Configurable job numbering,Settings/permissions,could,yes,Next Job # [H7]
Customer portal (jobs/estimates/invoices/payments/assets),Customer portal,must,yes,[H15]
Portal visibility toggles (~20),Customer portal,should,yes,[H15]
Accept estimates in portal,Customer portal,must,yes,[H15]
Pay invoices online,Customer portal,must,addon,[H20]
Booking portal (iframe),Customer portal,should,yes,[H14]
Smart Scheduler (real availability),Customer portal,should,yes,[H14]
Booking deposits/full prepay,Customer portal,could,addon,needs Payments [H14]
Trip tracking customer view,Customer portal,could,yes,article title only [A4]
```

---

## 8. What cannot be cloned (or not cheaply)

| Item | Why | Source |
|---|---|---|
| FieldPulse Payments rails | Merchant underwriting, next-day funding, card fee recovery, Tap to Pay on iPhone (Apple entitlement), monthly statements, chargebacks. Uses a payment processor relationship; CardConnect is mentioned by a reviewer. You'd need Stripe Terminal / Stripe Connect or similar | `[H20][C1][P6]` |
| Engage telephony | Number purchase/porting, 10DLC brand/campaign registration, SIP/Yealink desk phones, call recording. This is carrier/CPaaS-backed (provider not disclosed; INFERENCE med: a Twilio/Telnyx-class CPaaS) | `[H27]` |
| Operator AI | A separate product (webai.fieldpulse.com). The voice-AI vendor stack is undisclosed | `[H34]` |
| Fleet tracking hardware | Azuga reseller partnership (GPS datalogger, Surfsight dashcams) | `[H35]` |
| QuickBooks Online/Desktop integration | Intuit app listing/partner status, QBD Web Connector-style sync, Canadian dual-tax handling. Buildable, but certification and maturity take time | `[H32][A4]` |
| Supplier integrations | Reece maX/US (CMP pricing, branch quotes, credit notes), City Electric Supply, The Granite Group, Winsupply costbook: B2B partnerships | `[A4]` |
| Financing | Wisetack / Acorn / FieldPulse Capital lender partnerships | `[A4]` |
| Lead/marketing partner feeds | Angi, Thumbtack, HighLevel, Marketing 360, NiceJob, Ruby Receptionist, HazardCo, Trinity Warranty | `[A4]` |
| Review-site social proof | 2,537 reviews, G2 badges | `[P2]` |

The rest is cloneable software.

---

## 9. What FieldPulse users complain about (the "do better" list)

G2/Capterra direct pages were blocked. The Capterra quotes are reproduced by `[P6]`/`[P5]` with reviewer attribution; verify on capterra.com/p/153475/FieldPulse/reviews before publishing externally.

| # | Quote (verbatim) | Who / where | Link | Theme |
|---|---|---|---|---|
| 1 | "Software has many bugs. Always crashing and losing customer data." | Chris1234c3h, App Store, 2024-05-02 | [P7](https://apps.apple.com/us/app/fieldpulse/id1575955293?see-all=reviews) | reliability |
| 2 | "They essentially decided it's going to be a desktop only tool and now I can't find any Client records whatsoever" | Ifiwereabravo, App Store, 2025-02-28 | [P7](https://apps.apple.com/us/app/fieldpulse/id1575955293?see-all=reviews) | mobile regressions |
| 3 | "my techs and feel that comments and field notes should be editable." | CoolTechMech, App Store, 2023-12-28 | [P7](https://apps.apple.com/us/app/fieldpulse/id1575955293?see-all=reviews) | field UX |
| 4 | "there doesn't seem to be an easy way to see the duration of a job like in the old app." | MegaUltra, App Store, 2022-03-14 | [P7](https://apps.apple.com/us/app/fieldpulse/id1575955293?see-all=reviews) | redesign regressions |
| 5 | "Fundamentally flawed database from the ground up. Look elsewhere" | TexasChic12, App Store | [P7](https://apps.apple.com/us/app/fieldpulse/id1575955293?see-all=reviews) | data model |
| 6 | "Field pulse could care less about your success. They are only in it to take your money." | Jeremias Velis, App Store, 2025-05-30 | [P7](https://apps.apple.com/us/app/fieldpulse/id1575955293?see-all=reviews) | vendor trust |
| 7 | "This company uses high pressure sales tactics, lies, and deception to get you to sign a 1 year contract. Beware!!!" | Tyler Giordani, Trustpilot, 2026-09-01 | [P8](https://www.trustpilot.com/review/fieldpulse.com) | contract lock-in |
| 8 | "I rarely leave negative reviews, but I feel other small business owners deserve to know about my experience." (held to ~1 yr of payments after stopping implementation) | Webster Plumbing, Trustpilot, 2026-07-06 | [P8](https://www.trustpilot.com/review/fieldpulse.com) | contract lock-in |
| 9 | "quite a few glitches- such as line items and customers randomly getting deleted, long processing times" | Kaylah G., Admin Asst, Capterra 3/5 | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | data integrity |
| 10 | "The system is clunky, with poor interconnection between components" | Sherilynne D., Owner, Capterra | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | cohesion |
| 11 | "Moving from Estimates to Jobs to Invoices still feels a bit disjointed." | Andrew Z., Ops Manager, Capterra 4/5 | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | core-loop flow |
| 12 | "an unsustainable $1,500 transaction limit on CardConnect that fails to accommodate our $5,000+ invoices." | Stanley K., Plumber, Capterra | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | payments limits |
| 13 | "We still haven't quite been able to successfully sync FieldPulse with Quickbooks Online" | Jessica V., Managing Partner, Capterra 5/5 | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | QBO sync |
| 14 | "The QuickBooks Desktop integration is a nightmare. Duplicate entries, sync failures," | Capterra reviewer, 2025 | [P5](https://fieldcamp.ai/reviews/fieldpulse/) | QBD sync |
| 15 | "Marketing makes the software seem top-tier but doesn't disclose you need add-ons for basic functionality" | Capterra reviewer, Oct 2025 | [P5](https://fieldcamp.ai/reviews/fieldpulse/) | add-on pricing |
| 16 | "Very expensive when you compare to what you get." | Abraham S., CEO, Capterra 1/5 | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | price |
| 17 | "It seems to be slow moving recently and this causes a lot of frustration when trying to complete information on our jobs." | Julie S., Service Coordinator, Capterra 4/5 | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | performance |
| 18 | "There is a gap in terms of information tracking vs the biggest players in the space." | James W., Owner, Capterra 5/5 | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | depth |
| 19 | "The lack of payroll functions is about the only issue I have with Field Pulse." | Lisa B., Office Staff, Capterra 5/5 | [P6](https://fervorstudio.ca/news/fieldpulse-review-pricing-alternatives/) | payroll |

**Structural "do better" items found in the docs themselves** (high confidence, each sourced):
1. "Route optimization" is just manual click-ordering with fixed default durations, not a solver. `[H22]`
2. The customer on a job is immutable, and jobs can't be deleted. `[H7]`
3. Editing a recurring series silently overwrites per-occurrence edits. `[H10]`
4. The API key, QBO access, Pricebook, Custom Forms and Spanish all require contacting support. `[A2][H33][H28][H36][C1]`
5. Webhooks only cover job/estimate/invoice; there are no customer or payment events. `[A3]`
6. The initial QBO sync takes days to weeks. `[H33]`
7. No offline payments or offline record creation. `[H4]`
8. Without Engage, automated SMS comes from a no-reply toll-free number, so there is no two-way thread. `[H16]`
9. Customers can't self-claim membership visits in the portal. `[H11]`
10. Maintenance-agreement activation is an async multi-minute job with a "don't touch anything" loading page. `[H11]`
11. The 1-year non-refundable contract plus seats that can't be reduced drives most 1-star reviews. `[P3][P8]`
