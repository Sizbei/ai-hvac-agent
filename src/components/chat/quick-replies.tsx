'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Snowflake,
  Flame,
  Wind,
  AlertTriangle,
  Wrench,
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

const GROUPS: readonly QuickReplyGroup[] = [
  {
    label: 'Cooling',
    icon: Snowflake,
    color: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
    replies: [
      { text: 'AC not cooling', message: 'My air conditioner is running but not cooling the house. It just blows warm air.' },
      { text: 'AC leaking water', message: 'My AC unit is leaking water inside the house.' },
      { text: 'AC making noise', message: 'My air conditioner is making a loud grinding/buzzing noise.' },
      { text: 'AC won\'t turn on', message: 'My AC unit won\'t turn on at all. Nothing happens when I set the thermostat to cool.' },
    ],
  },
  {
    label: 'Heating',
    icon: Flame,
    color: 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100',
    replies: [
      { text: 'Furnace not heating', message: 'My furnace is running but the house isn\'t getting warm.' },
      { text: 'No hot water', message: 'My water heater stopped producing hot water.' },
      { text: 'Furnace won\'t start', message: 'My furnace won\'t ignite or start up when I turn the thermostat to heat.' },
      { text: 'Pilot light out', message: 'The pilot light on my furnace/water heater went out and I can\'t relight it.' },
    ],
  },
  {
    label: 'Air Quality',
    icon: Wind,
    color: 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-100',
    replies: [
      { text: 'Bad smell from vents', message: 'There\'s a musty/burning smell coming from my air vents.' },
      { text: 'Weak airflow', message: 'The airflow from my vents is very weak, barely any air is coming out.' },
      { text: 'Too much dust', message: 'There\'s excessive dust in my house even after cleaning. I think it\'s coming from the HVAC.' },
    ],
  },
  {
    label: 'Emergency',
    icon: AlertTriangle,
    color: 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100',
    replies: [
      { text: 'Gas smell', message: 'I smell gas near my furnace or in my home. This is urgent.' },
      { text: 'Carbon monoxide alarm', message: 'My carbon monoxide detector is going off and I think it might be related to my furnace.' },
      { text: 'Complete system failure', message: 'My entire HVAC system stopped working and it\'s extremely hot/cold outside. I need emergency help.' },
    ],
  },
  {
    label: 'Maintenance',
    icon: Wrench,
    color: 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100',
    replies: [
      { text: 'Annual tune-up', message: 'I\'d like to schedule an annual HVAC tune-up and maintenance check.' },
      { text: 'Filter replacement', message: 'I need help with replacing my HVAC air filter. I\'m not sure what size I need.' },
      { text: 'Thermostat issues', message: 'My thermostat display is blank / not responding / showing wrong temperature.' },
    ],
  },
];

interface QuickRepliesProps {
  readonly onSelect: (message: string) => void;
  readonly disabled?: boolean;
}

export function QuickReplies({ onSelect, disabled }: QuickRepliesProps) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground px-1">
        Common issues — tap to describe yours:
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
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none ${
                isExpanded
                  ? group.color + ' ring-1 ring-current/20'
                  : group.color
              }`}
            >
              <Icon className="size-3.5" />
              {group.label}
              <ChevronDown
                className={`size-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
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
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div
              id={`replies-${expandedGroup}`}
              role="group"
              aria-label={`${expandedGroup} issues`}
              className="flex flex-wrap gap-1.5 pt-1"
            >
              {GROUPS.find((g) => g.label === expandedGroup)?.replies.map(
                (reply) => (
                  <button
                    key={reply.text}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onSelect(reply.message);
                      setExpandedGroup(null);
                    }}
                    className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {reply.text}
                  </button>
                ),
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
