import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTemplates } from "./seeds";

const sqlText = readFileSync(
  join(process.cwd(), "drizzle/0053_m3b_backfill.sql"),
  "utf8",
);

describe("invoice_sent_sms default template", () => {
  const tpl = defaultTemplates.find((t) => t.key === "invoice_sent_sms");

  it("exists with the M3b trigger, type and priority", () => {
    expect(tpl).toBeDefined();
    expect(tpl?.triggerType).toBe("invoice_sent");
    expect(tpl?.templateType).toBe("sms");
    expect(tpl?.priority).toBe(50);
  });

  it("body matches the literal seeded by migration 0053", () => {
    const m = sqlText.match(/'invoice_sent_sms', '[^']*', '[^']*', 'invoice_sent'::communication_trigger_type, 'sms'::communication_template_type, NULL, '([^']*)', '(\{[^']*\})'::jsonb/);
    expect(m).not.toBeNull();
    expect(tpl?.bodyTemplate).toBe(m![1]);
  });

  it("variables match the migration's jsonb", () => {
    const m = sqlText.match(/NULL, '[^']*', '(\{[^']*\})'::jsonb/);
    expect(m).not.toBeNull();
    expect(tpl?.variables).toEqual(JSON.parse(m![1]));
  });
});
