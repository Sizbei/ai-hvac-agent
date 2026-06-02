import { eq, and, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { widgetKeys } from "@/lib/db/schema";
import {
  generateWidgetKey,
  hashApiKey,
  keyTypeFromValue,
  DEFAULT_SCOPES,
  type KeyType,
  type KeyScope,
} from "./keys";

export interface ValidatedKey {
  readonly id: string;
  readonly organizationId: string;
  readonly keyType: KeyType;
  readonly scopes: readonly string[];
}

/**
 * Validate a presented API key: hash it, look it up, and confirm it's active.
 * Returns the owning org + scopes, or null if unknown/revoked. The lookup is by
 * the unique key_hash index (constant-work indexed equality), so there's no
 * per-key timing signal an attacker could mine. Does NOT check scopes/origin —
 * the caller enforces those against its required scope.
 */
export async function validateKey(
  presentedKey: string,
): Promise<ValidatedKey | null> {
  if (keyTypeFromValue(presentedKey) === null) return null; // wrong shape
  const keyHash = hashApiKey(presentedKey);

  const [row] = await db
    .select({
      id: widgetKeys.id,
      organizationId: widgetKeys.organizationId,
      keyType: widgetKeys.keyType,
      scopes: widgetKeys.scopes,
      isActive: widgetKeys.isActive,
    })
    .from(widgetKeys)
    .where(eq(widgetKeys.keyHash, keyHash))
    .limit(1);

  if (!row || !row.isActive) return null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    keyType: row.keyType as KeyType,
    scopes: row.scopes ?? [],
  };
}

/** Record that a key was used (best-effort, fire-and-forget by the caller). */
export async function touchKeyLastUsed(keyId: string): Promise<void> {
  await db
    .update(widgetKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(widgetKeys.id, keyId));
}

// ── Admin management ──

export interface WidgetKeyRecord {
  readonly id: string;
  readonly keyType: KeyType;
  readonly keyPrefix: string;
  readonly label: string | null;
  readonly scopes: readonly string[];
  readonly isActive: boolean;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export async function listWidgetKeys(
  organizationId: string,
): Promise<readonly WidgetKeyRecord[]> {
  const rows = await db
    .select()
    .from(widgetKeys)
    .where(eq(widgetKeys.organizationId, organizationId))
    .orderBy(desc(widgetKeys.createdAt));

  return rows.map((r) => ({
    id: r.id,
    keyType: r.keyType as KeyType,
    keyPrefix: r.keyPrefix,
    label: r.label,
    scopes: r.scopes ?? [],
    isActive: r.isActive,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface CreatedWidgetKey {
  readonly record: WidgetKeyRecord;
  /** Plaintext key — returned ONCE, never persisted or returned again. */
  readonly plaintext: string;
}

/** Mint a new key of the given type with its default scopes. */
export async function createWidgetKey(
  organizationId: string,
  keyType: KeyType,
  label: string | null,
): Promise<CreatedWidgetKey> {
  const generated = generateWidgetKey(keyType);
  const scopes = DEFAULT_SCOPES[keyType] as readonly KeyScope[];

  const [row] = await db
    .insert(widgetKeys)
    .values({
      organizationId,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      keyType,
      scopes: [...scopes],
      label,
    })
    .returning();
  if (!row) throw new Error("Failed to create widget key");

  return {
    plaintext: generated.plaintext,
    record: {
      id: row.id,
      keyType,
      keyPrefix: row.keyPrefix,
      label: row.label,
      scopes: row.scopes ?? [],
      isActive: row.isActive,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

/** Revoke (deactivate) a key. Scoped to the org so one tenant can't revoke
 * another's key. Returns false if no such key in the org. */
export async function revokeWidgetKey(
  organizationId: string,
  keyId: string,
): Promise<boolean> {
  const [row] = await db
    .update(widgetKeys)
    .set({ isActive: false, revokedAt: new Date() })
    .where(
      and(
        eq(widgetKeys.id, keyId),
        eq(widgetKeys.organizationId, organizationId),
      ),
    )
    .returning({ id: widgetKeys.id });
  return Boolean(row);
}
