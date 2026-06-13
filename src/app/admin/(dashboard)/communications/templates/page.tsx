/**
 * Communication Templates Admin Page
 *
 * Admin interface for managing communication templates.
 * View, edit, create, and activate/deactivate templates.
 */

"use client";

import { useState, useEffect } from "react";

interface Template {
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

const TRIGGER_TYPES = [
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
];

const TEMPLATE_TYPES = [
  { value: "sms", label: "SMS" },
  { value: "email_html", label: "Email (HTML)" },
  { value: "email_text", label: "Email (Plain Text)" },
];

export default function CommunicationTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      const response = await fetch(
        "/api/admin/communications/templates",
      );
      if (!response.ok) throw new Error("Failed to fetch templates");
      const data = await response.json();
      setTemplates(data.templates || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleActive = async (templateId: string, isActive: boolean) => {
    try {
      const response = await fetch(
        `/api/admin/communications/templates/${templateId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !isActive }),
        },
      );
      if (!response.ok) throw new Error("Failed to update template");
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!confirm("Are you sure you want to delete this template?")) return;

    try {
      const response = await fetch(
        `/api/admin/communications/templates/${templateId}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Failed to delete template");
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Communication Templates
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Manage SMS and email templates for automated communications
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
        >
          Create Template
        </button>
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            onEdit={() => setEditingTemplate(template)}
            onToggleActive={() =>
              handleToggleActive(template.id, template.isActive)
            }
            onDelete={() => handleDelete(template.id)}
          />
        ))}
      </div>

      {/* Empty State */}
      {templates.length === 0 && (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <p className="text-gray-600 mb-4">No templates found</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            Create Your First Template
          </button>
        </div>
      )}

      {/* Edit Modal */}
      {editingTemplate && (
        <TemplateEditorModal
          template={editingTemplate}
          onClose={() => {
            setEditingTemplate(null);
            fetchTemplates();
          }}
        />
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <TemplateEditorModal
          onClose={() => {
            setShowCreateModal(false);
            fetchTemplates();
          }}
        />
      )}
    </div>
  );
}

function TemplateCard({
  template,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  template: Template;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const triggerType = TRIGGER_TYPES.find((t) => t.value === template.triggerType);
  const templateType = TEMPLATE_TYPES.find((t) => t.value === template.templateType);

  return (
    <div
      className={`bg-white border rounded-lg p-4 space-y-3 ${
        template.isActive ? "border-blue-200" : "border-gray-200 opacity-60"
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className="font-semibold text-gray-900">{template.name}</h3>
          <p className="text-sm text-gray-600 mt-1">
            {template.description || "No description"}
          </p>
        </div>
        <div
          className={`ml-2 px-2 py-1 text-xs font-medium rounded ${
            template.isActive
              ? "bg-green-100 text-green-800"
              : "bg-gray-100 text-gray-600"
          }`}
        >
          {template.isActive ? "Active" : "Inactive"}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">
          {triggerType?.label || template.triggerType}
        </span>
        <span className="px-2 py-1 bg-purple-50 text-purple-700 rounded">
          {templateType?.label || template.templateType}
        </span>
      </div>

      <div className="pt-3 border-t border-gray-100 flex items-center justify-between">
        <div className="text-xs text-gray-500">
          Priority: {template.priority}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onEdit}
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            Edit
          </button>
          <button
            onClick={onToggleActive}
            className="text-sm text-gray-600 hover:text-gray-700"
          >
            {template.isActive ? "Deactivate" : "Activate"}
          </button>
          <button
            onClick={onDelete}
            className="text-sm text-red-600 hover:text-red-700"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateEditorModal({
  template,
  onClose,
}: {
  template?: Template;
  onClose: () => void;
}) {
  const [formData, setFormData] = useState({
    key: template?.key || "",
    name: template?.name || "",
    description: template?.description || "",
    triggerType: template?.triggerType || "appointment_scheduled",
    templateType: template?.templateType || "sms",
    subjectTemplate: template?.subjectTemplate || "",
    bodyTemplate: template?.bodyTemplate || "",
    isActive: template?.isActive ?? true,
    priority: template?.priority || 50,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to save template");
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {template ? "Edit Template" : "Create Template"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Template Key
              </label>
              <input
                type="text"
                value={formData.key}
                onChange={(e) =>
                  setFormData({ ...formData, key: e.target.value })
                }
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="e.g., appointment_scheduled_sms"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Priority
              </label>
              <input
                type="number"
                value={formData.priority}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    priority: parseInt(e.target.value),
                  })
                }
                className="w-full px-3 py-2 border rounded-lg"
                min="0"
                max="100"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              className="w-full px-3 py-2 border rounded-lg"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              className="w-full px-3 py-2 border rounded-lg"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trigger Type
              </label>
              <select
                value={formData.triggerType}
                onChange={(e) =>
                  setFormData({ ...formData, triggerType: e.target.value })
                }
                className="w-full px-3 py-2 border rounded-lg"
                required
              >
                {TRIGGER_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Template Type
              </label>
              <select
                value={formData.templateType}
                onChange={(e) =>
                  setFormData({ ...formData, templateType: e.target.value })
                }
                className="w-full px-3 py-2 border rounded-lg"
                required
              >
                {TEMPLATE_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {formData.templateType.startsWith("email") && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Subject Line
              </label>
              <input
                type="text"
                value={formData.subjectTemplate}
                onChange={(e) =>
                  setFormData({ ...formData, subjectTemplate: e.target.value })
                }
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Message Body
              <span className="text-gray-500 font-normal ml-2">
                {'(Use {{ "{{ variable }}" }} for placeholders)'}
              </span>
            </label>
            <textarea
              value={formData.bodyTemplate}
              onChange={(e) =>
                setFormData({ ...formData, bodyTemplate: e.target.value })
              }
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
              rows={6}
              required
            />
          </div>

          <div className="flex items-center">
            <input
              type="checkbox"
              id="isActive"
              checked={formData.isActive}
              onChange={(e) =>
                setFormData({ ...formData, isActive: e.target.checked })
              }
              className="mr-2"
            />
            <label htmlFor="isActive" className="text-sm text-gray-700">
              Active
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : template ? "Update" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
