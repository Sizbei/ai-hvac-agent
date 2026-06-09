import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return url;
}

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

// Connect lazily on first use. `next build` evaluates route modules to collect
// page data, which imports this module; connecting eagerly here would read
// DATABASE_URL at build time and throw when it isn't present in the build
// environment (it's a runtime-only secret). The Proxy defers neon()/drizzle()
// until the first query, so importing `db` never touches DATABASE_URL — only an
// actual request does.
let cached: DrizzleDb | undefined;

function getDb(): DrizzleDb {
  if (!cached) {
    const sql = neon(getDatabaseUrl());
    cached = drizzle(sql, { schema });
  }
  return cached;
}

export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
}) as DrizzleDb;

export type Database = DrizzleDb;
