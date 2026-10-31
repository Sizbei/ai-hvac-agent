# Design: component specs for the replica

`replica-design` is mostly already done: the 2026-08 "shop floor instrument"
system in `src/app/globals.css` (tokens), `src/components/admin/ui/`
(primitives) and `src/lib/admin/status-colors.ts` (status → class maps) is
the design system the clone composes from. Direction and tokens:
`docs/redesign-2026-08/DIRECTION.md`. Nothing from FieldPulse or
ServiceTitan is copied: no colours, icons, fonts or copy. What this file
adds is the spec for the components the recon map needs that the system
does not have yet. Each is composed from the primitives and tokens; no raw
hex or pixel values in components.

Rules carried over: hue-95 neutrals only, hairline structure not shadows,
13px dense chrome, every number in mono, one accent (`marker`) plus
`signal` for alerts, sentence case, no `err.message` in UI copy.

## Status kinds → tokens (extends `status-colors.ts`)

The canonical kinds from `architecture.md` map onto the existing token
roles so the board, the status bar and the badges agree.

| kind | badge classes (existing pattern) | dot | meaning |
| --- | --- | --- | --- |
| new / pending | `bg-warning-light text-warning-strong border-warning-border` | `bg-warning` | needs a dispatcher |
| scheduled | `bg-marker-light text-marker-strong border-marker-border` | `bg-marker` | on the board, not confirmed |
| confirmed | `bg-marker-light text-marker-strong border-marker` (strong border) | `bg-marker-strong` | customer confirmed |
| travel (en route) | `bg-info-light text-info-strong border-info-border` | `bg-info` | tech driving |
| arrived / in progress | `bg-success-light text-success-strong border-success-border` | `bg-success` | tech on site, working |
| pause | `bg-warning-light text-warning-strong border-warning-border` (dashed) | `bg-warning` | meal, parts run |
| hold | `bg-muted text-muted-foreground border-border` (dashed) | `bg-muted-foreground` | waiting on parts/customer |
| complete / done | `bg-success-light text-success-strong border-success-border` (filled) | `bg-success` | closed out |
| cancel | `bg-muted text-muted-foreground border-border` (strikethrough label) | `bg-muted-foreground` | cancelled |
| non-job | `bg-surface-sunken text-foreground-faint border-border` (hatched) | — | PTO, meeting |
| alert overlay | `ring-1 ring-signal` on any of the above | — | running late, unconfirmed within 2h |

M0a adds `en_route` and `arrived` to the existing `REQUEST_STATUS_BADGE` /
`_DOT` maps in `status-colors.ts` (travel = info, arrived = success);
assignments reuse the same maps because they share the enum. The
"kind" column above is the design vocabulary; the data vocabulary is the
`request_status` enum (no workflow rows until M6+).

## M0 components (small)

### Tag chip picker (S04, S07, S08)
- Inline chip row (`icon-chip`, colour from the tag's token) + an "Add tag"
  popover listing the org's active tag types for that entity, with a search
  box and a "New tag" row that creates inline (name + colour token).
- Remove with the chip's ×; keyboard: Backspace on a focused chip removes.
- Board visibility: chips with `visible_on_board` render on calendar cards,
  max 2 then `+n`.

### Contacts editor (S04)
- `section-list-item` rows: name, role muted, phone/email in mono, a
  "Primary" chip, preference icons (no text, reminders, invoices) as muted
  toggles; row menu: edit, make primary, remove.
- Add/edit as a small dialog: name, role, phone, email, the three
  preferences; same sanitisers as the customer form.

### Job-type row editor (S28 settings)
- `data-table-shell`: name (editable), kind (select of the enum, shown in
  sentence case), default duration (mono, minutes), default priority,
  active toggle, drag handle for order. Inline add row at the bottom.
- Deactivating a type keeps old jobs; the picker hides inactive types.

### Time-off editor (S13, technician page)
- List of upcoming shifts grouped by kind with date range in mono; "Add"
  opens a dialog: kind (on call / time off / non-job event), title, start,
  end, "Removes capacity" toggle (on by default). Repeating PTO is entered
  as a date range, which creates one row per day.

## Components

### Appointment bubble (S09, S10, S11 pins, S37 tiles)
- Container: `rounded-md border` with the kind's badge classes; height from
  duration on the grid, min 28px; `text-[13px]`.
- Rows: line 1 customer last name + job type (truncate); line 2 street +
  ZIP in mono; optional tag chips (max 2, then `+n`).
- Decorations: lead icon when multi-tech; `ring-signal` when late or
  unconfirmed; dashed border for pause/hold; hatched background for non-job.
- States: default, hover (raise to `surface-raised`, show time range),
  dragging (opacity 70%, `cursor-grabbing`), invalid drop target
  (`border-danger-border`), locked (lock icon, no grab cursor; working/done).
- Keyboard: focusable; Enter opens the flyout; arrow keys move 15 min / one
  tech row; Escape cancels a move.

### Jobs tray (S10)
- `tab-group` across the top with counts in mono: Unassigned (default),
  Alerts, Scheduled, Unconfirmed, Dispatched, Working, Paused, Done, Hold,
  Cancelled, Future.
- Body: `data-table-shell` rows; each row is draggable onto the grid, with
  a "Holding area" strip above the table for bubbles pulled off the grid.
- Column chooser (popover) persisted per user in `saved_views`.
- Empty state per tab: `empty-state` ("Nothing unassigned. Every job today
  has a technician.").
- Pops out into its own window via a button (window.open to a `/admin/
  dispatch/tray` route that renders only the tray).

### Arrival-window prompt (S10 drag)
- Dialog (`surface-raised`), title "Arrival window", three radio options:
  keep the window, match the window to the new time, choose a window
  (select of the org's windows). Default: match when the move crosses the
  window boundary, keep otherwise.
- Buttons: primary "Move job", ghost "Cancel". Escape cancels the move and
  snaps the bubble back.

### Status bar with time-in-status (S08, S38)
- Horizontal segmented bar: one segment per workflow status in order; the
  current one filled with its kind colour; past ones muted; elapsed time per
  segment in mono underneath ("travel 12m · on site 1h 05m").
- Click a reachable segment to advance (admin) or use the big action
  buttons (tech). Terminal transitions confirm.

### Find-availability panel (S07, S36, chat)
- Parameters row: duration, buffer, earliest day, skills, technician(s).
- Results: day headers, then window chips (`icon-chip`) with capacity in
  mono ("Morning · 3 open"); disabled chip when 0 open; `signal` outline
  when exceeding ideal booking %.
- Selecting a chip fills the form; "Suggest times" button for the
  auto-pick; manual grid behind a "Pick manually" toggle.

### Customer picker with inline create (S07, S16, S41)
- Combobox: type name / phone / address; results group by customer, with
  locations indented; recent customers when empty.
- Duplicate guard: when creating and a match exists on phone or email,
  show an `info-banner` "Looks like an existing customer" with a switch
  link.
- Inline create: name, phone, email, address fields appear below when "New
  customer" is chosen.

### Add-item side panel (S16, S19, S40)
- Right slide-over (`surface-raised`, hairline left border), width 420px
  desktop, full-width mobile.
- Search box, category browse (tree, `section-list-item`), result rows with
  name, code in mono, price in mono, member price muted.
- Buttons: "Add" (closes), "Add and next" (keeps open), "New line" for a
  one-off line.

### Line-item table (S16, S19, S22)
- `data-table-shell`; drag handle, name (editable), qty, unit price, total
  (mono, right-aligned); per-row eye (customer visibility), pencil, trash.
- Groupings: a header row with a name and a subtotal; collapsible.
- Option tabs above the table (`tab-group`): one per option, rename inline,
  duplicate, delete, "Recommended" star.
- Locked state: inputs read-only, lock icon in the header with the reason
  ("Locked when sent. Duplicate to edit.").

### Option presenter (S17, S39, S35)
- One card per option, side by side on desktop, stacked on mobile; the
  recommended one gets the `marker` border and a "Recommended" chip.
- Each card: title, description, line summary (expandable), total in mono,
  savings line when member pricing applies, "Choose" button.
- Below: signature pad (canvas, hairline border, "Clear"), deposit line,
  "Accept and sign" primary button. Signed state replaces the pad with the
  signature image, name, time; immutable.

### Payment sheet (S20, S40, S35)
- Method segmented control: Card, Bank, Pay link, Cash, Check.
- Card: Stripe Elements in a `surface-raised` box; Check: number field;
  Cash: amount only; Pay link: channels (SMS/email) with a preview.
- Amount field defaults to balance; deposit toggle; processing state
  disables the sheet with a progress bar; failed shows the human reason
  ("The card was declined. Try another card.").

### Close-out sheet (S38)
- Bottom sheet on mobile, dialog on desktop. Four large buttons with
  icons: "Done", "Pause", "Hold" (opens reason select), "Schedule another
  visit" (opens the availability panel).
- Blocked state: the list of what is still required (forms not submitted,
  another technician not done) above greyed buttons.

### Follow-up drawer (S33, S03)
- Right slide-over: outcome segmented control (not attempted, unreachable,
  contacted, won, dismissed), template select, next date, notes, "Copy to
  customer notes" checkbox, "Log" primary, "Book now" secondary when the
  entity is bookable.

### Trigger row (S30)
- Table row: event (select), condition (inline chips that open a popover),
  offset, action mode (segmented), channel, template, active toggle,
  "Test" button that renders the template with a sample record.

### Capacity cell (S12)
- Grid cell: open / total hours in mono ("5.5 / 8h"), fill bar
  (`progress-bar`) coloured by ratio, `signal` outline when over the
  threshold, tooltip lists techs and whether each has the required skills.

### Saved views (S06, S14, S18, S26)
- `tab-group` row above a list: default tabs plus user tabs; "Save as
  view" in the filter bar; "Manage views" dialog to rename, reorder, share.

### Feature tile (S27)
- `section-card` grid: icon, name, one-line purpose, enable toggle; gated
  tiles show the gate ("Needs a Stripe connection").

## Contrast

Every text/background pair above uses existing token pairs that the
redesign checked (`docs/redesign-2026-08/LEDGER.md`). New pairs introduced
here: `text-info-strong` on `bg-info-light` and `ring-signal` on badge
backgrounds; run `python3 .claude/skills/replica-design/contrast.py` on a
`tokens.json` export of `globals.css` before M2 ships.
