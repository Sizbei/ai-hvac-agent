/**
 * The production Neon host may only be migrated by the production build
 * (VERCEL_ENV=production). Anywhere else — a local `npm run db:migrate`, a
 * preview build that inherited the prod DATABASE_URL — it is an accident.
 */
const PROD_HOST_MARKER = "ep-withered-hill";

function hostOf(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return databaseUrl; // unparseable: judge the whole string, err on refusing
  }
}

/** The one-line refusal reason, or null when migrating is allowed. Never echoes the URL. */
export function prodMigrationRefusal({
  databaseUrl,
  vercelEnv,
}: {
  databaseUrl: string | undefined;
  vercelEnv: string | undefined;
}): string | null {
  if (!databaseUrl || !hostOf(databaseUrl).includes(PROD_HOST_MARKER)) return null;
  if (vercelEnv === "production") return null;
  return "Refusing to migrate: DATABASE_URL is the production database and VERCEL_ENV is not production.";
}
