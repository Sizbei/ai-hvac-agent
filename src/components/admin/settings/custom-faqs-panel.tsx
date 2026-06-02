'use client';

import { useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import type { CustomFaq, CustomFaqInput } from '@/lib/admin/org-config-types';

interface CustomFaqsPanelProps {
  readonly faqs: readonly CustomFaq[];
  readonly onCreate: (input: CustomFaqInput) => Promise<boolean>;
  readonly onUpdate: (
    id: string,
    input: Partial<CustomFaqInput>,
  ) => Promise<boolean>;
  readonly onDelete: (id: string) => Promise<boolean>;
}

export function CustomFaqsPanel({
  faqs,
  onCreate,
  onUpdate,
  onDelete,
}: CustomFaqsPanelProps) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [triggersRaw, setTriggersRaw] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canCreate = question.trim().length > 0 && answer.trim().length > 0;

  async function handleCreate(): Promise<void> {
    if (!canCreate) return;
    setCreating(true);
    const triggers = triggersRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const ok = await onCreate({
      question: question.trim(),
      answer: answer.trim(),
      triggers: triggers.length > 0 ? triggers : undefined,
    });
    setCreating(false);
    if (ok) {
      setQuestion('');
      setAnswer('');
      setTriggersRaw('');
    }
  }

  async function handleToggle(faq: CustomFaq): Promise<void> {
    setBusyId(faq.id);
    await onUpdate(faq.id, { isActive: !faq.isActive });
    setBusyId(null);
  }

  async function handleDelete(id: string): Promise<void> {
    setBusyId(id);
    await onDelete(id);
    setBusyId(null);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Add a custom answer</CardTitle>
          <CardDescription>
            Teach the assistant a company-specific question and answer. It checks
            these before its built-in answers (but never before an emergency).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="faq-question">Question</Label>
            <Input
              id="faq-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Do you offer a maintenance membership?"
              maxLength={300}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="faq-answer">Answer</Label>
            <textarea
              id="faq-answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Yes! Our Comfort Club is $19/mo and includes two tune-ups a year…"
              maxLength={2000}
              rows={3}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="faq-triggers">
              Trigger phrases{' '}
              <span className="font-normal text-muted-foreground">
                (comma-separated; defaults to the question)
              </span>
            </Label>
            <Input
              id="faq-triggers"
              value={triggersRaw}
              onChange={(e) => setTriggersRaw(e.target.value)}
              placeholder="membership, comfort club, maintenance plan"
            />
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={handleCreate} disabled={!canCreate || creating}>
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add answer
          </Button>
        </CardFooter>
      </Card>

      <div className="space-y-3">
        <p className="text-sm font-medium">
          Your custom answers{' '}
          <span className="text-muted-foreground">({faqs.length})</span>
        </p>
        {faqs.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            No custom answers yet. Add one above.
          </p>
        ) : (
          faqs.map((faq) => (
            <Card key={faq.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{faq.question}</p>
                    {!faq.isActive && (
                      <Badge variant="secondary" className="shrink-0">
                        Off
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{faq.answer}</p>
                  {faq.triggers.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {faq.triggers.map((t) => (
                        <Badge key={t} variant="outline" className="text-xs">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    aria-label="Toggle active"
                    checked={faq.isActive}
                    disabled={busyId === faq.id}
                    onCheckedChange={() => handleToggle(faq)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === faq.id}
                    onClick={() => handleDelete(faq.id)}
                    aria-label="Delete custom answer"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    {busyId === faq.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
