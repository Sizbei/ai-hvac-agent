import { z } from "zod";

export const TAG_ENTITIES = ["customer", "location", "job"] as const;
export type TagEntity = (typeof TAG_ENTITIES)[number];
export const TAG_COLOR_TOKENS = ["graphite", "marker", "danger", "success", "warning", "info"] as const;
export type TagColor = (typeof TAG_COLOR_TOKENS)[number];

export interface TagTypeRecord {
  readonly id: string; readonly entity: TagEntity; readonly name: string;
  readonly color: TagColor; readonly visibleOnBoard: boolean; readonly active: boolean;
}

export const tagTypeInputSchema = z.object({
  entity: z.enum(TAG_ENTITIES),
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1, "Name is required.").max(40, "Name must be 40 characters or fewer.")),
  color: z.enum(TAG_COLOR_TOKENS),
  visibleOnBoard: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type TagTypeInput = z.infer<typeof tagTypeInputSchema>;
export const tagTypePatchSchema = tagTypeInputSchema.omit({ entity: true }).partial();
export type TagTypePatch = z.infer<typeof tagTypePatchSchema>;

/** Token → the text/background pairs status-colors.ts proves ≥ 4.5:1. */
const BADGE: Record<TagColor, string> = {
  graphite: "bg-muted text-muted-foreground border-border",
  marker: "bg-marker-light text-marker-strong border-marker-border",
  danger: "bg-danger-light text-danger-strong border-danger-border",
  success: "bg-success-light text-success-strong border-success-border",
  warning: "bg-warning-light text-warning-strong border-warning-border",
  info: "bg-info-light text-info-strong border-info-border",
};
export function tagBadgeClass(color: TagColor): string { return BADGE[color] ?? BADGE.graphite; }
export function isTagColor(v: string): v is TagColor { return (TAG_COLOR_TOKENS as readonly string[]).includes(v); }
