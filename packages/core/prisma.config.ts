import { join } from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: join("src", "storage", "schema.prisma"),
});
