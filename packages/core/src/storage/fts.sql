-- FTS5 search table. Prisma cannot model a virtual table, so this lives in raw
-- SQL, is created by a raw migration, and is queried with $queryRaw.
--
-- The tokenizer strips diacritics: SQLite's LIKE is case-insensitive for ASCII
-- only, so `contains` silently stops working on accented words. "cafe" matches
-- "café" here.
--
-- memory_fts is an external content table: it indexes rows that live in Memory
-- and stores no copy of the text, kept in step by triggers, so a row removed by
-- a cascade leaves no index entry behind.
--
-- Tag slugs live in Tag and MemoryTag, and no trigger on Memory can join them.
-- Memory carries a tagText column instead, the slugs space separated, which
-- core fills on every tag change, and the trigger indexes that. That is what
-- makes #nightstash searchable as the word nightstash.

-- Memory -------------------------------------------------------------------

CREATE VIRTUAL TABLE "memory_fts" USING fts5(
  "title",
  "body",
  "why",
  "tagText",
  content = 'Memory',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER "memory_fts_ai" AFTER INSERT ON "Memory" BEGIN
  INSERT INTO "memory_fts"("rowid", "title", "body", "why", "tagText")
  VALUES (new."rowid", new."title", new."body", new."why", new."tagText");
END;

CREATE TRIGGER "memory_fts_ad" AFTER DELETE ON "Memory" BEGIN
  INSERT INTO "memory_fts"("memory_fts", "rowid", "title", "body", "why", "tagText")
  VALUES ('delete', old."rowid", old."title", old."body", old."why", old."tagText");
END;

CREATE TRIGGER "memory_fts_au" AFTER UPDATE ON "Memory" BEGIN
  INSERT INTO "memory_fts"("memory_fts", "rowid", "title", "body", "why", "tagText")
  VALUES ('delete', old."rowid", old."title", old."body", old."why", old."tagText");
  INSERT INTO "memory_fts"("rowid", "title", "body", "why", "tagText")
  VALUES (new."rowid", new."title", new."body", new."why", new."tagText");
END;
