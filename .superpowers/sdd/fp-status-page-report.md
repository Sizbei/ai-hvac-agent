# SDD Report — FieldPulse Import Status Page

## 1. Flush Mechanism

The mid-run count flush lives in `src/lib/integrations/fieldpulse/import/run-import.ts` and `customers.ts`.

During a phase run, processed counts (`fetched`, `created`, `updated`, `skipped`, `errors`, optional `total`) are accumulated in a mutable `PhaseResult` object handed to the phase fn. While the phase executes, a wall-clock `setInterval` fires every **2000 ms** and best-effort UPDATEs the run row's `counts` jsonb from that accumulator:

- The flush writes **only** `counts` — never `status`/`finishedAt` — so a late-landing flush can never revert a completed/failed row.
- The write is fire-and-forget with `.catch(() => {})`: a transient DB failure never aborts the import.
- `clearInterval` sits in a `finally` wrapping both the success and failure paths, so the timer is cleared exactly once no matter how the phase ends.
- The terminal counts are persisted by the existing completion/failure UPDATEs (which set status + finishedAt alongside counts).

`counts.total` is set by the customers phase (`counts.total = totalCount ?? null` right after `listCustomers` returns); phases without a known total leave it unset, which the UI renders as an indeterminate bar.

## 2. Presenter Behaviors (`import-status-model.ts`)

| Function | Inputs | Output | Notes |
|---|---|---|---|
| `latestRunPerPhase(runs)` | `readonly FpImportRunSummary[]` | `Partial<Record<string, FpImportRunSummary>>` | Iterates the canonical `PIPELINE_PHASES` order. For each phase, filters runs by phase name and picks the one with the lexicographically-largest `startedAt` ISO string (newest). Returns undefined for phases with no runs. |
| `progressPct(counts)` | `FpRunCounts` | `number \| null` | Returns null if `counts.total` is null/0 (unknown total → indeterminate bar). Otherwise computes `(created + updated + skipped + errors) / total * 100`, capped at 100. |
| `formatElapsed(startedAt, endedAt?)` | two ISO strings; endedAt optional/null | human string | Defaults `endedAt` to `now` when null/undefined (so live elapsed for running phases). Returns `"0s"` for non-positive elapsed, `"Xs"` for < 60 s, `"Xm Ys"` otherwise. |
| `runTone(status)` | status string | `RunTone` | Maps `running → 'info'`, `completed → 'positive'`, `failed → 'destructive'`, anything else → `'muted'`. |

## 3. Page Structure (`/admin/fieldpulse-import`)

**File:** `src/app/admin/(dashboard)/fieldpulse-import/page.tsx`

- `'use client'` page; polls via `useFpImportStatus()` (2.5 s when a run is active, 10 s otherwise).
- **Loading skeleton**: while `isLoading && runs.length === 0`, renders four `animate-pulse` skeleton cards instead of the phase grid, avoiding a jarring empty state on first load.
- **Phase cards (grid)**: `sm:grid-cols-2 xl:grid-cols-4` — one card per phase in pipeline order (`technicians → customers → jobs → invoices`).
  - Each card shows: phase name + `StatusChip`, optional `ProgressBar`, `TalliesRow` (fetched/created/updated/skipped/errors), `ElapsedTime`, and any error string.
  - Phases with no runs yet show "No runs yet" copy.
- **StatusChip** (local function): single-text-node `<span>`, `animate-pulse` when running, `motion-reduce:animate-none` applied.
- **ProgressBar** (local function): determinate bar (width transition with `cubic-bezier(.23,1,.32,1)`, `motion-reduce:transition-none`) when `total` is known; `animate-pulse` indeterminate bar when running without a known total; hidden otherwise.
- **TalliesRow** (local function): five counts in `tabular-nums` flex row; errors cell turns `text-destructive font-medium` when > 0.
- **ElapsedTime** (local function): 1-second `setInterval` tick while `isRunning` so the elapsed string updates live without waiting for a network poll; interval is cleared on unmount or when run stops.
- **RecentRunsTable** (local function): full history table with columns Phase / Status / Fetched / Created / Errors / Started / Duration. `tabular-nums` on all numeric columns. Empty state shows a dashed-border placeholder.
- Type cast boundary: `rawRuns as readonly FpImportRunSummary[]` with a one-line comment — bridges `FpImportRun.counts: Record<string,unknown>` from the hook to the presenter's typed `FpRunCounts`.

## 4. Sidebar Placement

**File:** `src/components/admin/sidebar.tsx`

- Added `Download` to the lucide-react import block.
- Added `{ label: 'FP Import', href: '/admin/fieldpulse-import', icon: Download }` as the **second item** of the `Integrations` group (after the existing `Integrations` item, as specified).

## 5. Verify Results

### Vitest
```
✓ 14 test files passed, 260 tests passed
```

### TypeScript (`tsc --noEmit`)
```
0 errors, 0 warnings
```

### ESLint
```
1 warning (pre-existing, in src/hooks/use-fp-import-status.ts, line 58:
  "Avoid calling setState() directly within an effect" — react-hooks/set-state-in-effect)
0 errors
```
The warning is in the Task 2 hook (not Task 4 code) and was present before this task.

### `next build`
```
✓ Compiled successfully in 8.8s
✓ 124/124 static pages generated
Route /admin/fieldpulse-import appears in build output as ƒ (dynamic)
Build: PASS
```
