/** Pure checks behind scripts/agent/mobile-audit.mjs (390 px audit). */

export const MIN_TAP_PX = 44;
// Layout rounds to fractions; 43.6 renders as a 44 px target.
const ROUNDING_SLACK = 0.5;

export type AuditTarget = { selector: string; w: number; h: number };
export type AuditMeasurement = {
  scrollWidth: number;
  viewport: number;
  targets: AuditTarget[];
};
export type Finding = {
  kind: "overflow" | "tap-target";
  selector?: string;
  detail: string;
};

export function auditFindings(m: AuditMeasurement): Finding[] {
  const findings: Finding[] = [];
  const over = Math.round(m.scrollWidth - m.viewport);
  if (over > 0) {
    findings.push({
      kind: "overflow",
      detail: `${over}px wider than the ${m.viewport}px viewport`,
    });
  }
  for (const t of m.targets) {
    if (t.w < MIN_TAP_PX - ROUNDING_SLACK || t.h < MIN_TAP_PX - ROUNDING_SLACK) {
      findings.push({
        kind: "tap-target",
        selector: t.selector,
        detail: `${Math.round(t.w)}×${Math.round(t.h)} is under ${MIN_TAP_PX}×${MIN_TAP_PX}`,
      });
    }
  }
  return findings;
}
