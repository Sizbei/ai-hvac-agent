import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { EFFECTIVE_CREATED_AT_SQL } from "./estimate-effective-date";

describe("EFFECTIVE_CREATED_AT_SQL", () => {
  it("guards the jsonb timestamp cast so a malformed value falls through to created_at", () => {
    const text = new PgDialect().sqlToQuery(EFFECTIVE_CREATED_AT_SQL).sql.replace(/\s+/g, " ").trim();
    expect(text).toContain(`CASE WHEN pg_input_is_valid("estimates"."fieldpulse_data"->>'created_at', 'timestamp')`);
    expect(text).toMatch(/END, "estimates"\."created_at" \)$/);
  });
});
