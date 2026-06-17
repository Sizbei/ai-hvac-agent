"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Template {
  id: string;
  key: string;
  name: string;
  description: string | null;
  triggerType: string;
  templateType: string;
  subjectTemplate: string | null;
  bodyTemplate: string;
  isActive: boolean;
  priority: number;
  variables: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const TRIGGER_TYPES = [
  { value: "appointment_scheduled", label: "Appointment Scheduled" },
  { value: "appointment_reminder_24h", label: "24-Hour Reminder" },
  { value: "appointment_reminder_2h", label: "2-Hour Reminder" },
  { value: "appointment_rescheduled", label: "Appointment Rescheduled" },
  { value: "appointment_cancelled", label: "Appointment Cancelled" },
  { value: "technician_enroute", label: "Technician En Route" },
  { value: "job_completed", label: "Job Completed" },
  { value: "review_request", label: "Review Request" },
  { value: "follow_up", label: "Follow Up" },
  { value: "escalation", label: "Escalation" },
] as const;

export const TEMPLATE_TYPES = [
  { value: "sms", label: "SMS" },
  { value: "email_html", label: "Email (HTML)" },
  { value: "email_text", label: "Email (Plain Text)" },
] as const;

const TEXTAREA_CLASS =
  "flex w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

interface TemplateEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** When provided, the dialog edits; otherwise it creates. */
  readonly template: Template | null;
  readonly onSaved: () => void;
}

function buildInitialForm(template: Template | null) {
  return {
    key: template?.key ?? "",
    name: template?.name ?? "",
    description: template?.description ?? "",
    triggerType: template?.triggerType ?? "appointment_scheduled",
    templateType: template?.templateType ?? "sms",
    subjectTemplate: template?.subjectTemplate ?? "",
    bodyTemplate: template?.bodyTemplate ?? "",
    isActive: template?.isActive ?? true,
    priority: template?.priority ?? 50,
  };
}

/**
 * Create/edit dialog for a communication template. Posts to the existing
 * templates API (POST to create, PATCH to update). The parent remounts the
 * inner form (via `key`) on each open so the form re-seeds without an effect.
 */
export function TemplateEditorDialog({
  open,
  onOpenChange,
  template,
  onSaved,
}: TemplateEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Remount the form on each open / template change so its state
       * re-seeds from the latest props without a setState-in-effect. */}
      {open && (
        <TemplateEditorForm
          key={template?.id ?? "new"}
          template={template}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function TemplateEditorForm({
  template,
  onOpenChange,
  onSaved,
}: {
  readonly template: Template | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}) {
  const [form, setForm] = useState(() => buildInitialForm(template));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEmail = form.templateType.startsWith("email");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const url = template
        ? `/api/admin/communications/templates/${template.id}`
        : "/api/admin/communications/templates";
      const method = template ? "PATCH" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save template");
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {template ? "Edit template" : "Create template"}
        </DialogTitle>
        <DialogDescription>
          Use {"{{ variable }}"} placeholders to insert customer and appointment
          details.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="template-key">Template key</Label>
            <Input
              id="template-key"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="e.g. appointment_scheduled_sms"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-priority">Priority</Label>
            <Input
              id="template-priority"
              type="number"
              value={form.priority}
              onChange={(e) =>
                setForm({
                  ...form,
                  priority: Number.parseInt(e.target.value, 10) || 0,
                })
              }
              min={0}
              max={100}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="template-name">Name</Label>
          <Input
            id="template-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="template-description">Description</Label>
          <textarea
            id="template-description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={2}
            className={TEXTAREA_CLASS}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="template-trigger">Trigger type</Label>
            <Select
              value={form.triggerType}
              onValueChange={(v) =>
                setForm({ ...form, triggerType: v ?? "appointment_scheduled" })
              }
            >
              <SelectTrigger id="template-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-type">Template type</Label>
            <Select
              value={form.templateType}
              onValueChange={(v) =>
                setForm({ ...form, templateType: v ?? "sms" })
              }
            >
              <SelectTrigger id="template-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isEmail && (
          <div className="space-y-2">
            <Label htmlFor="template-subject">Subject line</Label>
            <Input
              id="template-subject"
              value={form.subjectTemplate}
              onChange={(e) =>
                setForm({ ...form, subjectTemplate: e.target.value })
              }
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="template-body">Message body</Label>
          <textarea
            id="template-body"
            value={form.bodyTemplate}
            onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })}
            rows={6}
            className={`${TEXTAREA_CLASS} font-mono`}
            required
          />
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="template-active"
            checked={form.isActive}
            onCheckedChange={(checked) =>
              setForm({ ...form, isActive: checked })
            }
          />
          <Label htmlFor="template-active">Active</Label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : template ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
