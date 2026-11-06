"use client";

import { useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "./error-state";

interface LoadErrorStateProps {
  /** Human copy, e.g. "Couldn't load templates." Never a server message. */
  readonly title: string;
  readonly description?: string;
  /** Re-runs the failed fetch. */
  readonly onRetry: () => Promise<void> | void;
  readonly className?: string;
}

/**
 * A list or page whose load failed: the error plus Try again, rendered INSTEAD
 * of the empty state (see `listViewState`).
 */
export function LoadErrorState({
  title,
  description = "Check your connection and try again.",
  onRetry,
  className,
}: LoadErrorStateProps) {
  const [retrying, setRetrying] = useState(false);

  async function retry(): Promise<void> {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div role="alert" className={className}>
      <ErrorState
        title={title}
        description={description}
        action={
          <Button variant="outline" onClick={() => void retry()} disabled={retrying}>
            <RotateCw className="size-3.5" aria-hidden="true" />
            {retrying ? "Trying…" : "Try again"}
          </Button>
        }
      />
    </div>
  );
}
