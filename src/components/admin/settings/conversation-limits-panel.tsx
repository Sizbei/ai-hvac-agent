'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_MAX_TURNS,
  TOKEN_BUDGET_MIN,
  TOKEN_BUDGET_MAX,
  MAX_TURNS_MIN,
  MAX_TURNS_MAX,
} from '@/lib/ai/chat-limits';
import type { OrgConfig, OrgConfigUpdate } from '@/lib/admin/org-config-types';
import { hasUnsavedChanges } from '@/lib/admin/unsaved-changes';
import { useReportDirty } from '@/hooks/use-unsaved-changes-guard';

interface ConversationLimitsPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
  /** Called when the draft starts or stops differing from what's saved. */
  readonly onDirtyChange?: (dirty: boolean) => void;
}

/** Empty input → null (reset to default). A parseable in-range int → that int.
 * Returns `undefined` to signal "invalid, block save". */
function parseLimit(
  raw: string,
  min: number,
  max: number,
): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

export function ConversationLimitsPanel({
  config,
  onSave,
  onDirtyChange,
}: ConversationLimitsPanelProps) {
  const [budget, setBudget] = useState(
    config.chatTokenBudget != null ? String(config.chatTokenBudget) : '',
  );
  const [turns, setTurns] = useState(
    config.chatMaxTurns != null ? String(config.chatMaxTurns) : '',
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = hasUnsavedChanges(
    {
      budget: config.chatTokenBudget != null ? String(config.chatTokenBudget) : '',
      turns: config.chatMaxTurns != null ? String(config.chatMaxTurns) : '',
    },
    { budget: budget.trim(), turns: turns.trim() },
  );
  useReportDirty(dirty, onDirtyChange);

  async function handleSave(): Promise<void> {
    const parsedBudget = parseLimit(budget, TOKEN_BUDGET_MIN, TOKEN_BUDGET_MAX);
    const parsedTurns = parseLimit(turns, MAX_TURNS_MIN, MAX_TURNS_MAX);

    // Report every bad field at once, not just the first.
    const problems: string[] = [];
    if (parsedBudget === undefined) {
      problems.push(
        `AI usage limit must be a whole number between ${TOKEN_BUDGET_MIN.toLocaleString()} and ${TOKEN_BUDGET_MAX.toLocaleString()}, or blank for the default.`,
      );
    }
    if (parsedTurns === undefined) {
      problems.push(
        `Max conversation turns must be a whole number between ${MAX_TURNS_MIN} and ${MAX_TURNS_MAX}, or blank for the default.`,
      );
    }
    if (parsedBudget === undefined || parsedTurns === undefined) {
      setError(problems.join(' '));
      return;
    }

    setError(null);
    setSaving(true);
    setSaved(false);
    const ok = await onSave({
      chatTokenBudget: parsedBudget,
      chatMaxTurns: parsedTurns,
    });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation limits</CardTitle>
        <CardDescription>
          Control how long an AI chat can run before it wraps up and hands off.
          These apply to new conversations. Leave a field blank to use the
          system default. Emergencies always escalate regardless of these
          limits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="chat-token-budget">AI usage limit per conversation</Label>
          <Input
            id="chat-token-budget"
            inputMode="numeric"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder={`Default: ${DEFAULT_TOKEN_BUDGET.toLocaleString()}`}
          />
          <p className="text-xs text-muted-foreground">
            Caps how much AI processing one chat can use, which keeps costs predictable. Range{' '}
            {TOKEN_BUDGET_MIN.toLocaleString()}–{TOKEN_BUDGET_MAX.toLocaleString()}.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="chat-max-turns">Max conversation turns</Label>
          <Input
            id="chat-max-turns"
            inputMode="numeric"
            value={turns}
            onChange={(e) => setTurns(e.target.value)}
            placeholder={`Default: ${DEFAULT_MAX_TURNS}`}
          />
          <p className="text-xs text-muted-foreground">
            After this many back-and-forth turns the assistant wraps up and
            offers a human. Range {MAX_TURNS_MIN}–{MAX_TURNS_MAX}.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
      <CardFooter>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : saved ? (
            <Check className="size-4" />
          ) : null}
          {saved ? 'Saved' : 'Save limits'}
        </Button>
      </CardFooter>
    </Card>
  );
}
