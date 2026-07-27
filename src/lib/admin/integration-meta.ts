/**
 * Per-service icon + intent registry for the integrations page.
 *
 * Replaces the generic Plug/slate placeholder rendered for every card.
 * Add entries as new integrations are wired up; unmapped keys fall back
 * to the `default` entry so the UI never breaks on unknown services.
 */
import {
  Calendar,
  Zap,
  Wrench,
  CreditCard,
  Phone,
  Bot,
  Plug,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { IconChipIntent } from '@/components/admin/ui/icon-chip';

export interface IntegrationMeta {
  readonly icon: LucideIcon;
  readonly intent: IconChipIntent;
}

const REGISTRY: Record<string, IntegrationMeta> = {
  google_calendar: { icon: Calendar, intent: 'primary' },
  google_calendar_token: { icon: Calendar, intent: 'primary' },
  fieldpulse: { icon: Zap, intent: 'warning' },
  housecall_pro: { icon: Wrench, intent: 'success' },
  hcp: { icon: Wrench, intent: 'success' },
  stripe: { icon: CreditCard, intent: 'info' },
  twilio: { icon: Phone, intent: 'neutral' },
  ai: { icon: Bot, intent: 'primary' },
  anthropic: { icon: Bot, intent: 'primary' },
  openai: { icon: Bot, intent: 'primary' },
};

const DEFAULT_META: IntegrationMeta = { icon: Plug, intent: 'neutral' };

/**
 * Look up icon + intent for a given integration key.
 * Falls back to a generic Plug/neutral chip if the key is unrecognised.
 */
export function getIntegrationMeta(key: string): IntegrationMeta {
  // Try exact match first, then a prefix match on the first underscore segment
  return (
    REGISTRY[key] ??
    REGISTRY[key.split('_')[0]] ??
    DEFAULT_META
  );
}
