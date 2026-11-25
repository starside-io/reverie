// The migrations and fts.sql are data the build has to carry: the host applies
// them at boot, from whichever directory it was loaded out of.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "src", "storage");
const to = join(root, "dist", "storage");

if (!existsSync(to)) {
  throw new Error(`Nothing at ${to}. Run the TypeScript build first.`);
}

cpSync(join(from, "migrations"), join(to, "migrations"), { recursive: true });
cpSync(join(from, "fts.sql"), join(to, "fts.sql"));
cpSync(join(from, "schema.prisma"), join(to, "schema.prisma"));
process.stdout.write(`Copied the SQL into ${to}\n`);
