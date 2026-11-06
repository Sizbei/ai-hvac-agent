/**
 * Field equipment input (M3c spec §5.6) and the equipment GET contract. Pure
 * and client-safe: the route, the writer and the equipment sheet share it.
 */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

export const EQUIPMENT_TYPE_VALUES = ["ac", "furnace", "heat_pump", "boiler", "mini_split", "thermostat", "other"] as const;
export type EquipmentTypeValue = (typeof EQUIPMENT_TYPE_VALUES)[number];
export const EQUIPMENT_TEXT_MAX = 120;

const BUSINESS_TZ = BUSINESS_BASE_LOCATION.timezone;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface EquipmentRaw {
  readonly equipmentType?: unknown; readonly make?: unknown; readonly model?: unknown; readonly serialNumber?: unknown;
  readonly locationInHome?: unknown; readonly notes?: unknown; readonly installDate?: unknown; readonly replacesId?: unknown;
}

export interface EquipmentInput {
  readonly equipmentType: EquipmentTypeValue;
  readonly make: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly locationInHome: string | null;
  readonly notes: string | null;
  /** YYYY-MM-DD in the business timezone, not in the future. */
  readonly installDate: string | null;
  /** Lower-case uuid of the unit this one replaces. */
  readonly replacesId: string | null;
}

export type EquipmentFieldError = "type" | "describe" | "too_long" | "date_invalid" | "date_future" | "replaces";

export const EQUIPMENT_ERROR_COPY: Record<EquipmentFieldError, string> = {
  type: "Choose the type of equipment.",
  describe: "Describe the equipment.",
  too_long: "Keep each field to 120 characters.",
  date_invalid: "Enter the install date as a date.",
  date_future: "The install date can't be in the future.",
  replaces: "Couldn't save that. Try again.",
};

export interface TechEquipmentUnit {
  readonly id: string;
  readonly equipmentType: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly locationInHome: string | null;
  readonly notes: string | null;
  readonly installDate: string | null;
  readonly managedExternally: boolean;
}

export interface TechEquipmentView {
  readonly units: readonly TechEquipmentUnit[];
  readonly canWrite: boolean;
}

const TOO_LONG = Symbol("too_long");

function field(v: unknown): string | null | typeof TOO_LONG {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  return t.length > EQUIPMENT_TEXT_MAX ? TOO_LONG : t;
}

function isRealDate(ymd: string): boolean {
  const m = YMD_RE.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/** `today` is YYYY-MM-DD in the business timezone (`todayInZone`). */
export function parseEquipmentInput(
  raw: EquipmentRaw, today: string,
): { ok: true; value: EquipmentInput } | { ok: false; error: EquipmentFieldError } {
  const type = raw.equipmentType;
  if (typeof type !== "string" || !(EQUIPMENT_TYPE_VALUES as readonly string[]).includes(type)) return { ok: false, error: "type" };
  const make = field(raw.make);
  const model = field(raw.model);
  const serialNumber = field(raw.serialNumber);
  const locationInHome = field(raw.locationInHome);
  const notes = field(raw.notes);
  if ([make, model, serialNumber, locationInHome, notes].includes(TOO_LONG)) return { ok: false, error: "too_long" };
  if (type === "other" && notes === null) return { ok: false, error: "describe" };

  let installDate: string | null = null;
  if (typeof raw.installDate === "string" && raw.installDate.trim() !== "") {
    const d = raw.installDate.trim();
    if (!isRealDate(d)) return { ok: false, error: "date_invalid" };
    if (d > today) return { ok: false, error: "date_future" };
    installDate = d;
  }
  let replacesId: string | null = null;
  if (raw.replacesId !== undefined && raw.replacesId !== null && raw.replacesId !== "") {
    if (typeof raw.replacesId !== "string" || !UUID_RE.test(raw.replacesId)) return { ok: false, error: "replaces" };
    replacesId = raw.replacesId.toLowerCase();
  }
  return {
    ok: true,
    value: {
      equipmentType: type as EquipmentTypeValue,
      make: make as string | null, model: model as string | null, serialNumber: serialNumber as string | null,
      locationInHome: locationInHome as string | null, notes: notes as string | null, installDate, replacesId,
    },
  };
}

/** YYYY-MM-DD of `now` in the business timezone. */
export function todayInZone(now: Date, timeZone: string = BUSINESS_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - at.getTime();
}

/** Noon on `ymd` in the business timezone, as an instant (spec §5.6: "stored as noon"). */
export function noonInZone(ymd: string, timeZone: string = BUSINESS_TZ): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Date(guess - zoneOffsetMs(new Date(guess), timeZone));
}
