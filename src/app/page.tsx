import Link from 'next/link';
import { MobileNav } from './_components/mobile-nav';
import {
  ArrowRight,
  Wind,
  Snowflake,
  Flame,
  Wrench,
  Refrigerator,
  ShieldAlert,
  Clock,
  Award,
  BadgeCheck,
  Users,
  CheckCircle2,
  Phone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BUSINESS_BASE_LOCATION } from '@/lib/config/business-location';

/** Verified Spears Services contact facts (spearsservices.com). */
const SPEARS = {
  name: 'Spears Services',
  positioning: 'Commercial repair experts in TN, VA, NC',
  phoneDisplay: '423-854-9505',
  phoneTel: '+14238549505',
  email: 'office@spearsservices.com',
  address: BUSINESS_BASE_LOCATION.address,
} as const;

/** The live Twilio voice number for the AI phone assistant. */
const DEMO_PHONE = { display: '(231) 559-9669', tel: '+12315599669' } as const;

const NAV = [
  { label: 'Request service', href: '/chat' },
  { label: 'Staff sign in', href: '/admin' },
];

const SERVICES = [
  {
    icon: Wind,
    title: 'HVAC services',
    body: 'Heating and cooling repair for commercial and residential systems, with most jobs finished in a single trip.',
  },
  {
    icon: Refrigerator,
    title: 'Refrigeration services',
    body: 'Walk-in coolers, reach-in freezers, display cases, beverage coolers, and ice makers kept running.',
  },
  {
    icon: Snowflake,
    title: 'Ice machine repair & service',
    body: 'Commercial ice machine repair and preventive maintenance contracts so you never run dry.',
  },
  {
    icon: Flame,
    title: 'Boiler repair & service',
    body: 'Gas, electric, and oil boiler repair plus preventive maintenance plans for steady, safe heat.',
  },
  {
    icon: Wrench,
    title: 'Commercial appliance repair',
    body: 'Ranges, ovens, fryers, and the rest of your kitchen line serviced by full-time technicians.',
  },
];

const WHY_CHOOSE = [
  { icon: Clock, title: '24/7 emergency service', body: 'A real person answers when your equipment goes down, day or night.' },
  { icon: Award, title: '50+ years of experience', body: 'Decades of commercial repair across the Tri-Cities region.' },
  { icon: CheckCircle2, title: 'Most jobs in one trip', body: 'We come prepared to diagnose and fix on the first visit.' },
  { icon: BadgeCheck, title: 'Licensed professional engineer', body: 'A licensed PE on staff and multiple service licenses.' },
  { icon: Users, title: 'Full-time technicians', body: 'No rotating subcontractors. Our own trained crew.' },
  { icon: ShieldAlert, title: 'Clear estimates up front', body: 'Clear estimates before the work, no surprises after.' },
];

/** Animation delay helper, keeps staggered reveals declarative. */
function delay(ms: number): React.CSSProperties {
  return { animationDelay: `${ms}ms` };
}

export default function Home() {
  return (
    <div className="relative flex min-h-full flex-1 flex-col overflow-x-clip bg-background text-foreground">
      {/* Atmosphere — pinned to the top of the page so the blurred glows and grid
          never paint into the empty space below the footer. */}
      <div className="lp-mesh pointer-events-none absolute inset-x-0 top-0 -z-10 h-[120vh] overflow-hidden" aria-hidden />
      <div className="lp-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[120vh]" aria-hidden />

      {/* Top utility bar: 24/7 + phone (Spears pattern) */}
      <div className="hidden border-b border-border/60 bg-foreground text-background sm:block">
        <div className="mx-auto flex h-9 max-w-6xl items-center justify-between px-5 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <Clock className="size-3.5" />
            24/7 emergency service
          </span>
          <a
            href={`tel:${SPEARS.phoneTel}`}
            className="flex items-center gap-1.5 font-semibold underline-offset-4 hover:underline"
          >
            <Phone className="size-3.5" />
            {SPEARS.phoneDisplay}
          </a>
        </div>
      </div>

      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/spears-logo.png" alt="" className="size-9 rounded-lg" />
            <span className="font-heading text-lg font-bold tracking-tight">
              Spears&nbsp;Services
            </span>
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="lg"
              className="hidden bg-primary text-primary-foreground hover:bg-primary-deep md:inline-flex"
              render={<Link href="/chat" />}
            >
              Get service now
              <ArrowRight className="size-4" data-icon="inline-end" />
            </Button>
            <MobileNav phoneDisplay={SPEARS.phoneDisplay} phoneTel={SPEARS.phoneTel} />
          </div>
        </nav>
      </header>

      {/* Hero */}
      <main className="relative mx-auto max-w-6xl px-5">
        <section className="grid items-center gap-12 py-16 md:grid-cols-[1.05fr_0.95fr] md:py-24">
          {/* Left: copy */}
          <div>
            <div
              className="lp-rise inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur"
              style={delay(0)}
            >
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </span>
              {SPEARS.positioning}
            </div>

            <h1
              className="lp-rise mt-5 font-heading text-5xl font-extrabold leading-[1.02] tracking-tight md:text-6xl"
              style={delay(80)}
            >
              Commercial repair experts,{' '}
              <span className="bg-gradient-to-r from-primary via-primary to-[var(--hvac-accent)] bg-clip-text text-transparent">
                now answering around the clock
              </span>
            </h1>

            <p
              className="lp-rise mt-5 max-w-xl text-lg text-muted-foreground"
              style={delay(160)}
            >
              Describe a heating, cooling, refrigeration, or appliance problem and
              the Spears intake assistant captures the details, flags emergencies,
              and gets a technician on the way. 24/7, with a real person never far
              behind.
            </p>

            <div className="lp-rise mt-8 flex flex-wrap items-center gap-3" style={delay(240)}>
              <Button
                size="lg"
                className="h-11 bg-primary px-5 text-base text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary-deep"
                render={<Link href="/chat" />}
              >
                Start a service request
                <ArrowRight className="size-4" data-icon="inline-end" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 px-5 text-base"
                render={<a href={`tel:${SPEARS.phoneTel}`} />}
              >
                <Phone className="size-4" data-icon="inline-start" />
                Call {SPEARS.phoneDisplay}
              </Button>
            </div>

            <p className="lp-rise mt-4 text-sm text-muted-foreground" style={delay(280)}>
              Prefer to talk to the assistant? It answers in a natural voice at{' '}
              <a
                href={`tel:${DEMO_PHONE.tel}`}
                className="inline-flex items-center gap-1.5 font-semibold text-foreground underline-offset-4 transition-colors hover:text-link hover:underline"
              >
                <Phone className="size-3.5" />
                {DEMO_PHONE.display}
              </a>
            </p>
          </div>

          {/* Right: chat preview */}
          <div className="lp-rise" style={delay(360)}>
            <ChatPreview />
          </div>
        </section>

        {/* Services */}
        <section className="py-16 md:py-24">
          <SectionHeading
            eyebrow="What we service"
            title="A full line of services for your operation"
            subtitle="HVAC, refrigeration, ice machines, boilers, and commercial appliances, kept running across NE Tennessee, SW Virginia, and Western North Carolina."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {SERVICES.map((s) => (
              <article
                key={s.title}
                className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/60 p-6 backdrop-blur transition-all hover:-translate-y-0.5 hover:border-brand-navy/40 hover:shadow-lg hover:shadow-brand-navy/5"
              >
                <div className="flex size-11 items-center justify-center rounded-lg bg-brand-navy/10 text-brand-navy transition-colors group-hover:bg-brand-navy group-hover:text-primary-foreground">
                  <s.icon className="size-5" strokeWidth={2} />
                </div>
                <h3 className="mt-4 font-heading text-lg font-semibold tracking-tight">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* Why choose */}
        <section className="pb-16 md:pb-24">
          <SectionHeading
            eyebrow="Why choose Spears Services?"
            title="Trusted across the Tri-Cities since 1993"
            subtitle="Since 1993, businesses across the Tri-Cities have trusted Spears to keep their refrigeration, HVAC, and appliances running."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {WHY_CHOOSE.map((w) => (
              <div
                key={w.title}
                className="flex gap-4 rounded-xl border border-border/70 bg-card/60 p-6 backdrop-blur"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--hvac-accent)]/10 text-[var(--hvac-accent)]">
                  <w.icon className="size-5" strokeWidth={2} />
                </div>
                <div>
                  <h3 className="font-heading text-base font-semibold tracking-tight">
                    {w.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {w.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="pb-24">
          <div className="relative overflow-hidden rounded-3xl border border-border/70 bg-gradient-to-br from-primary/8 via-card to-[var(--hvac-accent)]/8 p-10 text-center md:p-16">
            <Flame className="lp-float absolute -right-6 -top-6 size-32 text-[var(--hvac-accent)]/10" aria-hidden />
            <Wind className="lp-float absolute -bottom-8 -left-6 size-32 text-brand-navy/10" style={delay(800)} aria-hidden />
            <h2 className="relative font-heading text-3xl font-bold tracking-tight md:text-4xl">
              Equipment down? Let&apos;s get you back up and running.
            </h2>
            <p className="relative mx-auto mt-3 max-w-xl text-muted-foreground">
              Start a service request in chat, or call and a real person will pick
              up. Most projects are completed in one trip.
            </p>
            <div className="relative mt-7 flex flex-wrap justify-center gap-3">
              <Button
                size="lg"
                className="h-11 bg-primary px-5 text-base text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary-deep"
                render={<Link href="/chat" />}
              >
                Get service now
                <ArrowRight className="size-4" data-icon="inline-end" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 px-5 text-base"
                render={<a href={`tel:${SPEARS.phoneTel}`} />}
              >
                <Phone className="size-4" data-icon="inline-start" />
                Call {SPEARS.phoneDisplay}
              </Button>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-5 py-10">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <span className="font-heading text-lg font-bold tracking-tight">
                Spears&nbsp;Services
              </span>
              <p className="mt-1 text-sm text-muted-foreground">
                {BUSINESS_BASE_LOCATION.address}
              </p>
            </div>

            <dl className="grid gap-3 text-sm sm:text-right">
              <div className="flex flex-col gap-0.5 sm:items-end">
                <dt className="text-xs font-medium text-muted-foreground">Phone</dt>
                <dd>
                  <a
                    href={`tel:${SPEARS.phoneTel}`}
                    className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-link hover:underline"
                  >
                    {SPEARS.phoneDisplay}
                  </a>
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 sm:items-end">
                <dt className="text-xs font-medium text-muted-foreground">Email</dt>
                <dd>
                  <a
                    href={`mailto:${SPEARS.email}`}
                    className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-link hover:underline"
                  >
                    {SPEARS.email}
                  </a>
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 sm:items-end">
                <dt className="text-xs font-medium text-muted-foreground">AI phone assistant</dt>
                <dd>
                  <a
                    href={`tel:${DEMO_PHONE.tel}`}
                    className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-link hover:underline"
                  >
                    {DEMO_PHONE.display}
                  </a>
                </dd>
              </div>
            </dl>
          </div>

          <p className="mt-8 border-t border-border/60 pt-6 text-xs text-muted-foreground">
            &copy; 2026 Spears Services.
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Local presentational pieces ---------- */

interface SectionHeadingProps {
  eyebrow: string;
  title: string;
  subtitle: string;
}

function SectionHeading({ eyebrow, title, subtitle }: SectionHeadingProps) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <span className="inline-flex items-center gap-2 text-sm font-semibold text-brand-navy">
        <span className="h-px w-5 bg-brand-navy/50" aria-hidden />
        {eyebrow}
      </span>
      <h2 className="mt-3 font-heading text-3xl font-bold tracking-tight text-balance md:text-[2.6rem] md:leading-[1.1]">
        {title}
      </h2>
      <p className="mt-4 text-lg text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/** A static, on-brand mock of the chat to anchor the hero visually. */
function ChatPreview() {
  return (
    <div className="lp-float relative mx-auto w-full max-w-md">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-2xl shadow-black/10 backdrop-blur-xl">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-3">
          <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-primary to-[var(--hvac-accent)] text-primary-foreground">
            <Wind className="size-3.5" />
          </span>
          <span className="text-sm font-medium">Spears Assistant</span>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            online
          </span>
        </div>

        {/* messages */}
        <div className="space-y-3 p-4">
          <Bubble from="bot">
            Thanks for contacting Spears Services. What heating, cooling, or
            refrigeration issue can we help with?
          </Bubble>
          <Bubble from="user">Our walk-in cooler stopped holding temp overnight.</Bubble>
          <Bubble from="bot">
            That can put your product at risk, so let&apos;s move fast. What&apos;s
            the service address?
          </Bubble>

          {/* escalation chip */}
          <div className="flex items-center gap-2 rounded-lg border border-[var(--hvac-accent)]/30 bg-[var(--hvac-accent)]/10 px-3 py-2 text-xs font-medium text-[var(--hvac-accent)]">
            <ShieldAlert className="size-4 shrink-0" />
            Say &ldquo;I smell gas&rdquo; for instant safety escalation
          </div>
        </div>

        {/* input — a static preview, so it links to the real chat instead of
            looking like a text box that ignores typing */}
        <Link
          href="/chat"
          className="flex min-h-11 items-center gap-2 border-t border-border/60 px-4 py-3 text-sm font-medium text-foreground transition-colors duration-[var(--dur-hover)] hover:bg-muted/40"
        >
          <span className="flex-1">Start a real chat</span>
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <ArrowRight className="size-4" />
          </span>
        </Link>
      </div>

      {/* floating 24/7 badge */}
      <div className="absolute -right-4 -top-4 hidden rotate-3 items-center gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2 text-xs font-semibold shadow-lg sm:flex">
        <Clock className="size-3.5 text-brand-navy" />
        24/7 emergency
      </div>
    </div>
  );
}

interface BubbleProps {
  from: 'bot' | 'user';
  children: React.ReactNode;
}

function Bubble({ from, children }: BubbleProps) {
  if (from === 'user') {
    return (
      <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
        {children}
      </div>
    );
  }
  return (
    <div className="mr-auto max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-foreground">
      {children}
    </div>
  );
}
