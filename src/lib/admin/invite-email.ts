import "server-only";

import { after } from "next/server";
import { sendEmail } from "@/lib/communication/resend-adapter";
import { logger } from "@/lib/logger";
import type { InvitableRole } from "./invites";

/**
 * Invite email delivery (spec P2). The accept link is built ONLY from
 * NEXT_PUBLIC_APP_URL — never the request origin, which a proxied or spoofed
 * Host could steer. The email carries no tracking params. When it can't be
 * sent (no Resend key, no app URL, or the per-org daily cap is reached) the
 * caller falls back to the one-time copy link.
 */

/** At most this many invite emails per org per rolling 24 h (plan ruling 4). */
export const INVITE_EMAIL_DAILY_CAP = 20;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EXPIRY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

export function buildInviteEmail(p: {
  orgName: string;
  url: string;
  role: InvitableRole;
  expiresAt: Date;
}): { subject: string; html: string; text: string } {
  const roleLabel = p.role === "admin" ? "an admin" : "a technician";
  const expires = `${EXPIRY_FORMAT.format(p.expiresAt)} UTC`;
  const org = escapeHtml(p.orgName);
  const url = escapeHtml(p.url);

  const subject = `You’re invited to ${p.orgName}`;
  const text = [
    `You’ve been invited to join ${p.orgName} as ${roleLabel}.`,
    "",
    `Accept the invite: ${p.url}`,
    "",
    `The link works once and expires ${expires}. If you weren’t expecting this, you can ignore this email.`,
  ].join("\n");
  const html = [
    `<p>You’ve been invited to join <strong>${org}</strong> as ${roleLabel}.</p>`,
    `<p><a href="${url}">Accept the invite</a></p>`,
    `<p>Or paste this link into your browser:<br>${url}</p>`,
    `<p>The link works once and expires ${expires}. If you weren’t expecting this, you can ignore this email.</p>`,
  ].join("\n");
  return { subject, html, text };
}

/** The accept link, from NEXT_PUBLIC_APP_URL only. Null when that is unset or
 * not an http(s) URL. */
export function inviteLink(token: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const { protocol } = new URL(base);
    if (protocol !== "https:" && protocol !== "http:") return null;
  } catch {
    return null;
  }
  return `${base}/admin/invite/${token}`;
}

/**
 * Email the invite when possible. `priorCount` is the org's invites in the last
 * 24 h, read BEFORE this invite was created: counts 0–19 are emailed, so the
 * 21st invite of the window is created but not emailed (plan ruling 4). The
 * send runs in after(); a failure is logged with ids only.
 */
export function deliverInvite(p: {
  organizationId: string;
  email: string;
  orgName: string;
  token: string;
  role: InvitableRole;
  expiresAt: Date;
  priorCount: number;
}): { emailed: boolean } {
  const url = inviteLink(p.token);
  const configured = Boolean(process.env.RESEND_API_KEY?.trim());
  if (!configured || url === null || p.priorCount > INVITE_EMAIL_DAILY_CAP - 1) {
    return { emailed: false };
  }
  const message = buildInviteEmail({
    orgName: p.orgName,
    url,
    role: p.role,
    expiresAt: p.expiresAt,
  });
  after(async () => {
    try {
      await sendEmail({ to: p.email, ...message });
    } catch {
      // Never the error: Resend's message can echo the recipient.
      logger.error(
        { code: "INVITE_EMAIL_FAILED", organizationId: p.organizationId },
        "Invite email failed",
      );
    }
  });
  return { emailed: true };
}
