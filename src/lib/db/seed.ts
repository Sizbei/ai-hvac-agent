import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import bcrypt from "bcryptjs";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";

interface Technician {
  readonly email: string;
  readonly name: string;
}

async function seed(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  console.log("Seeding database...");

  const sql = neon(process.env.DATABASE_URL);
  const db = drizzle(sql, { schema });

  const passwordHash = await bcrypt.hash("admin123", 12);
  const techPasswordHash = await bcrypt.hash("tech123", 12);

  // 1. Demo organization
  await db
    .insert(schema.organizations)
    .values({
      id: DEMO_ORG_ID,
      name: "Demo HVAC Company",
      slug: "demo-hvac",
    })
    .onConflictDoNothing();

  console.log("  Created demo organization: Demo HVAC Company");

  // 2. Admin user
  await db
    .insert(schema.users)
    .values({
      organizationId: DEMO_ORG_ID,
      email: "admin@demo-hvac.com",
      name: "Admin User",
      passwordHash,
      role: "admin",
      isActive: true,
    })
    .onConflictDoNothing();

  console.log("  Created admin user: admin@demo-hvac.com");

  // 3. Three technicians with varied specializations
  const technicians: readonly Technician[] = [
    { email: "mike.johnson@demo-hvac.com", name: "Mike Johnson" },
    { email: "sarah.chen@demo-hvac.com", name: "Sarah Chen" },
    { email: "david.martinez@demo-hvac.com", name: "David Martinez" },
  ];

  for (const tech of technicians) {
    await db
      .insert(schema.users)
      .values({
        organizationId: DEMO_ORG_ID,
        email: tech.email,
        name: tech.name,
        passwordHash: techPasswordHash,
        role: "technician",
        isActive: true,
      })
      .onConflictDoNothing();

    console.log(`  Created technician: ${tech.email}`);
  }

  console.log("Seeding complete!");
}

seed().catch((error: unknown) => {
  console.error("Seeding failed:", error);
  process.exit(1);
});
