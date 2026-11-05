/**
 * Pure parsing for the communication templates API envelope.
 *
 * Every admin route answers `{ success, data }` or `{ success: false, error:
 * { message, code } }` (src/lib/api-response.ts). The templates page used to
 * read `json.templates`, which is always undefined, so every org saw "No
 * templates yet". Keep the envelope knowledge here, next to its test.
 */

const DELETE_ERROR_COPY: Record<string, string> = {
  HAS_SEND_HISTORY:
    "This template has already sent messages, so it can't be deleted. Deactivate it instead to stop future sends.",
  NOT_FOUND: "This template no longer exists. Refresh the page to see the current list.",
};

const DELETE_FALLBACK = "Couldn't delete the template. Please try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Templates from a GET /api/admin/communications/templates body; [] when the shape is off. */
export function parseTemplatesResponse<T>(json: unknown): T[] {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return [];
  const templates = json.data.templates;
  return Array.isArray(templates) ? (templates as T[]) : [];
}

/** Human copy for a failed DELETE, keyed by error code (never the server's raw message). */
export function templateDeleteErrorMessage(json: unknown): string {
  if (!isRecord(json) || !isRecord(json.error)) return DELETE_FALLBACK;
  const code = json.error.code;
  return (typeof code === "string" && DELETE_ERROR_COPY[code]) || DELETE_FALLBACK;
}
