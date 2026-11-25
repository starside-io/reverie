-- MemoryVersion.operation gains 'merge', so memory.merge records what it did
-- instead of borrowing 'supersede' and 'update'.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt the way
-- Prisma redefines a table: a new table with the widened CHECK, every row
-- copied across as it is, the old table dropped and the new one renamed.
-- MemoryVersion has no foreign keys and no search index, so nothing else moves.
-- The value list matches VersionOperation in src/schemas/enums.ts.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MemoryVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memoryId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "contentSha256" TEXT,
    "body" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryVersion_operation_check" CHECK ("operation" IN ('create', 'update', 'refine', 'supersede', 'shelve', 'retire', 'redact', 'forget', 'merge'))
);
INSERT INTO "new_MemoryVersion" ("id", "memoryId", "operation", "actor", "contentSha256", "body", "at")
SELECT "id", "memoryId", "operation", "actor", "contentSha256", "body", "at" FROM "MemoryVersion";
DROP TABLE "MemoryVersion";
ALTER TABLE "new_MemoryVersion" RENAME TO "MemoryVersion";
CREATE INDEX "MemoryVersion_memoryId_at_idx" ON "MemoryVersion"("memoryId", "at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
