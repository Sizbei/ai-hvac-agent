import Link from 'next/link';
import { Bricolage_Grotesque } from 'next/font/google';
import {
  ArrowRight,
  Wind,
  Flame,
  Zap,
  ShieldAlert,
  Lock,
  GitBranch,
  Gauge,
  MessagesSquare,
  LayoutDashboard,
  BrainCircuit,
  CheckCircle2,
  Code2,
  BookOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
});

const NAV = [
  { label: 'Live demo', href: '/chat' },
  { label: 'Admin', href: '/admin' },
  { label: 'Docs', href: '/docs.html' },
];

const STATS = [
  { value: '~55%', label: 'turns answered with zero LLM tokens' },
  { value: '65', label: 'deterministic intents in the router' },
  { value: '<150ms', label: 'typical canned-answer latency' },
  { value: 'AES-256', label: 'GCM encryption on every PII field' },
];

const HIGHLIGHTS = [
  {
    icon: Zap,
    title: 'A 0-token intent router',
    body: 'Greetings, FAQs, emergencies, and slot-collection resolve deterministically. The LLM is the fallback for novel input only — most turns cost nothing.',
  },
  {
    icon: ShieldAlert,
    title: 'Safety-first escalation',
    body: 'Gas, CO, fire, and flooding messages short-circuit with qualifier-gated matching, return safety guidance, and lock the session instantly.',
  },
  {
    icon: BrainCircuit,
    title: 'Tolerant extraction',
    body: 'Conversations distill into a validated service request via generateText + a forgiving JSON parser — because the model endpoint ignores strict schema mode.',
  },
  {
    icon: Lock,
    title: 'Security posture',
    body: 'Field-level PII encryption, JWT admin auth, multi-tenant query scoping, per-IP rate limiting, per-session token budgets, and audit logging.',
  },
  {
    icon: GitBranch,
    title: 'Multi-tenant by design',
    body: 'Every query is scoped to an organization through a single helper, so one deployment cleanly serves many HVAC companies.',
  },
  {
    icon: Gauge,
    title: 'Built-in observability',
    body: 'An AI Insights dashboard tracks deflection rate, the intake funnel, and 👍/👎 feedback — so you can see what the router is saving.',
  },
];

const STACK = [
  'Next.js 16',
  'TypeScript',
  'Vercel AI SDK v6',
  'Qwen · DashScope',
  'Drizzle ORM',
  'Neon Postgres',
  'Tailwind v4',
];

/** Animation delay helper — keeps staggered reveals declarative. */
function delay(ms: number): React.CSSProperties {
  return { animationDelay: `${ms}ms` };
}

export default function Home() {
  return (
    <div className={`${display.variable} relative min-h-dvh overflow-x-clip bg-background text-foreground`}>
      {/* Atmosphere */}
      <div className="lp-mesh pointer-events-none absolute inset-0 -z-10" aria-hidden />
      <div className="lp-grid pointer-events-none absolute inset-0 -z-10 h-[120vh]" aria-hidden />

      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="relative flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[var(--hvac-accent)] text-white shadow-sm">
              <Wind className="size-4" strokeWidth={2.25} />
            </span>
            <span className="font-[family-name:var(--font-display)] text-lg font-bold tracking-tight">
              HVAC&nbsp;Agent
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

          <Button
            size="lg"
            className="bg-foreground text-background hover:bg-foreground/85"
            render={<Link href="/chat" />}
          >
            Try it live
            <ArrowRight className="size-4" data-icon="inline-end" />
          </Button>
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
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--hvac-accent)] opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-[var(--hvac-accent)]" />
              </span>
              AI intake agent · live demo
            </div>

            <h1
              className="lp-rise mt-5 font-[family-name:var(--font-display)] text-5xl font-extrabold leading-[1.02] tracking-tight md:text-6xl"
              style={delay(80)}
            >
              The HVAC chatbot that{' '}
              <span className="bg-gradient-to-r from-primary via-primary to-[var(--hvac-accent)] bg-clip-text text-transparent">
                spends tokens only when it has to
              </span>
            </h1>

            <p
              className="lp-rise mt-5 max-w-xl text-lg text-muted-foreground"
              style={delay(160)}
            >
              Customers describe a heating or cooling problem in chat. A
              deterministic router answers the common stuff for free, escalates
              emergencies instantly, and turns the rest into a structured service
              request your staff can dispatch.
            </p>

            <div className="lp-rise mt-8 flex flex-wrap items-center gap-3" style={delay(240)}>
              <Button
                size="lg"
                className="h-11 bg-primary px-5 text-base text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90"
                render={<Link href="/chat" />}
              >
                Start a conversation
                <ArrowRight className="size-4" data-icon="inline-end" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 px-5 text-base"
                render={<Link href="/admin" />}
              >
                <LayoutDashboard className="size-4" data-icon="inline-start" />
                Open the dashboard
              </Button>
            </div>

            <p className="lp-rise mt-4 text-sm text-muted-foreground" style={delay(300)}>
              Admin login{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                admin@demo-hvac.com
              </code>{' '}
              /{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                admin123
              </code>
            </p>
          </div>

          {/* Right: chat preview */}
          <div className="lp-rise" style={delay(360)}>
            <ChatPreview />
          </div>
        </section>

        {/* Stat band */}
        <section className="lp-rise grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border/70 bg-border/70 lg:grid-cols-4" style={delay(420)}>
          {STATS.map((s) => (
            <div key={s.label} className="bg-card/80 p-6 backdrop-blur">
              <div className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-foreground">
                {s.value}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </section>

        {/* Two surfaces */}
        <section className="py-20 md:py-28">
          <SectionHeading
            eyebrow="One system, two surfaces"
            title="A customer chat and a staff cockpit"
            subtitle="The same conversation flows from the customer-facing agent straight into a triage-ready admin dashboard."
          />
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <SurfaceCard
              icon={MessagesSquare}
              tone="cool"
              title="Customer chat"
              href="/chat"
              cta="Open the chat"
              points={[
                'AI disclosure + one-tap human handoff',
                'Intake progress stepper as details are captured',
                'Suggested replies, 👍/👎 feedback, resume on refresh',
                'Instant safety escalation for dangerous situations',
              ]}
            />
            <SurfaceCard
              icon={LayoutDashboard}
              tone="warm"
              title="Admin dashboard"
              href="/admin"
              cta="Open the dashboard"
              points={[
                'Service-request queue with technician assignment',
                'Searchable log of every saved conversation',
                'AI Insights: deflection rate, funnel, feedback',
                'Customer CRM with equipment and service history',
              ]}
            />
          </div>
        </section>

        {/* Engineering highlights */}
        <section className="pb-20 md:pb-28">
          <SectionHeading
            eyebrow="Under the hood"
            title="Engineering worth reading the code for"
            subtitle="This is a portfolio project — the interesting parts are the decisions, not just the features."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {HIGHLIGHTS.map((h) => (
              <article
                key={h.title}
                className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/60 p-6 backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <h.icon className="size-5" strokeWidth={2} />
                </div>
                <h3 className="mt-4 font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight">
                  {h.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {h.body}
                </p>
              </article>
            ))}
          </div>

          {/* Tech stack */}
          <div className="mt-12 flex flex-wrap items-center justify-center gap-2.5">
            {STACK.map((t) => (
              <span
                key={t}
                className="rounded-full border border-border/70 bg-card/60 px-3.5 py-1.5 text-sm font-medium text-muted-foreground backdrop-blur"
              >
                {t}
              </span>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="pb-24">
          <div className="relative overflow-hidden rounded-3xl border border-border/70 bg-gradient-to-br from-primary/8 via-card to-[var(--hvac-accent)]/8 p-10 text-center md:p-16">
            <Flame className="lp-float absolute -right-6 -top-6 size-32 text-[var(--hvac-accent)]/10" aria-hidden />
            <Wind className="lp-float absolute -bottom-8 -left-6 size-32 text-primary/10" style={delay(800)} aria-hidden />
            <h2 className="relative font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight md:text-4xl">
              See it answer, escalate, and triage
            </h2>
            <p className="relative mx-auto mt-3 max-w-xl text-muted-foreground">
              Try the customer chat, then sign in to watch the request land in the
              admin queue — or read how it&apos;s built.
            </p>
            <div className="relative mt-7 flex flex-wrap justify-center gap-3">
              <Button
                size="lg"
                className="h-11 bg-primary px-5 text-base text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90"
                render={<Link href="/chat" />}
              >
                Try the live demo
                <ArrowRight className="size-4" data-icon="inline-end" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 px-5 text-base"
                render={<Link href="/docs.html" />}
              >
                <BookOpen className="size-4" data-icon="inline-start" />
                Read the docs
              </Button>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/60 bg-background/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-primary to-[var(--hvac-accent)] text-white">
              <Wind className="size-3.5" />
            </span>
            <span>AI HVAC Agent — a full-stack portfolio project</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/docs.html" className="transition-colors hover:text-foreground">
              Docs
            </Link>
            <Link
              href="https://github.com/Sizbei/ai-hvac-agent"
              className="flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <Code2 className="size-4" />
              Source
            </Link>
          </div>
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
      <span className="text-sm font-semibold uppercase tracking-widest text-[var(--hvac-accent)]">
        {eyebrow}
      </span>
      <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight md:text-4xl">
        {title}
      </h2>
      <p className="mt-3 text-muted-foreground">{subtitle}</p>
    </div>
  );
}

interface SurfaceCardProps {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: 'cool' | 'warm';
  title: string;
  href: string;
  cta: string;
  points: readonly string[];
}

function SurfaceCard({ icon: Icon, tone, title, href, cta, points }: SurfaceCardProps) {
  const accent = tone === 'cool' ? 'text-primary' : 'text-[var(--hvac-accent)]';
  const ring = tone === 'cool' ? 'hover:border-primary/40' : 'hover:border-[var(--hvac-accent)]/40';
  return (
    <div
      className={`flex flex-col rounded-2xl border border-border/70 bg-card/60 p-7 backdrop-blur transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 ${ring}`}
    >
      <div className={`flex size-11 items-center justify-center rounded-xl bg-muted ${accent}`}>
        <Icon className="size-5" strokeWidth={2} />
      </div>
      <h3 className="mt-4 font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight">
        {title}
      </h3>
      <ul className="mt-4 flex flex-1 flex-col gap-2.5">
        {points.map((p) => (
          <li key={p} className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <CheckCircle2 className={`mt-0.5 size-4 shrink-0 ${accent}`} />
            {p}
          </li>
        ))}
      </ul>
      <Button variant="ghost" className="mt-6 w-fit px-0 text-foreground hover:bg-transparent hover:text-primary" render={<Link href={href} />}>
        {cta}
        <ArrowRight className="size-4" data-icon="inline-end" />
      </Button>
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
          <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-primary to-[var(--hvac-accent)] text-white">
            <Wind className="size-3.5" />
          </span>
          <span className="text-sm font-medium">HVAC Assistant</span>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            online
          </span>
        </div>

        {/* messages */}
        <div className="space-y-3 p-4">
          <Bubble from="bot">
            Hi! I&apos;m an AI HVAC assistant. What heating, cooling, or air
            quality issue are you having?
          </Bubble>
          <Bubble from="user">My AC isn&apos;t cooling and it&apos;s 85° inside.</Bubble>
          <Bubble from="bot">
            That sounds uncomfortable — let&apos;s get a technician out. What&apos;s
            the service address?
          </Bubble>

          {/* escalation chip */}
          <div className="flex items-center gap-2 rounded-lg border border-[var(--hvac-accent)]/30 bg-[var(--hvac-accent)]/10 px-3 py-2 text-xs font-medium text-[var(--hvac-accent)]">
            <ShieldAlert className="size-4 shrink-0" />
            Say &ldquo;I smell gas&rdquo; → instant safety escalation
          </div>
        </div>

        {/* input */}
        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
          <div className="flex-1 rounded-full bg-muted px-4 py-2 text-sm text-muted-foreground">
            Type your message…
          </div>
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <ArrowRight className="size-4" />
          </span>
        </div>
      </div>

      {/* floating token badge */}
      <div className="absolute -right-4 -top-4 hidden rotate-3 items-center gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2 text-xs font-semibold shadow-lg sm:flex">
        <Zap className="size-3.5 text-[var(--hvac-accent)]" />
        0 tokens used
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
