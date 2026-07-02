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
      <p className="text-sm font-medium text-green-700">
        {message ?? "Paid"}
      </p>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handlePay}
        disabled={status === "paying"}
        className="inline-flex items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "paying" ? "Processing…" : "Pay now"}
      </button>
      {status === "error" && message && (
        <p className="text-xs text-red-600">{message}</p>
      )}
    </div>
  );
}
