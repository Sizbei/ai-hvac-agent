/**
 * Pure: what the portal shows in place of (or alongside) Pay now.
 *
 * While card payments are disabled (the mock provider — spec §5.7) the Pay now
 * button is hidden and the customer is told to pay the technician in person,
 * with the org's phone as a tel: link when one is configured.
 */
export interface PortalPaymentNotice {
  readonly showPayButton: boolean;
  readonly notice: string | null;
  readonly tel: string | null;
}

/** `tel:` href for a display phone: digits only, keeping a leading `+`. */
export function telHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

export function portalPaymentNotice({
  cardEnabled,
  phone,
}: {
  cardEnabled: boolean;
  phone: string | null;
}): PortalPaymentNotice {
  if (cardEnabled) return { showPayButton: true, notice: null, tel: null };
  const display = phone?.trim() ?? "";
  const tel = display ? telHref(display) : null;
  if (!tel) {
    return { showPayButton: false, notice: "Pay your technician in person.", tel: null };
  }
  return {
    showPayButton: false,
    notice: `Pay your technician in person, or call ${display}.`,
    tel,
  };
}
