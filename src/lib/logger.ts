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

type ErrorLike = { constructor?: { name?: string }; code?: unknown; cause?: { code?: unknown; stack?: unknown }; message?: unknown; stack?: unknown; params?: unknown; query?: unknown };

/** Stack frames only — the first line of a stack repeats the message, which for a Postgres error can echo a bound value. */
function frames(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const rest = stack.split("\n").slice(1).join("\n");
  return rest.length > 0 ? rest : undefined;
}

/** The database/system error code of an error or its cause (e.g. "40P01"), else undefined. */
export function errorCode(e: unknown): string | undefined {
  if (e === null || typeof e !== "object") return undefined;
  const err = e as ErrorLike;
  const code = err.code ?? err.cause?.code;
  return code === undefined || code === null ? undefined : String(code);
}

/**
 * Error serializer for the `error` and `err` keys. An ordinary error keeps its
 * type, code, message and stack. An error that carries SQL (a DrizzleQueryError
 * keeps `query` and `params` as enumerable fields and embeds both in its
 * message) keeps only its type, the cause's code and the cause's stack FRAMES —
 * never `params`, `query` or a message, which would write customer PII and
 * portal tokens into the logs (spec §4: "codes and ids only, never SQL parameters").
 */
export function serializeError(e: unknown): Record<string, unknown> {
  if (e === null || typeof e !== "object") return { type: typeof e };
  const err = e as ErrorLike;
  const type = err.constructor?.name ?? "Object";
  const carriesSql = type === "DrizzleQueryError" || "params" in err || "query" in err;
  const out: Record<string, unknown> = { type };
  const code = errorCode(e);
  if (code !== undefined) out.code = code;
  if (carriesSql) {
    const causeFrames = frames(err.cause?.stack);
    if (causeFrames) out.stack = causeFrames;
    return out;
  }
  if (typeof err.message === "string") out.message = err.message;
  if (typeof err.stack === "string") out.stack = err.stack;
  return out;
}

export const logger = pino({
  serializers: { error: serializeError, err: serializeError },
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
