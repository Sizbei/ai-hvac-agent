"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pay control for a single portal invoice. Posts to the public, token-scoped
 * pay route. The invoiceId is the ONLY thing sent; org + customer are derived
 * server-side from the token in the URL (never trusted from the client). The
 * full remaining balance is paid (the route re-verifies the amount against the
 * server-side invoice).
 */
export function PayButton({
  token,
  invoiceId,
  balanceCents,
}: {
  readonly token: string;
  readonly invoiceId: string;
  readonly balanceCents: number;
}) {
  const [status, setStatus] = useState<"idle" | "paying" | "paid" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  async function handlePay(): Promise<void> {
    setStatus("paying");
    setMessage(null);
    try {
      const res = await fetch(
        `/api/portal/${encodeURIComponent(token)}/pay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoiceId, amountCents: balanceCents }),
        },
      );
      const json = await res.json().catch(() => ({ success: false }));
      if (res.ok && json.success) {
        setStatus("paid");
        setMessage("Payment received. Thank you!");
        // Revalidate the server component so the sibling invoice row's
        // state badge + "$X due" reflect the payment instead of staying "open".
        router.refresh();
        return;
      }
      setStatus("error");
      setMessage(
        json?.error?.message ??
          "We couldn't process that payment. Please try again or contact us.",
      );
    } catch {
      setStatus("error");
      setMessage("Network error. Please try again.");
    }
  }

  if (status === "paid") {
    return (
      <p className="text-[15px] font-medium text-success-strong">
        {message ?? "Paid"}
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-1 sm:w-auto">
      <button
        type="button"
        onClick={handlePay}
        disabled={status === "paying"}
        className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition-[background-color] duration-[var(--dur-hover)] hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {status === "paying" ? "Processing…" : "Pay now"}
      </button>
      {status === "error" && message && (
        <p className="text-[13px] text-danger-strong">{message}</p>
      )}
    </div>
  );
}
