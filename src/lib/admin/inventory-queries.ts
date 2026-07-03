/**
 * Parity Stage 10 — Purchasing / Inventory queries.
 *
 * Per-org stock LINKED to pricebook material items (inventory never forks a
 * second catalog — it references pricebookItems). Purchase orders are internal
 * records (mock-first vendor seam) until a real vendor API lands. Money is
 * integer cents; quantities are whole units.
 *
 * neon-http has NO transactions, so multi-row writes use db.batch (sequential,
 * array-ordered — NOT serializable). Ids are pre-generated with randomUUID so a
 * batched insert never needs .returning(). Every query is withTenant-scoped.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryItems,
  poLineItems,
  pricebookItems,
  purchaseOrders,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

// ──────────────────────────── inventory ────────────────────────────

export interface InventoryRow {
  readonly id: string;
  readonly pricebookItemId: string;
  readonly itemName: string;
  readonly quantityOnHand: number;
  readonly reorderPoint: number | null;
  readonly unitCostCents: number;
  readonly location: string | null;
  /** True when a reorder point is set AND stock is at or below it. */
  readonly belowReorder: boolean;
}

/**
 * Stock list for an org joined to the pricebook material's name, flagging items
 * at or below their reorder point. Ordered by name.
 */
export async function listInventory(
  organizationId: string,
): Promise<readonly InventoryRow[]> {
  const rows = await db
    .select({
      id: inventoryItems.id,
      pricebookItemId: inventoryItems.pricebookItemId,
      itemName: pricebookItems.name,
      quantityOnHand: inventoryItems.quantityOnHand,
      reorderPoint: inventoryItems.reorderPoint,
      unitCostCents: inventoryItems.unitCostCents,
      location: inventoryItems.location,
    })
    .from(inventoryItems)
    .innerJoin(
      pricebookItems,
      eq(inventoryItems.pricebookItemId, pricebookItems.id),
    )
    .where(withTenant(inventoryItems, organizationId))
    .orderBy(asc(pricebookItems.name));

  return rows.map((r) => ({
    ...r,
    belowReorder: r.reorderPoint != null && r.quantityOnHand <= r.reorderPoint,
  }));
}

export interface UpsertInventoryInput {
  readonly quantityOnHand?: number;
  readonly reorderPoint?: number | null;
  readonly unitCostCents?: number;
  readonly location?: string | null;
}

/**
 * Create or update the stock row for a pricebook material. Upserts on the
 * (org, pricebookItem) unique index so an item is tracked exactly once. Only
 * the provided fields are written on conflict.
 */
export async function upsertInventoryItem(
  organizationId: string,
  pricebookItemId: string,
  input: UpsertInventoryInput,
): Promise<void> {
  const setOnConflict: Record<string, unknown> = { updatedAt: new Date() };
  if (input.quantityOnHand !== undefined) {
    setOnConflict.quantityOnHand = input.quantityOnHand;
  }
  if (input.reorderPoint !== undefined) {
    setOnConflict.reorderPoint = input.reorderPoint;
  }
  if (input.unitCostCents !== undefined) {
    setOnConflict.unitCostCents = input.unitCostCents;
  }
  if (input.location !== undefined) {
    setOnConflict.location = input.location;
  }

  await db
    .insert(inventoryItems)
    .values({
      organizationId,
      pricebookItemId,
      quantityOnHand: input.quantityOnHand ?? 0,
      reorderPoint: input.reorderPoint ?? null,
      unitCostCents: input.unitCostCents ?? 0,
      location: input.location ?? null,
    })
    .onConflictDoUpdate({
      target: [inventoryItems.organizationId, inventoryItems.pricebookItemId],
      set: setOnConflict,
    });
}

/**
 * Adjust on-hand stock by a signed delta, clamped at 0 (a negative result can
 * never persist). No-op when the pricebook item isn't tracked in inventory.
 * The GREATEST clamp is applied in SQL so concurrent decrements stay correct.
 */
export async function adjustStock(
  organizationId: string,
  pricebookItemId: string,
  deltaQty: number,
): Promise<void> {
  if (deltaQty === 0) return;
  await db
    .update(inventoryItems)
    .set({
      quantityOnHand: sql`GREATEST(0, ${inventoryItems.quantityOnHand} + ${deltaQty})`,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        inventoryItems,
        organizationId,
        eq(inventoryItems.pricebookItemId, pricebookItemId),
      ),
    );
}

// ──────────────────────────── purchase orders ────────────────────────────

export interface PurchaseOrderLineInput {
  readonly pricebookItemId?: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitCostCents: number;
}

export interface CreatePurchaseOrderInput {
  readonly vendorName: string;
  readonly notes?: string | null;
  readonly lines: readonly PurchaseOrderLineInput[];
}

/**
 * Create a draft purchase order with its line items. The header total is the
 * computed sum of line totals (quantity × unit cost) — never client-supplied.
 * PO + lines are written in one db.batch (ids pre-generated so no .returning()).
 */
export async function createPurchaseOrder(
  organizationId: string,
  input: CreatePurchaseOrderInput,
): Promise<string> {
  const purchaseOrderId = randomUUID();

  const lineRows = input.lines.map((l) => ({
    id: randomUUID(),
    organizationId,
    purchaseOrderId,
    pricebookItemId: l.pricebookItemId ?? null,
    description: l.description,
    quantity: l.quantity,
    unitCostCents: l.unitCostCents,
    lineTotalCents: l.quantity * l.unitCostCents,
  }));

  const totalCents = lineRows.reduce((sum, l) => sum + l.lineTotalCents, 0);

  const headerInsert = db.insert(purchaseOrders).values({
    id: purchaseOrderId,
    organizationId,
    vendorName: input.vendorName,
    status: "draft",
    totalCents,
    notes: input.notes ?? null,
  });

  if (lineRows.length > 0) {
    await db.batch([headerInsert, db.insert(poLineItems).values(lineRows)]);
  } else {
    await db.batch([headerInsert]);
  }

  return purchaseOrderId;
}

export type ReceivePurchaseOrderResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "already_received";
    };

/**
 * Mark a purchase order received and roll its lines into stock: for each line
 * with a tracked pricebook item, INCREMENT quantityOnHand and set unitCostCents
 * to the received cost. All writes go in one db.batch. Idempotent: receiving an
 * already-received PO is rejected (so stock can't be double-incremented).
 */
export async function receivePurchaseOrder(
  organizationId: string,
  poId: string,
): Promise<ReceivePurchaseOrderResult> {
  const [po] = await db
    .select({ id: purchaseOrders.id, status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(withTenant(purchaseOrders, organizationId, eq(purchaseOrders.id, poId)))
    .limit(1);

  if (!po) return { ok: false, reason: "not_found" };

  const now = new Date();
  // Atomically CLAIM the not-received → received transition. The `status !=
  // 'received'` predicate makes the check-and-write a single statement, so under
  // concurrency (a double-clicked "Receive") exactly ONE caller wins and only the
  // winner increments stock — a prior read-then-write guard let both pass and
  // double-incremented on-hand quantities. Trade-off: the claim and the stock
  // increments below are separate calls (neon-http has no multi-table
  // transaction), so a process crash in between marks the PO received without
  // incrementing — recoverable by a manual adjustment, and far rarer/safer than
  // silent double-stock on every race.
  const [claimed] = await db
    .update(purchaseOrders)
    .set({ status: "received", receivedAt: now, updatedAt: now })
    .where(
      withTenant(
        purchaseOrders,
        organizationId,
        and(eq(purchaseOrders.id, poId), ne(purchaseOrders.status, "received"))!,
      ),
    )
    .returning({ id: purchaseOrders.id });
  if (!claimed) return { ok: false, reason: "already_received" };

  const lines = await db
    .select({
      pricebookItemId: poLineItems.pricebookItemId,
      quantity: poLineItems.quantity,
      unitCostCents: poLineItems.unitCostCents,
    })
    .from(poLineItems)
    .where(
      withTenant(
        poLineItems,
        organizationId,
        eq(poLineItems.purchaseOrderId, poId),
      ),
    );

  // Increment stock + update latest cost for each cataloged, tracked line.
  const stockUpdates = lines
    .filter((line) => line.pricebookItemId)
    .map((line) =>
      db
        .update(inventoryItems)
        .set({
          quantityOnHand: sql`${inventoryItems.quantityOnHand} + ${line.quantity}`,
          unitCostCents: line.unitCostCents,
          updatedAt: now,
        })
        .where(
          withTenant(
            inventoryItems,
            organizationId,
            eq(inventoryItems.pricebookItemId, line.pricebookItemId!),
          ),
        ),
    );

  // Apply the stock increments (the PO is already atomically marked received
  // above). db.batch needs a non-empty tuple; a PO with no cataloged/tracked
  // lines has nothing to increment.
  if (stockUpdates.length > 0) {
    type BatchStmt = (typeof stockUpdates)[number];
    try {
      await db.batch(stockUpdates as unknown as [BatchStmt, ...BatchStmt[]]);
    } catch (err) {
      // The stock batch threw AFTER we claimed 'received'. Revert the status so
      // the PO isn't stranded received-without-stock (which would silently lose
      // the inventory) — a retry can then re-attempt the whole receive.
      await db
        .update(purchaseOrders)
        .set({ status: po.status, receivedAt: null, updatedAt: new Date() })
        .where(
          withTenant(purchaseOrders, organizationId, eq(purchaseOrders.id, poId)),
        )
        .catch(() => {});
      throw err;
    }
  }
  return { ok: true };
}

export type MarkOrderedResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "invalid_status" };

/**
 * Flip a draft PO to "ordered" (sets orderedAt). Used by the vendor seam after
 * a submit. Only a draft may be ordered.
 */
export async function markPurchaseOrderOrdered(
  organizationId: string,
  poId: string,
): Promise<MarkOrderedResult> {
  const [po] = await db
    .select({ status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(withTenant(purchaseOrders, organizationId, eq(purchaseOrders.id, poId)))
    .limit(1);

  if (!po) return { ok: false, reason: "not_found" };
  if (po.status !== "draft") return { ok: false, reason: "invalid_status" };

  const now = new Date();
  await db
    .update(purchaseOrders)
    .set({ status: "ordered", orderedAt: now, updatedAt: now })
    .where(
      withTenant(purchaseOrders, organizationId, eq(purchaseOrders.id, poId)),
    );
  return { ok: true };
}

export interface PurchaseOrderRow {
  readonly id: string;
  readonly vendorName: string;
  readonly status: string;
  readonly totalCents: number;
  readonly notes: string | null;
  readonly orderedAt: Date | null;
  readonly receivedAt: Date | null;
  readonly createdAt: Date;
}

/** Purchase orders for an org, newest first. */
export async function listPurchaseOrders(
  organizationId: string,
): Promise<readonly PurchaseOrderRow[]> {
  return db
    .select({
      id: purchaseOrders.id,
      vendorName: purchaseOrders.vendorName,
      status: purchaseOrders.status,
      totalCents: purchaseOrders.totalCents,
      notes: purchaseOrders.notes,
      orderedAt: purchaseOrders.orderedAt,
      receivedAt: purchaseOrders.receivedAt,
      createdAt: purchaseOrders.createdAt,
    })
    .from(purchaseOrders)
    .where(withTenant(purchaseOrders, organizationId))
    .orderBy(desc(purchaseOrders.createdAt));
}

export interface PurchaseOrderLineRow {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitCostCents: number;
  readonly lineTotalCents: number;
}

export interface PurchaseOrderDetail extends PurchaseOrderRow {
  readonly lines: readonly PurchaseOrderLineRow[];
}

/** A single purchase order with its line items, or null if not in this org. */
export async function getPurchaseOrder(
  organizationId: string,
  id: string,
): Promise<PurchaseOrderDetail | null> {
  const [header] = await db
    .select({
      id: purchaseOrders.id,
      vendorName: purchaseOrders.vendorName,
      status: purchaseOrders.status,
      totalCents: purchaseOrders.totalCents,
      notes: purchaseOrders.notes,
      orderedAt: purchaseOrders.orderedAt,
      receivedAt: purchaseOrders.receivedAt,
      createdAt: purchaseOrders.createdAt,
    })
    .from(purchaseOrders)
    .where(withTenant(purchaseOrders, organizationId, eq(purchaseOrders.id, id)))
    .limit(1);

  if (!header) return null;

  const lines = await db
    .select({
      id: poLineItems.id,
      pricebookItemId: poLineItems.pricebookItemId,
      description: poLineItems.description,
      quantity: poLineItems.quantity,
      unitCostCents: poLineItems.unitCostCents,
      lineTotalCents: poLineItems.lineTotalCents,
    })
    .from(poLineItems)
    .where(
      withTenant(poLineItems, organizationId, eq(poLineItems.purchaseOrderId, id)),
    )
    .orderBy(asc(poLineItems.description));

  return { ...header, lines };
}

/** True when the pricebook item is tracked in this org's inventory. */
export async function isInventoryTracked(
  organizationId: string,
  pricebookItemId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      withTenant(
        inventoryItems,
        organizationId,
        and(
          eq(inventoryItems.pricebookItemId, pricebookItemId),
        )!,
      ),
    )
    .limit(1);
  return !!row;
}
