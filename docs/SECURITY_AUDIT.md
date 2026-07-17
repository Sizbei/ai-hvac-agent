# SECURITY AUDIT REPORT - AI HVAC Agent

**Date:** 2025-06-11 (baseline) · **Updated:** 2026-07-17 (adversarial hardening addendum)  
**Auditor:** Claude (Security Reviewer Agent)  
**Scope:** Full codebase security audit focusing on OWASP Top 10

## Executive Summary

**Overall Assessment:** **LOW RISK** - Production-ready with recommended improvements

The AI HVAC Agent demonstrates **strong security posture** with robust defense-in-depth mechanisms. No critical vulnerabilities found. Several high-priority improvements identified for production hardening.

> The baseline audit below is retained for the record. A follow-up **3-round adversarial
> hardening pass (2026-07)** re-audited every admin/public/tech/portal surface and closed
> the highest-leverage findings; see [Follow-up: 2026-07 Adversarial Hardening](#follow-up-2026-07-adversarial-hardening).

---

## Follow-up: 2026-07 Adversarial Hardening

**Date:** 2026-07-16 → 2026-07-17 · **Scope:** three autonomous adversarial rounds (audit → fix → gate → deploy) over every admin, public, technician, and customer-portal surface. Full round-by-round plans live in `docs/ADVERSARIAL-REVIEW-{R1,R2,R3}-2026-07.md`. ~55 real defects fixed; test suite green (261 files, 3,781 pass, 0 fail); all changes deployed to production.

### Security fixes shipped

| # | Issue | Fix |
|---|-------|-----|
| S1 | **Rate-limit / cost-DoS bypass via spoofable `X-Forwarded-For`.** 40+ call-sites parsed the raw `x-forwarded-for` header, whose leftmost value the client controls — letting an attacker rotate the throttle key and defeat per-IP limits on chat, auth, and admin mutations. | New `src/lib/http/client-ip.ts` `clientIp()` prefers the Vercel-set, spoof-resistant `x-real-ip`, falls back to the leftmost XFF, and caps length. It is now the **sole** XFF parser (0 raw `x-forwarded-for` reads outside it). |
| S2 | **Portal pay amount not pinned to balance.** The customer pay endpoint could accept a partial/mismatched amount. | Strict `amount == balance` equality — no `$0.01` trickle or over/under payment. |
| S3 | **Malformed-JSON bodies reached handlers.** Mutation routes assumed a parseable body. | Shared `readJsonBody` (`src/lib/api-response.ts`) returns **400** on malformed JSON before any handler logic runs. |
| S4 | **Audit-log money-value leak.** Some audit writers recorded dollar amounts in `audit_log.details`. | All writers now record field names / ids / enums only — never money values (consistent with the "no PII in audit details" invariant). |
| S5 | **Non-UUID route params.** `[id]` routes could pass unvalidated strings to queries. | `isUuid` guards return **404/400** for non-UUID ids; duplicate unique-key writes return **409** (see below), not 500. |

### Money engine

Independently re-confirmed **atomic** under live concurrent probes: pay / refund / void / estimate-accept all hold their invariants under race. No double-credit or over-collection reproducible.

### Correctness hardening worth noting for security review

- **Dup unique-key → 409, not 500.** Root cause: Drizzle wraps the driver error in a `DrizzleQueryError` whose top-level `.code` is `undefined`; the real `23505`/`.constraint` live on `.cause`. New `src/lib/db/unique-violation.ts` `isUniqueViolation()` walks the `.cause` chain — use it for **any** 23505 check, never the top-level `.code`.
- **Admin auth resilience.** `adminFetch` redirects `401 → /admin/login` across the admin hooks instead of surfacing raw errors; a dashboard `error.tsx` boundary contains render failures.
- **Technician-scope tightening.** Clock-out payroll leak closed, upload-before-ownership check added, tech-location assignee scoped to the acting technician.

### Documented residuals (tracked, low-risk, out of the 3-round scope — not regressions)

- In-memory rate-limit store is still **per-instance** (S1 fixes the *key*, not cross-instance sharing). Upstash/Redis-backed limits remain the durable follow-up — this also subsumes the baseline "rate-limit memory-leak" HIGH item, which is bounded by process lifetime on serverless.
- ~11 admin hooks still use the older `isFetchingRef` drop-guard (self-healing; convert to latest-wins opportunistically).
- **Verify-on-prod:** confirm Vercel populates `x-real-ip` so S1 engages (local dev has no `x-real-ip` and falls back to XFF).

---

## Critical Issues

### ✅ None Found
No critical security vulnerabilities requiring immediate production intervention.

---

## High Priority Issues

### 1. Dependency Vulnerabilities (HIGH)

**CVEs:**
- `esbuild <=0.24.2` - Development server request exposure (GHSA-67mh-4wv8-2f99)
- `postcss <8.5.10` - XSS via unescaped `</style>` (GHSA-qx2v-qp2m-jg93)

**Fix:**
```bash
npm audit fix --force
npm install esbuild@latest postcss@latest
```

**Timeline:** Before next production deployment

---

### 2. Rate Limiting Memory Leak Risk (HIGH)

**Location:** `src/lib/rate-limit.ts:8-24`

**Issue:** In-memory rate limiting store grows unbounded under heavy load

**Fix:** Add memory ceiling:
```typescript
const MAX_STORE_ENTRIES = 10000;
function cleanup(windowMs: number): void {
  // ... existing cleanup ...
  if (store.size > MAX_STORE_ENTRIES) {
    const entries = Array.from(store.entries());
    entries.sort((a, b) => a[1].timestamps[0] - b[1].timestamps[0]);
    const toDelete = entries.slice(0, store.size - MAX_STORE_ENTRIES);
    toDelete.forEach(([key]) => store.delete(key));
  }
  // ... rest of cleanup ...
}
```

**Timeline:** Before scaling to high-traffic production

---

### 3. Widget Loader innerHTML Usage (MEDIUM-HIGH)

**Location:** `src/app/widget.js/route.ts:115,135`

**Issue:** Direct `innerHTML` assignment with static SVG content

**Fix:**
```typescript
const svgTemplate = document.createElement('template');
svgTemplate.innerHTML = ICON_CHAT;
btn.appendChild(svgTemplate.content.firstChild);
```

**Timeline:** Next maintenance cycle

---

## Medium Priority Issues

### 4. Admin Session Cookie Security (MEDIUM)

**Location:** `src/lib/auth/session.ts:15-24`

**Issue:** `secure` flag only set in production

**Fix:**
```typescript
cookieStore.set(ADMIN_SESSION_COOKIE, token, {
  httpOnly: true,
  secure: true, // Always secure (use HTTPS in dev too)
  sameSite: "strict",
  maxAge: ADMIN_SESSION_MAX_AGE,
  path: "/",
});
```

**Timeline:** Next security hardening sprint

---

### 5. Session CSRF Origin Spoofing Risk (MEDIUM)

**Location:** `src/lib/session-csrf.ts:29-36`

**Issue:** `request.nextUrl.origin` relies on Host header validation

**Fix:** Add explicit origin allowlist for non-Vercel deployments

**Timeline:** Before supporting self-hosted deployments

---

### 6. Error Message Information Disclosure (MEDIUM)

**Location:** `src/app/api/chat/route.ts:1613-1620`

**Fix:** Implement error code obfuscation

**Timeline:** Next error handling review

---

### 7. File Upload Metadata Validation (MEDIUM)

**Location:** `src/app/api/upload/route.ts:89-90`

**Issue:** Filename length not validated

**Fix:**
```typescript
const MAX_FILENAME_LENGTH = 255;
const sanitizedFilename = file.name
  .slice(0, MAX_FILENAME_LENGTH)
  .replace(/[^a-zA-Z0-9._-]/g, '_');
```

**Timeline:** Next file upload enhancement

---

## Low Priority Issues

### 8. Logging Sensitive Data Risk (LOW)

**Issue:** Some log statements include PII in development mode

**Fix:** Implement PII redaction in logger

**Timeline:** Logging enhancement

---

### 9. Missing Security Headers (LOW)

**Location:** `next.config.ts`

**Fix:** Add security headers:
```typescript
headers: [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
]
```

**Timeline:** Next configuration update

---

## Security Strengths ✅

| Category | Status | Notes |
|----------|--------|-------|
| **Injection Attacks** | ✅ PASS | Drizzle ORM prevents SQL injection |
| **XSS Prevention** | ✅ PASS | React auto-escapes; input sanitization |
| **CSRF Protection** | ✅ PASS | Comprehensive origin validation |
| **Authentication** | ✅ PASS | bcrypt with timing-safe comparisons |
| **Authorization** | ✅ PASS | Role-based access control |
| **Secrets Management** | ✅ PASS | Environment variables used |
| **File Upload Security** | ✅ PASS | Magic byte validation |
| **Rate Limiting** | ⚠️ GOOD | Needs memory ceiling |
| **Input Validation** | ✅ PASS | Comprehensive sanitization |
| **Security Headers** | ⚠️ PARTIAL | Missing some headers |
| **Logging Security** | ⚠️ PARTIAL | Some PII in logs |
| **Dependencies** | ⚠️ WARN | Moderate vulns |

---

## OWASP Top 10 2021 Compliance

- **A01 – Broken Access Control**: ✅ PASS
- **A02 – Cryptographic Failures**: ✅ PASS
- **A03 – Injection**: ✅ PASS
- **A04 – Insecure Design**: ✅ PASS
- **A05 – Security Misconfiguration**: ⚠️ PARTIAL
- **A06 – Vulnerable Components**: ⚠️ WARN
- **A07 – Authentication Failures**: ✅ PASS
- **A08 – Software/Data Integrity**: ✅ PASS
- **A09 – Logging Monitoring**: ⚠️ PARTIAL
- **A10 – Server-Side Request Forgery**: ✅ PASS

---

## Immediate Action Items

1. **Fix dependency vulnerabilities** - `npm audit fix --force`
2. **Add rate limit memory ceiling** - Implement `MAX_STORE_ENTRIES`
3. **Add security headers** - Update `next.config.ts`

---

## Testing Recommendations

### Security Testing Checklist
- [ ] Test rate limit bypass techniques
- [ ] Verify CSRF protection with forged requests
- [ ] Test file upload with malicious MIME types
- [ ] Attempt SQL injection via form fields
- [ ] Verify session isolation between tenants
- [ ] Test authentication timing attack resistance
- [ ] Verify webhook signature validation

---

## Conclusion

**Risk Level:** **LOW** (with moderate priority improvements)

The application is **production-ready** from a security perspective, with recommended improvements for the next maintenance cycle.
