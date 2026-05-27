import pino from "pino";

const PII_FIELDS = [
  "email",
  "phone",
  "name",
  "address",
  "customerName",
  "customerPhone",
  "customerEmail",
  "passwordHash",
  "password",
  "token",
  "sessionToken",
  "cookie",
] as const;

function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const field of PII_FIELDS) {
    paths.push(field);
    paths.push(`*.${field}`);
    paths.push(`data.${field}`);
  }
  // Always redact auth headers and cookies
  paths.push("req.headers.cookie");
  paths.push("req.headers.authorization");
  return paths;
}

export const logger = pino({
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redact: {
    paths: buildRedactPaths(),
    censor: "[REDACTED]",
  },
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Creates a child logger with additional bindings (e.g., requestId, organizationId).
 * Child loggers inherit parent redaction rules.
 */
export function createChildLogger(
  bindings: Record<string, unknown>,
): pino.Logger {
  return logger.child(bindings);
}
