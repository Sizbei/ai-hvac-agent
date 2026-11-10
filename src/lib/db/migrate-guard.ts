/**
 * The production Neon host may only be migrated by the production build
 * (VERCEL_ENV=production) or a deliberate out-of-band run that sets
 * MIGRATE_PROD_CONFIRM=1 (the manual GitHub workflow, MIGRATIONS.md). Anywhere
 * else — a local `npm run db:migrate`, a preview build that inherited the prod
 * DATABASE_URL — it is an accident.
 */
const PROD_HOST_MARKER = "ep-withered-hill";

function hostOf(databaseUrl: string): string {
  try {
    // postgresql: is a non-special scheme, so URL keeps the host's case.
    return new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return databaseUrl.toLowerCase(); // unparseable: judge the whole string, err on refusing
  }
}

/** The one-line refusal reason, or null when migrating is allowed. Never echoes the URL. */
export function prodMigrationRefusal({
  databaseUrl,
  vercelEnv,
  confirm,
}: {
  databaseUrl: string | undefined;
  vercelEnv: string | undefined;
  /** MIGRATE_PROD_CONFIRM; only the exact string "1" confirms. */
  confirm?: string | undefined;
}): string | null {
  if (!databaseUrl || !hostOf(databaseUrl).includes(PROD_HOST_MARKER)) return null;
  if (vercelEnv === "production" || confirm === "1") return null;
  return "Refusing to migrate: DATABASE_URL is the production database and VERCEL_ENV is not production (set MIGRATE_PROD_CONFIRM=1 for a deliberate manual run).";
}
