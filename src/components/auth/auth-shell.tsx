import { Bricolage_Grotesque } from 'next/font/google';
import { Wind, Clock, ShieldCheck, Wrench } from 'lucide-react';
import { EnvBadge } from '@/components/admin/env-badge';

/**
 * Display face for auth headings — same family the marketing site uses, so the
 * console and the landing page read as one brand. Loaded here (not globally) so
 * only the auth surfaces pay for it.
 */
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
});

/** Trust markers on the brand rail. Sentence case on purpose — capitals are
 * reserved for the wordmark. */
const MARKERS = [
  { icon: Clock, label: '24/7 answering' },
  { icon: Wrench, label: 'Most jobs, one trip' },
  { icon: ShieldCheck, label: 'Licensed engineer on staff' },
] as const;

interface AuthShellProps {
  /** Panel heading, sentence case. */
  readonly title: string;
  /** One supporting line under the heading. */
  readonly subtitle?: React.ReactNode;
  /** The form (or recovery content). */
  readonly children: React.ReactNode;
  /** Optional links below the form (sign-in / sign-up / forgot). */
  readonly footer?: React.ReactNode;
}

/**
 * Two-panel auth layout: a branded navy rail (the dominant brand surface) beside
 * a clean form panel (secondary), with the cyan accent reserved for the primary
 * action inside `children`. The rail is hidden below `lg`, where a compact
 * wordmark stands in above the form.
 */
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div
      className={`${display.variable} grid min-h-dvh lg:grid-cols-[1.05fr_1fr]`}
    >
      {/* ── Brand rail (lg+) ─────────────────────────────────────────── */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-[oklch(0.24_0.05_258)] via-[oklch(0.2_0.05_259)] to-[oklch(0.15_0.05_261)] p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16">
        {/* atmosphere */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-[36rem] rounded-full bg-[radial-gradient(circle_at_center,oklch(0.72_0.13_220/0.35),transparent_70%)] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 -left-20 size-[30rem] rounded-full bg-[radial-gradient(circle_at_center,oklch(0.45_0.1_250/0.28),transparent_70%)] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(oklch(1_0_0/0.05)_1px,transparent_1px),linear-gradient(90deg,oklch(1_0_0/0.05)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]"
        />

        {/* wordmark */}
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-[oklch(0.75_0.13_220)] to-[oklch(0.6_0.13_222)] shadow-lg">
            <Wind className="size-5" strokeWidth={2.25} />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="font-[family-name:var(--font-display)] text-lg font-bold tracking-tight">
              Spears Services
            </span>
            <span className="text-xs text-white/55">Service console</span>
          </span>
        </div>

        {/* value line — the biggest type on the page (hierarchy by scale) */}
        <div className="relative max-w-md">
          <h2 className="font-[family-name:var(--font-display)] text-4xl font-extrabold leading-[1.05] tracking-tight text-balance xl:text-5xl">
            Where every service call becomes a{' '}
            <span className="bg-gradient-to-r from-[oklch(0.82_0.12_215)] to-[oklch(0.72_0.13_222)] bg-clip-text text-transparent">
              dispatched job
            </span>
            .
          </h2>
          <p className="mt-5 text-[0.975rem] leading-relaxed text-white/70">
            Sign in to the console that turns customer conversations into
            scheduled, tracked work — around the clock.
          </p>
        </div>

        {/* trust row */}
        <ul className="relative flex flex-wrap gap-x-6 gap-y-3">
          {MARKERS.map((m) => (
            <li key={m.label} className="flex items-center gap-2 text-sm text-white/65">
              <m.icon className="size-4 text-[oklch(0.8_0.12_215)]" strokeWidth={2} />
              {m.label}
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Form panel ───────────────────────────────────────────────── */}
      <main className="relative flex items-center justify-center bg-background px-5 py-10 sm:px-8">
        <div className="lp-rise w-full max-w-sm">
          {/* compact brand — mobile only */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[oklch(0.62_0.13_222)] text-white shadow-sm">
              <Wind className="size-4.5" strokeWidth={2.25} />
            </span>
            <span className="font-[family-name:var(--font-display)] text-base font-bold tracking-tight">
              Spears Services
            </span>
          </div>

          <div className="mb-6">
            <div className="flex items-center gap-2.5">
              <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold tracking-tight text-foreground">
                {title}
              </h1>
              <EnvBadge />
            </div>
            {subtitle && (
              <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>

          {children}

          {footer && (
            <div className="mt-6 border-t border-border/70 pt-5 text-sm text-muted-foreground">
              {footer}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
