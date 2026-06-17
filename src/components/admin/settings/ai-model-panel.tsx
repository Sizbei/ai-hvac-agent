'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface ModelChoice {
  readonly id: string;
  readonly label: string;
}

interface ModelState {
  readonly choices: ModelChoice[];
  readonly selectedId: string | null;
}

/**
 * Super-admin-only AI model switcher + stateless test panel.
 *
 * The data endpoint (/api/admin/ai/model) is itself super_admin-gated, so a
 * non-super_admin gets a 403 and we render nothing — the server is the authority
 * for visibility, not the client. The panel only ever sees {id,label}.
 */
export function AiModelPanel() {
  const [state, setState] = useState<ModelState | null>(null);
  const [authorized, setAuthorized] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testPrompt, setTestPrompt] = useState('Reply with a one-line hello.');
  const [testModelId, setTestModelId] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [testReply, setTestReply] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/ai/model');
        if (res.status === 403 || res.status === 401) {
          if (!cancelled) setAuthorized(false);
          return;
        }
        const json = await res.json();
        if (!cancelled && json.success) {
          const data = json.data as ModelState;
          setState(data);
          setTestModelId(data.selectedId ?? data.choices[0]?.id ?? '');
        }
      } catch {
        if (!cancelled) setAuthorized(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authorized) return null;

  async function handleSelect(modelId: string): Promise<void> {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch('/api/admin/ai/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setState((prev) => (prev ? { ...prev, selectedId: modelId } : prev));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(json.error?.message ?? 'Could not save the model selection.');
      }
    } catch {
      setError('Could not save the model selection.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    setTestError(null);
    setTestReply(null);
    setTesting(true);
    try {
      const res = await fetch('/api/admin/ai/model/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: testModelId, prompt: testPrompt }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        if (json.data.error === 'key_not_configured') {
          setTestError('This model has no API key configured in the environment.');
        } else if (json.data.error === 'model_call_failed') {
          setTestError('The model call failed. Check the provider configuration.');
        } else {
          setTestReply(json.data.reply ?? '');
        }
      } else {
        setTestError(json.error?.message ?? 'Test failed.');
      }
    } catch {
      setTestError('Test failed.');
    } finally {
      setTesting(false);
    }
  }

  if (!state) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI model</CardTitle>
        <CardDescription>
          Choose which LLM powers this organization&apos;s assistant. Used for
          A/B testing models. Changes take effect on the next conversation turn.
          A model with no API key configured silently falls back to the default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="ai-model-select">Active model</Label>
          <div className="flex items-center gap-3">
            <Select
              value={state.selectedId ?? undefined}
              onValueChange={(v) => {
                if (v) void handleSelect(v);
              }}
              disabled={saving}
            >
              <SelectTrigger id="ai-model-select" className="max-w-sm">
                <SelectValue placeholder="Use environment default" />
              </SelectTrigger>
              <SelectContent>
                {state.choices.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {saved && <Check className="size-4 text-emerald-600" />}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-2">
            <Label htmlFor="ai-model-test-model">Test a model</Label>
            <Select
              value={testModelId}
              onValueChange={(v) => setTestModelId(v ?? '')}
            >
              <SelectTrigger id="ai-model-test-model" className="max-w-sm">
                <SelectValue placeholder="Pick a model to test" />
              </SelectTrigger>
              <SelectContent>
                {state.choices.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-model-test-prompt">Prompt</Label>
            <textarea
              id="ai-model-test-prompt"
              value={testPrompt}
              onChange={(e) => setTestPrompt(e.target.value)}
              maxLength={2000}
              rows={3}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest()}
            disabled={testing || !testModelId || testPrompt.trim().length === 0}
          >
            {testing && <Loader2 className="size-4 animate-spin" />}
            Run test
          </Button>
          {testReply !== null && (
            <div className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">
              {testReply || '(empty reply)'}
            </div>
          )}
          {testError && <p className="text-sm text-destructive">{testError}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
