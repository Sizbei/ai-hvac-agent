/**
 * Communication Templates Admin Page
 *
 * Admin interface for managing communication templates.
 * View, edit, create, activate/deactivate, and delete templates.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  MailPlus,
  MessageSquareText,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageShell } from "@/components/admin/ui/page-shell";
import { PageHeader } from "@/components/admin/ui/page-header";
import { EmptyState } from "@/components/admin/ui/empty-state";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import {
  TemplateEditorDialog,
  TRIGGER_TYPES,
  TEMPLATE_TYPES,
  type Template,
} from "@/components/admin/communications/template-editor-dialog";

export default function CommunicationTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<Template | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/admin/communications/templates");
      if (!response.ok) throw new Error("Failed to fetch templates");
      const data = await response.json();
      setTemplates(data.templates || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);

  const handleToggleActive = useCallback(
    async (template: Template) => {
      try {
        const response = await fetch(
          `/api/admin/communications/templates/${template.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive: !template.isActive }),
          },
        );
        if (!response.ok) throw new Error("Failed to update template");
        await fetchTemplates();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [fetchTemplates],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingTemplate) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        `/api/admin/communications/templates/${deletingTemplate.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Failed to delete template");
      setDeletingTemplate(null);
      await fetchTemplates();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsDeleting(false);
    }
  }, [deletingTemplate, fetchTemplates]);

  const openCreate = () => {
    setEditingTemplate(null);
    setEditorOpen(true);
  };

  const openEdit = (template: Template) => {
    setEditingTemplate(template);
    setEditorOpen(true);
  };

  return (
    <PageShell>
      <PageHeader
        title="Communication Templates"
        subtitle="Manage SMS and email templates for automated communications."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 size-4" />
            Create Template
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton
              key={`template-skeleton-${i}`}
              className="h-44 w-full rounded-xl"
            />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={MailPlus}
            title="No templates yet"
            description="Create your first template to start sending automated SMS and email communications."
            action={
              <Button onClick={openCreate}>
                <Plus className="mr-1.5 size-4" />
                Create Your First Template
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onEdit={() => openEdit(template)}
              onToggleActive={() => handleToggleActive(template)}
              onDelete={() => {
                setDeleteError(null);
                setDeletingTemplate(template);
              }}
            />
          ))}
        </div>
      )}

      <TemplateEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        template={editingTemplate}
        onSaved={() => {
          setEditorOpen(false);
          void fetchTemplates();
        }}
      />

      <ConfirmDialog
        open={deletingTemplate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingTemplate(null);
            setDeleteError(null);
          }
        }}
        title="Delete template?"
        description="This permanently removes the template. Automated communications that rely on it will fall back to defaults. This action cannot be undone."
        confirmLabel="Delete"
        confirmingLabel="Deleting..."
        isConfirming={isDeleting}
        error={deleteError}
        onConfirm={handleConfirmDelete}
      />
    </PageShell>
  );
}

function TemplateCard({
  template,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  readonly template: Template;
  readonly onEdit: () => void;
  readonly onToggleActive: () => void;
  readonly onDelete: () => void;
}) {
  const triggerType = TRIGGER_TYPES.find(
    (t) => t.value === template.triggerType,
  );
  const templateType = TEMPLATE_TYPES.find(
    (t) => t.value === template.templateType,
  );
  const isEmail = template.templateType.startsWith("email");

  return (
    <Card
      className={
        template.isActive
          ? "flex flex-col gap-3 p-5"
          : "flex flex-col gap-3 p-5 opacity-60"
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{template.name}</h3>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {template.description || "No description"}
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            template.isActive
              ? "shrink-0 border-success/30 bg-success-light text-success"
              : "shrink-0 text-muted-foreground"
          }
        >
          {template.isActive ? "Active" : "Inactive"}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary" className="gap-1 font-normal">
          {isEmail ? (
            <MailPlus className="size-3" />
          ) : (
            <MessageSquareText className="size-3" />
          )}
          {templateType?.label || template.templateType}
        </Badge>
        <Badge variant="outline" className="font-normal">
          {triggerType?.label || template.triggerType}
        </Badge>
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-muted-foreground tabular-nums">
          Priority {template.priority}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="mr-1 size-3.5" />
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onToggleActive}>
            {template.isActive ? "Deactivate" : "Activate"}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onDelete}
            aria-label={`Delete template ${template.name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
