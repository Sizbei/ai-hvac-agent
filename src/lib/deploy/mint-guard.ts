/**
 * The dev session mint scripts (scripts/agent/mint-*-session.mjs) refuse the
 * production database unless `--prod` is passed. Pure and import-free so the
 * scripts can load it with plain node.
 */

const PROD_HOST = "ep-withered-hill";

/** The refusal line for a production DATABASE_URL without `--prod`; null to proceed. The url is never echoed. */
export function mintProdRefusal(databaseUrl: string | undefined, argv: readonly string[]): string | null {
  if (!(databaseUrl ?? "").toLowerCase().includes(PROD_HOST)) return null;
  if (argv.includes("--prod")) return null;
  return "Refusing to mint against the production database (ep-withered-hill). Pass --prod only if you mean it.";
}
