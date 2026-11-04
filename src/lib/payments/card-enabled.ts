import { getPaymentProvider } from "./provider";

/** Card payments are real only when a non-mock provider is configured. */
export function cardPaymentsEnabled(): boolean {
  return getPaymentProvider().name !== "mock";
}
