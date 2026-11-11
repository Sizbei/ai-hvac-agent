import { readFileSync } from "node:fs";

/**
 * Replaying a hand-written migration on the shared DEV database without opening
 * a window other suites (running in parallel) can see: a DROP TRIGGER runs in
 * one transaction with the CREATE TRIGGER after it, so the trigger is never
 * missing. Each unit touches one table at most, so units can't deadlock.
 */

/** The migration's statements, split on `--> statement-breakpoint`. */
export function migrationStatements(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

const code = (statement: string) => statement.replace(/--[^\n]*/g, "").trim();

export const isFunction = (statement: string) => code(statement).startsWith("CREATE OR REPLACE FUNCTION");

/** Statements grouped into units: a DROP TRIGGER with the statement after it, everything else alone. */
export function replayUnits(statements: readonly string[]): string[][] {
  const units: string[][] = [];
  for (const statement of statements) {
    const last = units[units.length - 1];
    if (last && last.length === 1 && code(last[0]).startsWith("DROP TRIGGER")) last.push(statement);
    else units.push([statement]);
  }
  return units;
}
