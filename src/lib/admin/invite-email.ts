import "server-only";

import { after } from "next/server";
import { sendEmail } from "@/lib/communication/resend-adapter";
import { logger } from "@/lib/logger";
import { BUSINESS_TIME_ZONE } from "./calendar-time";
import { getOrgTimeZone } from "./org-time-zone";
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

/** "Nov 14, 2026, 10:00 AM EST": the expiry in the org's IANA zone, with its abbreviation. */
function formatExpiry(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(at);
}

/**
 * `timeZone` is the org's (after_hours_config.timezone, else the business
 * zone). An owner invite (the platform admin's "Send owner invite") asks the
 * owner to set up their account instead of naming the admin role, since the
 * owner is promoted on accept.
 */
export function buildInviteEmail(p: {
  orgName: string;
  url: string;
  role: InvitableRole;
  expiresAt: Date;
  timeZone: string;
  ownerInvite?: boolean;
}): { subject: string; html: string; text: string } {
  const purpose = p.ownerInvite
    ? "to set up your account"
    : `as ${p.role === "admin" ? "an admin" : "a technician"}`;
  const expires = formatExpiry(p.expiresAt, p.timeZone);
  const org = escapeHtml(p.orgName);
  const url = escapeHtml(p.url);

  // Control characters never reach a header (defence-in-depth; Resend is JSON).
  const subject = `You’re invited to ${p.orgName.replace(/[\u0000-\u001f\u007f]+/g, " ")}`;
  const text = [
    `You’ve been invited to join ${p.orgName} ${purpose}.`,
    "",
    `Accept the invite: ${p.url}`,
    "",
    `The link works once and expires ${expires}. If you weren’t expecting this, you can ignore this email.`,
  ].join("\n");
  const html = [
    `<p>You’ve been invited to join <strong>${org}</strong> ${purpose}.</p>`,
    `<p><a href="${url}">Accept the invite</a></p>`,
    `<p>Or paste this link into your browser:<br>${url}</p>`,
    `<p>The link works once and expires ${escapeHtml(expires)}. If you weren’t expecting this, you can ignore this email.</p>`,
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
 * time-zone lookup and the send run in after(); a failure is logged with ids only.
 */
export function deliverInvite(p: {
  organizationId: string;
  email: string;
  orgName: string;
  token: string;
  role: InvitableRole;
  expiresAt: Date;
  priorCount: number;
  /** The platform admin's owner invite (see buildInviteEmail). */
  ownerInvite?: boolean;
}): { emailed: boolean } {
  const url = inviteLink(p.token);
  const configured = Boolean(process.env.RESEND_API_KEY?.trim());
  if (!configured || url === null || p.priorCount > INVITE_EMAIL_DAILY_CAP - 1) {
    return { emailed: false };
  }
  after(async () => {
    try {
      // The org's zone for the expiry line; an unreadable one falls back to
      // the business zone rather than dropping the email.
      const timeZone = await getOrgTimeZone(p.organizationId).catch(() => BUSINESS_TIME_ZONE);
      const message = buildInviteEmail({
        orgName: p.orgName,
        url,
        role: p.role,
        expiresAt: p.expiresAt,
        timeZone,
        ownerInvite: p.ownerInvite,
      });
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
