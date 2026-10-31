import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { tagTypes, entityTags } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { isTagColor, type TagEntity, type TagTypeInput, type TagTypePatch, type TagTypeRecord } from "./tag-types";

function toRecord(row: typeof tagTypes.$inferSelect): TagTypeRecord {
  return { id: row.id, entity: row.entity, name: row.name, color: isTagColor(row.color) ? row.color : "graphite", visibleOnBoard: row.visibleOnBoard, active: row.active };
}

export async function listTagTypes(organizationId: string, opts: { readonly entity?: TagEntity; readonly activeOnly?: boolean } = {}): Promise<readonly TagTypeRecord[]> {
  const rows = await db.select().from(tagTypes)
    .where(withTenant(tagTypes, organizationId,
      ...(opts.entity ? [eq(tagTypes.entity, opts.entity)] : []),
      ...(opts.activeOnly ? [eq(tagTypes.active, true)] : [])))
    .orderBy(asc(tagTypes.entity), asc(tagTypes.name));
  return rows.map(toRecord);
}

export async function createTagType(organizationId: string, input: TagTypeInput): Promise<TagTypeRecord | { readonly conflict: true }> {
  try {
    const [row] = await db.insert(tagTypes).values({ organizationId, entity: input.entity, name: input.name, color: input.color,
      visibleOnBoard: input.visibleOnBoard ?? false, active: input.active ?? true }).returning();
    if (!row) throw new Error("Failed to create tag");
    return toRecord(row);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

export async function updateTagType(organizationId: string, id: string, patch: TagTypePatch): Promise<TagTypeRecord | null | { readonly conflict: true }> {
  const set: Partial<typeof tagTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.visibleOnBoard !== undefined) set.visibleOnBoard = patch.visibleOnBoard;
  if (patch.active !== undefined) set.active = patch.active;
  try {
    const [row] = await db.update(tagTypes).set(set).where(withTenant(tagTypes, organizationId, eq(tagTypes.id, id))).returning();
    return row ? toRecord(row) : null;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

/** Tags for many entities at once; map key = entityId. */
export async function listEntityTags(organizationId: string, entity: TagEntity, entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly TagTypeRecord[]>> {
  const out = new Map<string, TagTypeRecord[]>();
  if (entityIds.length === 0) return out;
  const rows = await db.select({ entityId: entityTags.entityId, tag: tagTypes }).from(entityTags)
    .innerJoin(tagTypes, eq(tagTypes.id, entityTags.tagTypeId))
    .where(withTenant(entityTags, organizationId, eq(entityTags.entity, entity), inArray(entityTags.entityId, [...entityIds])))
    .orderBy(asc(tagTypes.name));
  for (const r of rows) { const list = out.get(r.entityId) ?? []; list.push(toRecord(r.tag)); out.set(r.entityId, list); }
  return out;
}

/** Re-read tag ids under the org with the right kind and active = true. */
export async function validateTagTypeIds(organizationId: string, entity: TagEntity, ids: readonly string[]): Promise<{ readonly ok: true; readonly ids: readonly string[] } | { readonly ok: false }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, ids: [] };
  const found = await db.select({ id: tagTypes.id }).from(tagTypes)
    .where(withTenant(tagTypes, organizationId, eq(tagTypes.entity, entity), eq(tagTypes.active, true), inArray(tagTypes.id, unique)));
  return found.length === unique.length ? { ok: true, ids: unique } : { ok: false };
}

/** Replace the tag set on one entity. The CALLER verified the entity belongs
 * to the org. Delete + insert in one batch. */
export async function replaceEntityTags(organizationId: string, entity: TagEntity, entityId: string, tagTypeIds: readonly string[]): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: "unknown_tag" }> {
  const valid = await validateTagTypeIds(organizationId, entity, tagTypeIds);
  if (!valid.ok) return { ok: false, reason: "unknown_tag" };
  const del = db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, entity), eq(entityTags.entityId, entityId)));
  if (valid.ids.length === 0) { await del; return { ok: true }; }
  await db.batch([del, db.insert(entityTags).values(valid.ids.map((tagTypeId) => ({ organizationId, tagTypeId, entity, entityId })))]);
  return { ok: true };
}
