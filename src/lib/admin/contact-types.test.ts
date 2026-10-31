import { describe, it, expect } from "vitest";
import { contactInputSchema, contactPatchSchema } from "./contact-types";

describe("contactInputSchema", () => {
  it("sanitises name, phone and email", () => {
    const r = contactInputSchema.safeParse({ name: "  jane   DOE ", phone: "(423) 555-0100", email: " Jane@Example.com " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Jane Doe");
      expect(r.data.phone).toBe("(423) 555-0100");
      expect(r.data.email).toBe("jane@example.com");
    }
  });
  it("rejects a 7-digit phone, a bad email and a missing name", () => {
    expect(contactInputSchema.safeParse({ name: "Jane", phone: "555-0100" }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: "Jane", email: "nope" }).success).toBe(false);
    expect(contactInputSchema.safeParse({ phone: "4235550100" }).success).toBe(false);
  });
});
describe("contactPatchSchema", () => {
  it("leaves omitted fields undefined (so PATCH {isPrimary:true} clears nothing)", () => {
    const r = contactPatchSchema.safeParse({ isPrimary: true });
    expect(r.success).toBe(true);
    if (r.success) { expect(r.data.phone).toBeUndefined(); expect(r.data.email).toBeUndefined(); expect(r.data.role).toBeUndefined(); }
  });
  it("accepts null to clear a field", () => {
    const r = contactPatchSchema.safeParse({ phone: null });
    expect(r.success && r.data.phone === null).toBe(true);
  });
});
