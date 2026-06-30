import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function runMigrations(): Promise<void> {
  // Guard against Vercel PREVIEW/DEVELOPMENT builds migrating a database they
  // shouldn't. The deploy build command runs this on every deployment; without
  // a separate preview DB, Vercel previews inherit the production DATABASE_URL,
  // so an abandoned PR's forward-only migration would permanently alter prod.
  // VERCEL_ENV is set only on Vercel (production|preview|development); it is
  // unset locally and in CI, so manual `npm run db:migrate` always runs.
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== "production") {
    console.log(
      `Skipping migrations: VERCEL_ENV="${vercelEnv}" (only production deploys migrate; run manually for preview DBs).`,
    );
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  console.log("Running migrations...");

  const sql = neon(process.env.DATABASE_URL);
  const db = drizzle(sql);

  await migrate(db, { migrationsFolder: "./drizzle" });

  console.log("Migrations complete!");
}

runMigrations().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
