import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./provider", () => ({ getPaymentProvider: vi.fn() }));

import { getPaymentProvider } from "./provider";
import { cardPaymentsEnabled } from "./card-enabled";

describe("cardPaymentsEnabled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is false when the provider is the mock", () => {
    vi.mocked(getPaymentProvider).mockReturnValue({ name: "mock" } as never);
    expect(cardPaymentsEnabled()).toBe(false);
  });

  it("is true when a real provider is configured", () => {
    vi.mocked(getPaymentProvider).mockReturnValue({ name: "stripe" } as never);
    expect(cardPaymentsEnabled()).toBe(true);
  });
});
