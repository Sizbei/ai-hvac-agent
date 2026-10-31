"use client";

import { useCallback, useEffect, useState } from "react";
import { Users, MoreHorizontal, Plus } from "lucide-react";
import { SectionCard } from "@/components/admin/ui/section-card";
import { ContextBadge } from "@/components/admin/ui/context-badge";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { ContactRecord } from "@/lib/admin/contact-types";

const SAVE_COPY = "Couldn't save the contact. Please try again.";
const REMOVE_COPY = "Couldn't remove the contact. Please try again.";
const NO_LOCATION = "__none__";

interface LocationOption {
  readonly id: string;
  readonly address: string | null;
  readonly label: string | null;
}

interface ContactFormState {
  readonly name: string;
  readonly role: string;
  readonly phone: string;
  readonly email: string;
  readonly locationId: string;
  readonly isPrimary: boolean;
}

const EMPTY_FORM: ContactFormState = {
  name: "",
  role: "",
  phone: "",
  email: "",
  locationId: NO_LOCATION,
  isPrimary: false,
};

function formFromContact(c: ContactRecord): ContactFormState {
  return {
    name: c.name,
    role: c.role ?? "",
    phone: c.phone ?? "",
    email: c.email ?? "",
    locationId: c.locationId ?? NO_LOCATION,
    isPrimary: c.isPrimary,
  };
}

/** Create: blank optional fields are null. Edit: blank optional fields are omitted. */
function buildBody(
  form: ContactFormState,
  mode: "create" | "edit",
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    isPrimary: form.isPrimary,
  };
  const optional: Record<string, string> = {
    role: form.role.trim(),
    phone: form.phone.trim(),
    email: form.email.trim(),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) body[key] = value;
    else if (mode === "create") body[key] = null;
  }
  body.locationId = form.locationId === NO_LOCATION ? null : form.locationId;
  return body;
}

interface ContactDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly customerId: string;
  readonly contact: ContactRecord | null;
  readonly locations: readonly LocationOption[];
  readonly onSaved: () => void;
}

function ContactDialog({
  open,
  onOpenChange,
  customerId,
  contact,
  locations,
  onSaved,
}: ContactDialogProps) {
  const [form, setForm] = useState<ContactFormState>(
    contact ? formFromContact(contact) : EMPTY_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (next: Partial<ContactFormState>): void =>
    setForm((f) => ({ ...f, ...next }));

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const base = `/api/admin/customers/${customerId}/contacts`;
      const res = await fetch(contact ? `${base}/${contact.id}` : base, {
        method: contact ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(form, contact ? "edit" : "create")),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(
          res.status === 400 && json?.error?.message
            ? json.error.message
            : SAVE_COPY,
        );
        return;
      }
      onOpenChange(false);
      onSaved();
    } catch {
      setError(SAVE_COPY);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="contact-name">Name</Label>
            <Input
              id="contact-name"
              value={form.name}
              maxLength={200}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-role">Role</Label>
            <Input
              id="contact-role"
              value={form.role}
              maxLength={60}
              placeholder="Tenant, property manager…"
              onChange={(e) => patch({ role: e.target.value })}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="contact-phone">Phone</Label>
              <Input
                id="contact-phone"
                type="tel"
                value={form.phone}
                maxLength={40}
                onChange={(e) => patch({ phone: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-email">Email</Label>
              <Input
                id="contact-email"
                type="email"
                value={form.email}
                maxLength={254}
                onChange={(e) => patch({ email: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Location</Label>
            <Select
              value={form.locationId}
              onValueChange={(v) => patch({ locationId: v ?? NO_LOCATION })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v: string) =>
                    v === NO_LOCATION
                      ? "Any location"
                      : (locations.find((l) => l.id === v)?.address ??
                        "Address unavailable")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_LOCATION}>Any location</SelectItem>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.address ?? "Address unavailable"}
                    {l.label ? ` (${l.label})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="contact-primary">Primary contact</Label>
            <Switch
              id="contact-primary"
              checked={form.isPrimary}
              onCheckedChange={(c) => patch({ isPrimary: c })}
            />
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
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Customer-page "Contacts" card: people to reach, primary chip, edit/make-primary/remove menu. */
export function ContactsSection({
  customerId,
}: {
  readonly customerId: string;
}) {
  const [contacts, setContacts] = useState<readonly ContactRecord[] | null>(
    null,
  );
  const [locations, setLocations] = useState<readonly LocationOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ContactRecord | null>(null);
  const [removing, setRemoving] = useState<ContactRecord | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const reload = useCallback((): void => setVersion((v) => v + 1), []);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/customers/${customerId}/contacts`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((body: { data: { contacts: readonly ContactRecord[] } }) => {
        if (!active) return;
        setContacts(body.data.contacts);
        setError(null);
      })
      .catch(() => {
        if (active) setError("Couldn't load contacts.");
      });
    return () => {
      active = false;
    };
  }, [customerId, version]);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/customers/${customerId}/locations`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (body: { data?: { locations?: readonly LocationOption[] } } | null) => {
          if (active && body?.data?.locations)
            setLocations(body.data.locations);
        },
      )
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [customerId]);

  async function makePrimary(contact: ContactRecord): Promise<void> {
    try {
      const res = await fetch(
        `/api/admin/customers/${customerId}/contacts/${contact.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isPrimary: true }),
        },
      );
      if (!res.ok) {
        setError(SAVE_COPY);
        return;
      }
      reload();
    } catch {
      setError(SAVE_COPY);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const res = await fetch(
        `/api/admin/customers/${customerId}/contacts/${removing.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setRemoveError(REMOVE_COPY);
        return;
      }
      setRemoving(null);
      reload();
    } catch {
      setRemoveError(REMOVE_COPY);
    } finally {
      setRemoveBusy(false);
    }
  }

  function openDialog(contact: ContactRecord | null): void {
    setEditing(contact);
    setDialogOpen(true);
  }

  return (
    <SectionCard
      title="Contacts"
      icon={Users}
      count={contacts ? contacts.length : undefined}
      action={
        <Button variant="outline" size="sm" onClick={() => openDialog(null)}>
          <Plus className="size-4" />
          Add contact
        </Button>
      }
    >
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {contacts === null && !error && (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      )}
      {contacts?.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No contacts yet.
        </p>
      )}
      {contacts && contacts.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm text-foreground">
                    {c.name}
                  </span>
                  {c.role && (
                    <span className="text-xs text-muted-foreground">
                      {c.role}
                    </span>
                  )}
                  {c.isPrimary && (
                    <ContextBadge variant="info" label="Primary" />
                  )}
                </div>
                {(c.phone || c.email) && (
                  <div className="flex flex-wrap gap-x-3 font-mono text-[13px] text-muted-foreground">
                    {c.phone && <span>{c.phone}</span>}
                    {c.email && <span className="break-all">{c.email}</span>}
                  </div>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${c.name}`}
                    />
                  }
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => openDialog(c)}>
                    Edit
                  </DropdownMenuItem>
                  {!c.isPrimary && (
                    <DropdownMenuItem onClick={() => void makePrimary(c)}>
                      Make primary
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving(c);
                    }}
                  >
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      {dialogOpen && (
        <ContactDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          customerId={customerId}
          contact={editing}
          locations={locations}
          onSaved={reload}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) setRemoving(null);
        }}
        title="Remove contact"
        description={`Remove ${removing?.name ?? "this contact"} from this customer?`}
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        isConfirming={removeBusy}
        error={removeError}
        onConfirm={() => void confirmRemove()}
      />
    </SectionCard>
  );
}
