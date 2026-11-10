/**
 * What the UI shows after an invite is created (client-safe; no server deps).
 * Emailed → a confirmation line. Not emailed → the one-time copy link, when the
 * caller may see it; otherwise a plain "not emailed" line.
 */
export type InviteResultView =
  | { kind: "emailed"; line: string }
  | { kind: "link"; url: string }
  | { kind: "not_sent"; line: string };

export function inviteResultView(r: {
  emailed: boolean;
  url?: string;
  /** Omitted where the caller never sees the address (the platform console). */
  email?: string;
}): InviteResultView {
  if (r.emailed) {
    return { kind: "emailed", line: r.email ? `Invite emailed to ${r.email}.` : "Invite emailed." };
  }
  if (r.url) return { kind: "link", url: r.url };
  return { kind: "not_sent", line: "Invite created but not emailed." };
}
