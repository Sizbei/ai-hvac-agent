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
    color: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
    replies: [
      { text: 'Not cooling', message: 'Our HVAC system is running but not cooling — it\'s just blowing warm air.' },
      { text: 'Not heating', message: 'Our HVAC system is running but not putting out any heat.' },
      { text: 'Won\'t turn on', message: 'Our HVAC unit won\'t turn on at all — nothing happens at the thermostat.' },
      { text: 'Making noise / leaking', message: 'Our HVAC unit is making a loud noise / leaking water.' },
    ],
  },
  {
    label: 'Refrigeration',
    icon: Snowflake,
    color: 'bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100',
    replies: [
      { text: 'Walk-in cooler not cooling', message: 'Our walk-in cooler is not holding temperature / not cooling.' },
      { text: 'Reach-in freezer not freezing', message: 'Our reach-in freezer is not freezing / not staying cold.' },
      { text: 'Display case warm', message: 'Our display case isn\'t cold — the product is getting warm.' },
      { text: 'Beverage cooler down', message: 'Our beverage cooler stopped cooling.' },
    ],
  },
  {
    label: 'Ice Machine',
    icon: IceCream,
    color: 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100',
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
    color: 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100',
    replies: [
      { text: 'No heat from boiler', message: 'Our boiler is not producing heat.' },
      { text: 'Boiler won\'t fire', message: 'Our boiler won\'t fire up / won\'t start.' },
      { text: 'Boiler leaking', message: 'Our boiler is leaking.' },
      { text: 'Boiler PM plan', message: 'I\'d like to set up a preventive maintenance plan for our boiler.' },
    ],
  },
  {
    label: 'Commercial Appliance',
    icon: CookingPot,
    color: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100',
    replies: [
      { text: 'Oven / range down', message: 'Our commercial oven / range has stopped working.' },
      { text: 'Fryer not heating', message: 'Our commercial fryer is not heating up.' },
      { text: 'Other kitchen equipment', message: 'A piece of our commercial kitchen equipment has stopped working.' },
    ],
  },
  {
    label: 'Emergency',
    icon: AlertTriangle,
    color: 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100',
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
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none ${
                isExpanded
                  ? group.color + ' ring-1 ring-current/20'
                  : group.color
              }`}
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
                    className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-[background-color,border-color,color,scale] duration-150 ease-out hover:bg-muted active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
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
