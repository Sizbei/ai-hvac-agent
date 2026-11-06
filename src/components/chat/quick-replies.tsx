'use client';

import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Thermometer,
  Snowflake,
  IceCream,
  Flame,
  CookingPot,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// De-pilled machined key: 6px radius, hairline border, 44px touch height,
// colour-only transition with a 0.5px mechanical settle on press.
const CHIP_BASE =
  'inline-flex min-h-11 items-center rounded-md border px-3 text-[13px] font-medium transition-[background-color,border-color,color] duration-[var(--dur-hover)] ease-[var(--ease-out)] active:translate-y-[0.5px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50 disabled:pointer-events-none';

interface QuickReplyGroup {
  readonly label: string;
  readonly icon: typeof Snowflake;
  readonly color: string;
  readonly replies: readonly QuickReply[];
}

interface QuickReply {
  readonly text: string;
  readonly message: string;
}

// Spears Services' five service lines (spearsservices.com) — commercial-first.
// Each reply's `message` is phrased to route to the matching intake intent in
// knowledge-base.ts. Keep these aligned with the site's Services menu.
const GROUPS: readonly QuickReplyGroup[] = [
  {
    label: 'HVAC',
    icon: Thermometer,
    color: 'border-border-input bg-surface-raised text-foreground hover:bg-accent',
    replies: [
      { text: 'Not cooling', message: 'Our HVAC system is running but not cooling — it\'s just blowing warm air.' },
      { text: 'Not heating', message: 'Our HVAC system is running but not heating.' },
      { text: 'Won\'t turn on', message: 'Our HVAC unit won\'t turn on at all — nothing happens at the thermostat.' },
      { text: 'Making noise / leaking', message: 'Our HVAC unit is making a loud noise / leaking water.' },
    ],
  },
  {
    label: 'Refrigeration',
    icon: Snowflake,
    color: 'border-border-input bg-surface-raised text-foreground hover:bg-accent',
    replies: [
      { text: 'Walk-in cooler not cooling', message: 'Our walk-in cooler is not holding temperature / not cooling.' },
      { text: 'Reach-in freezer not freezing', message: 'Our reach-in freezer is not freezing / not staying cold.' },
      { text: 'Display case warm', message: 'Our display case isn\'t cold — the product is getting warm.' },
      { text: 'Beverage cooler down', message: 'Our beverage cooler stopped cooling.' },
    ],
  },
  {
    label: 'Ice machine',
    icon: IceCream,
    color: 'border-border-input bg-surface-raised text-foreground hover:bg-accent',
    replies: [
      { text: 'Not making ice', message: 'Our commercial ice machine has stopped making ice.' },
      { text: 'Low ice production', message: 'Our ice machine is barely producing any ice.' },
      { text: 'Leaking water', message: 'Our ice machine is leaking water.' },
      { text: 'PM / service contract', message: 'I\'d like to set up preventive maintenance for our commercial ice machine.' },
    ],
  },
  {
    label: 'Boiler',
    icon: Flame,
    color: 'border-border-input bg-surface-raised text-foreground hover:bg-accent',
    replies: [
      { text: 'No heat from boiler', message: 'Our boiler is not producing heat.' },
      { text: 'Boiler won\'t fire', message: 'Our boiler won\'t fire up / won\'t start.' },
      { text: 'Boiler leaking', message: 'Our boiler is leaking.' },
      { text: 'Boiler PM plan', message: 'I\'d like to set up a preventive maintenance plan for our boiler.' },
    ],
  },
  {
    label: 'Commercial appliance',
    icon: CookingPot,
    color: 'border-border-input bg-surface-raised text-foreground hover:bg-accent',
    replies: [
      { text: 'Oven / range down', message: 'Our commercial oven / range has stopped working.' },
      { text: 'Fryer not heating', message: 'Our commercial fryer is not heating up.' },
      { text: 'Other kitchen equipment', message: 'A piece of our commercial kitchen equipment has stopped working.' },
    ],
  },
  {
    label: 'Emergency',
    icon: AlertTriangle,
    color: 'border-danger-border bg-danger-light text-danger-strong hover:bg-danger-light/70',
    replies: [
      { text: 'Gas smell', message: 'I smell gas near our equipment. This is urgent.' },
      { text: 'Carbon monoxide alarm', message: 'Our carbon monoxide detector is going off.' },
      { text: 'Equipment down — losing product', message: 'Our refrigeration is down and we\'re about to lose product. We need emergency help.' },
    ],
  },
];

interface QuickRepliesProps {
  readonly onSelect: (message: string) => void;
  readonly disabled?: boolean;
}

export function QuickReplies({ onSelect, disabled }: QuickRepliesProps) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground px-1">
        What can we help with? Tap a service:
      </p>

      {/* Category chips */}
      <div className="flex flex-wrap gap-1.5">
        {GROUPS.map((group) => {
          const Icon = group.icon;
          const isExpanded = expandedGroup === group.label;
          return (
            <button
              key={group.label}
              type="button"
              disabled={disabled}
              onClick={() =>
                setExpandedGroup(isExpanded ? null : group.label)
              }
              aria-expanded={isExpanded}
              aria-controls={`replies-${group.label}`}
              className={cn(
                CHIP_BASE,
                'gap-1.5',
                group.color,
                // Expansion reads as a state change on the same family: the
                // hairline goes marker-teal, no ring, no fill swap.
                isExpanded && 'border-marker',
              )}
            >
              <Icon className="size-3.5" />
              {group.label}
              <ChevronDown
                className={`size-3 transition-transform duration-200 ease-out ${isExpanded ? 'rotate-180' : ''}`}
              />
            </button>
          );
        })}
      </div>

      {/* Expanded replies */}
      <AnimatePresence mode="wait">
        {expandedGroup && (
          <motion.div
            key={expandedGroup}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div
              id={`replies-${expandedGroup}`}
              role="group"
              aria-label={`${expandedGroup} issues`}
              className="flex flex-wrap gap-1.5 pt-1"
            >
              {GROUPS.find((g) => g.label === expandedGroup)?.replies.map(
                (reply, i) => (
                  <motion.button
                    key={reply.text}
                    type="button"
                    disabled={disabled}
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.15,
                      ease: 'easeOut',
                      delay: reduceMotion ? 0 : i * 0.03,
                    }}
                    onClick={() => {
                      onSelect(reply.message);
                      setExpandedGroup(null);
                    }}
                    className={cn(
                      CHIP_BASE,
                      'border-border-input bg-surface-raised font-normal text-foreground hover:bg-accent',
                    )}
                  >
                    {reply.text}
                  </motion.button>
                ),
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
