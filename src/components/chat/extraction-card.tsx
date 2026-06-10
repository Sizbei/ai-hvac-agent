'use client';

import { motion } from 'motion/react';
import { ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { ANIMATION } from '@/lib/design-tokens';
import { SKIP_SENTINEL } from '@/lib/ai/chat-slots';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';

interface ExtractionCardProps {
  readonly extraction: ExtractionResult;
  readonly onConfirm: () => void;
}

function formatSnakeCase(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getUrgencyVariant(
  urgency: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (urgency) {
    case 'emergency':
    case 'high':
      return 'destructive';
    case 'medium':
      return 'outline';
    case 'low':
      return 'secondary';
    default:
      return 'secondary';
  }
}

interface FieldRowProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

function FieldRow({ label, children }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export function ExtractionCard({ extraction, onConfirm }: ExtractionCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ANIMATION.cardFadeIn.duration,
        ease: ANIMATION.cardFadeIn.ease,
      }}
      className="flex justify-start"
    >
      <Card className="w-full max-w-[90%]" size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardCheck className="size-4 text-primary" />
            Service Request Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {extraction.issueType && (
            <FieldRow label="Issue Type">
              {formatSnakeCase(extraction.issueType)}
            </FieldRow>
          )}
          {extraction.urgency && (
            <FieldRow label="Urgency">
              <Badge variant={getUrgencyVariant(extraction.urgency)}>
                {extraction.urgency.charAt(0).toUpperCase() +
                  extraction.urgency.slice(1)}
              </Badge>
            </FieldRow>
          )}
          {extraction.address && (
            <FieldRow label="Address">{extraction.address}</FieldRow>
          )}
          {extraction.customerName && (
            <FieldRow label="Name">{extraction.customerName}</FieldRow>
          )}
          {extraction.customerPhone && (
            <FieldRow label="Phone">{extraction.customerPhone}</FieldRow>
          )}
          {extraction.customerEmail && (
            <FieldRow label="Email">
              {extraction.customerEmail === SKIP_SENTINEL ? (
                <span className="text-muted-foreground">Not provided</span>
              ) : (
                extraction.customerEmail
              )}
            </FieldRow>
          )}
          {extraction.description && (
            <FieldRow label="Description">{extraction.description}</FieldRow>
          )}
        </CardContent>
        <CardFooter>
          <Button onClick={onConfirm} className="w-full">
            Confirm &amp; Submit
          </Button>
        </CardFooter>
      </Card>
    </motion.div>
  );
}
