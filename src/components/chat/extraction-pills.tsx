'use client';

import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ANIMATION } from '@/lib/design-tokens';
import type { ExtractionField } from '@/lib/types/chat';

interface ExtractionPillsProps {
  readonly fields: readonly ExtractionField[];
}

export function ExtractionPills({ fields }: ExtractionPillsProps) {
  const hasAnyCollected = fields.some((f) => f.collected);
  if (!hasAnyCollected) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ANIMATION.fadeIn.duration,
        ease: ANIMATION.fadeIn.ease,
      }}
      className="flex items-center gap-1.5 px-3 py-1.5"
    >
      {fields.map((field) => (
        <Badge
          key={field.key}
          variant={field.collected ? 'default' : 'secondary'}
          className="gap-1 text-xs"
        >
          {field.collected && <Check className="size-3" />}
          {field.label}
        </Badge>
      ))}
    </motion.div>
  );
}
