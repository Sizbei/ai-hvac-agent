# Page program — method

The pipeline every page runs through. Author: autonomous overnight run started
2026-08-11.

```
brainstorm + spec  →  adversarial review (specs)  →  fix specs
      →  implementation plan  →  adversarial review (plans)  →  fix plans
      →  subagent-driven development  →  gates
      →  adversarial review (finished code)  →  fix
```

## Page inventory

The 30 pages tracked by `.claude/skills/page-<slug>/SKILL.md`. The skill is the
*current-state* record (files, data flow, invariants, gotchas). The spec in this
program is the *target-state* record (what the page must be, and the gap).

## Spec contract

Every `specs/<slug>.md` has exactly these sections, in order:

1. **Purpose** — the one job the page does, and for whom.
2. **Brainstorm** — what a great version of this page does. Includes ideas
   considered *and rejected*, each with a one-line reason. YAGNI is enforced
   here, not later.
3. **Current state** — evidence-grounded. Every claim cites `file.ts:line`.
   Claims are tagged `verified` (read the code) or `inferred`.
4. **Gaps** — table of gap → severity (`P0` broken/wrong, `P1` workflow hole,
   `P2` polish) → evidence.
5. **Requirements** — numbered `R<slug>-N`, each with a testable acceptance
   criterion. Only gaps worth fixing become requirements.
6. **Non-goals** — what this spec deliberately does not do, with reasons.
7. **Invariants** — what must not break (inherited from the page skill and
   `admin-pages`), each with the reason it exists.
8. **Verification** — the exact commands and screenshots that prove the
   requirements are met.

## Severity gate

Only `P0` and `P1` gaps become implementation work in this run. `P2` items are
recorded in the spec and left in the backlog table in `README.md`.

## Review contract

Adversarial review per `~/.claude/skills/adversarial-review`:

- Fresh, blind critics each round; lenses are genuinely different.
- Every blocker/major quotes the exact offending line from the artifact.
- Findings tagged `verified` / `inferred`, severity `blocker` / `major` /
  `minor`. Only blocker/major gate sign-off.
- The reviser rejects wrong findings with a one-line reason rather than
  complying performatively.
- Stop at clean sign-off, diminishing returns, or the round cap. Never fake a
  sign-off.

Round records land in `reviews/`.

## Gates (non-negotiable, from AGENTS.md)

- `npx tsc --noEmit` → 0
- `npx eslint <changed>` → 0 errors
- `npx vitest run` → must not drop below the live baseline captured at the start
  of the run (recorded in `README.md`)
- No jsdom/RTL. Pure-helper vitest only.
- Page skills updated in the same commit when files/flows/invariants change,
  then `node scripts/agent/verify-skills.mjs` → 0 missing.
