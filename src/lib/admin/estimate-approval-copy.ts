/**
 * The office estimate detail's "Approval" lines (M3c spec §2): a field sale
 * names who typed the name and the technician ("Signed on site with …", weaker
 * evidence than the portal's remote e-sign: no IP); an office sale since M3c
 * reads "Marked sold by <admin name>"; portal and pre-M3c rows read as today.
 * Names are `strong` segments (today's bold names). Pure.
 */
const OFFICE_SIGNATURE = "(admin)";

export interface ApprovalSegment {
  readonly text: string;
  readonly strong?: true;
}

export interface ApprovalInput {
  readonly soldVia: string | null;
  readonly signatureName: string | null;
  readonly soldByName: string | null;
  /** Legacy office rows: the name from the `estimate_marked_sold` audit row. */
  readonly markedSoldBy: string | null;
  readonly signedAt: string;
}

const name = (text: string): ApprovalSegment => ({ text, strong: true });
const t = (text: string): ApprovalSegment => ({ text });

export function approvalLines(
  e: ApprovalInput, formatWhen: (iso: string) => string, formatDay: (iso: string) => string,
): ApprovalSegment[][] {
  if (e.soldVia === "field") {
    return [
      [t("Signed by "), name(e.signatureName ?? "the customer"), t(".")],
      [t("Signed on site with "), e.soldByName ? name(e.soldByName) : t("a technician"), t(` · ${formatWhen(e.signedAt)}`)],
    ];
  }
  if (e.soldVia === "office") {
    const who = e.soldByName ?? e.markedSoldBy;
    return [who ? [t("Marked sold by "), name(who)] : [t("Marked sold in the office")]];
  }
  if (e.signatureName === OFFICE_SIGNATURE) {
    return [e.markedSoldBy
      ? [t("Marked sold in the office by "), name(e.markedSoldBy), t(` on ${formatDay(e.signedAt)}.`)]
      : [t(`Marked sold in the office on ${formatDay(e.signedAt)}.`)]];
  }
  return [[t("Signed by "), name(e.signatureName ?? "customer"), t(` on ${formatDay(e.signedAt)}.`)]];
}
