'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import type { AdminRequestDetail, TechnicianRecord } from '@/lib/admin/types';

interface RequestDetailSheetProps {
  readonly requestId: string | null;
  readonly onClose: () => void;
  readonly onAssigned: () => void;
}

function InfoRow({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">
        {value ?? <span className="text-muted-foreground italic">Not provided</span>}
      </span>
    </div>
  );
}

function TranscriptBubble({
  role,
  content,
  createdAt,
}: {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: string;
}) {
  if (role === 'system') {
    return (
      <div className="text-center py-1">
        <span className="text-xs italic text-muted-foreground">{content}</span>
      </div>
    );
  }

  const isUser = role === 'user';
  const time = new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-blue-100 text-blue-900'
            : 'bg-gray-100 text-gray-900'
        }`}
      >
        <p className="whitespace-pre-wrap">{content}</p>
        <p className={`mt-1 text-xs ${isUser ? 'text-blue-500' : 'text-gray-400'}`}>
          {time}
        </p>
      </div>
    </div>
  );
}

export function RequestDetailSheet({
  requestId,
  onClose,
  onAssigned,
}: RequestDetailSheetProps) {
  const [detail, setDetail] = useState<AdminRequestDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [technicians, setTechnicians] = useState<readonly TechnicianRecord[]>([]);
  const techniciansLoadedRef = useRef(false);

  const [selectedTechId, setSelectedTechId] = useState<string>('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Fetch technician list (once)
  useEffect(() => {
    if (techniciansLoadedRef.current) return;
    techniciansLoadedRef.current = true;

    async function loadTechnicians(): Promise<void> {
      try {
        const res = await fetch('/api/admin/technicians');
        if (!res.ok) return;
        const body = (await res.json()) as {
          success: boolean;
          data: { technicians: TechnicianRecord[] };
        };
        if (body.success) {
          setTechnicians(body.data.technicians);
        }
      } catch {
        // Non-fatal: technician dropdown will be empty
      }
    }

    loadTechnicians();
  }, []);

  // Fetch request detail when requestId changes
  useEffect(() => {
    if (!requestId) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    setIsLoadingDetail(true);
    setDetailError(null);
    setSelectedTechId('');
    setAssignError(null);

    async function loadDetail(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/requests/${requestId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({
            error: { message: 'Failed to load request details' },
          }));
          setDetailError(body?.error?.message ?? 'Failed to load request details');
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: AdminRequestDetail;
        };
        if (body.success) {
          setDetail(body.data);
          // Pre-select current technician if already assigned
          if (body.data.assignedTo) {
            setSelectedTechId(body.data.assignedTo);
          }
        }
      } catch {
        setDetailError('Could not connect to server.');
      } finally {
        setIsLoadingDetail(false);
      }
    }

    loadDetail();
  }, [requestId]);

  const handleAssign = useCallback(async (): Promise<void> => {
    if (!requestId || !selectedTechId) return;

    setIsAssigning(true);
    setAssignError(null);

    try {
      const res = await fetch(`/api/admin/requests/${requestId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technicianId: selectedTechId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Assignment failed' },
        }));
        setAssignError(body?.error?.message ?? 'Assignment failed');
        return;
      }

      // Update local detail to reflect assignment
      const body = (await res.json()) as {
        success: boolean;
        data: AdminRequestDetail;
      };
      if (body.success && detail) {
        const assignedTech = technicians.find((t) => t.id === selectedTechId);
        setDetail({
          ...detail,
          assignedTo: selectedTechId,
          assignedToName: assignedTech?.name ?? 'Assigned',
          status: body.data.status,
        });
      }

      onAssigned();
    } catch {
      setAssignError('Could not connect to server.');
    } finally {
      setIsAssigning(false);
    }
  }, [requestId, selectedTechId, detail, technicians, onAssigned]);

  const formatIssueType = (issueType: string): string =>
    issueType
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

  const activeTechnicians = technicians.filter((t) => t.isActive);
  const isOpen = requestId !== null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:w-[480px] sm:max-w-[480px] flex flex-col overflow-hidden">
        {isLoadingDetail ? (
          <div className="space-y-4 p-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : detailError ? (
          <div className="p-4">
            <p className="text-sm text-destructive">{detailError}</p>
          </div>
        ) : detail ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="font-mono text-sm">{detail.referenceNumber}</span>
              </SheetTitle>
              <SheetDescription className="flex items-center gap-2">
                <UrgencyBadge urgency={detail.urgency} />
                <StatusBadge status={detail.status} />
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto space-y-4 px-4">
              {/* Customer info */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Customer Information</h3>
                <div className="rounded-md border p-3 space-y-1">
                  <InfoRow label="Name" value={detail.customerName} />
                  <InfoRow label="Phone" value={detail.customerPhone} />
                  <InfoRow label="Email" value={detail.customerEmail} />
                  <InfoRow label="Address" value={detail.address} />
                </div>
              </section>

              {/* Issue details */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Issue Details</h3>
                <div className="rounded-md border p-3 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Type</span>
                    <span className="text-sm font-medium">
                      {formatIssueType(detail.issueType)}
                    </span>
                  </div>
                  {detail.description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {detail.description}
                    </p>
                  )}
                </div>
              </section>

              {/* Assignment */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Assignment</h3>
                <div className="rounded-md border p-3 space-y-3">
                  {detail.assignedToName && (
                    <p className="text-sm">
                      Currently assigned to:{' '}
                      <span className="font-medium">{detail.assignedToName}</span>
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedTechId}
                      onValueChange={(value) => setSelectedTechId(value ?? '')}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select technician" />
                      </SelectTrigger>
                      <SelectContent>
                        {activeTechnicians.map((tech) => (
                          <SelectItem key={tech.id} value={tech.id}>
                            {tech.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={handleAssign}
                      disabled={!selectedTechId || isAssigning}
                    >
                      {isAssigning ? 'Assigning...' : 'Assign'}
                    </Button>
                  </div>
                  {assignError && (
                    <p className="text-xs text-destructive">{assignError}</p>
                  )}
                </div>
              </section>

              <Separator />

              {/* Transcript */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Conversation Transcript</h3>
                <ScrollArea className="max-h-[300px] rounded-md border p-3">
                  {detail.transcript.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No messages recorded
                    </p>
                  ) : (
                    detail.transcript.map((msg, index) => (
                      <TranscriptBubble
                        key={`${msg.createdAt}-${index}`}
                        role={msg.role}
                        content={msg.content}
                        createdAt={msg.createdAt}
                      />
                    ))
                  )}
                </ScrollArea>
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
