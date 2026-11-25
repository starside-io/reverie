-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "shelfId" TEXT,
    "tagId" TEXT,
    "description" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_shelfId_fkey" FOREIGN KEY ("shelfId") REFERENCES "Shelf" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Project_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "Shelf" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sectionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    CONSTRAINT "Shelf_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callNumber" TEXT NOT NULL,
    "shelfId" TEXT NOT NULL,
    "occurredOn" DATETIME NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scopeRef" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "why" TEXT,
    "howToApply" TEXT,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "trust" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "supersededById" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "lastConfirmedAt" DATETIME NOT NULL,
    "lastRecalledAt" DATETIME,
    "recallCount" INTEGER NOT NULL DEFAULT 0,
    "tagText" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Memory_shelfId_fkey" FOREIGN KEY ("shelfId") REFERENCES "Shelf" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Memory_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Memory" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Memory_kind_check" CHECK ("kind" IN ('fact', 'preference', 'procedure', 'episode', 'reference')),
    CONSTRAINT "Memory_scope_check" CHECK ("scope" IN ('global', 'project', 'agent', 'session')),
    CONSTRAINT "Memory_trust_check" CHECK ("trust" IN ('stated', 'confirmed', 'inferred', 'external')),
    CONSTRAINT "Memory_state_check" CHECK ("state" IN ('active', 'superseded', 'retired'))
);

-- CreateTable
CREATE TABLE "CallNumberAlias" (
    "oldCallNumber" TEXT NOT NULL PRIMARY KEY,
    "memoryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallNumberAlias_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "colour" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "MemoryTag" (
    "memoryId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("memoryId", "tagId"),
    CONSTRAINT "MemoryTag_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MemoryRef" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memoryId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "uri" TEXT,
    "label" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "MemoryRef_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryRef_role_check" CHECK ("role" IN ('attendee', 'occasion', 'mentions'))
);

-- CreateTable
CREATE TABLE "MemoryVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memoryId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "contentSha256" TEXT,
    "body" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryVersion_operation_check" CHECK ("operation" IN ('create', 'update', 'refine', 'supersede', 'shelve', 'retire', 'redact', 'forget'))
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "uri" TEXT,
    "label" TEXT NOT NULL,
    "occurredAt" DATETIME,
    "trust" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Source_kind_check" CHECK ("kind" IN ('conversation', 'file', 'page', 'tool_result', 'import')),
    CONSTRAINT "Source_trust_check" CHECK ("trust" IN ('stated', 'confirmed', 'inferred', 'external'))
);

-- CreateTable
CREATE TABLE "MemorySource" (
    "memoryId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "quote" TEXT NOT NULL,

    PRIMARY KEY ("memoryId", "sourceId"),
    CONSTRAINT "MemorySource_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemorySource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MemorySource_quote_length_check" CHECK (length("quote") <= 500)
);

-- CreateTable
CREATE TABLE "MemoryLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Memory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Memory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryLink_relation_check" CHECK ("relation" IN ('elaborates', 'contradicts', 'derived-from'))
);

-- CreateTable
CREATE TABLE "Embedding" (
    "memoryId" TEXT NOT NULL PRIMARY KEY,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "vector" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Embedding_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RecallLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scope" TEXT NOT NULL,
    "scopeRef" TEXT,
    "memoryIds" JSONB NOT NULL,
    "scores" JSONB NOT NULL,
    "budget" INTEGER NOT NULL,
    CONSTRAINT "RecallLog_scope_check" CHECK ("scope" IN ('global', 'project', 'agent', 'session'))
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_repoUrl_key" ON "Project"("repoUrl");

-- CreateIndex
CREATE INDEX "Project_shelfId_idx" ON "Project"("shelfId");

-- CreateIndex
CREATE INDEX "Project_tagId_idx" ON "Project"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "Section_code_key" ON "Section"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Shelf_sectionId_code_key" ON "Shelf"("sectionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Memory_callNumber_key" ON "Memory"("callNumber");

-- CreateIndex
CREATE INDEX "Memory_occurredOn_idx" ON "Memory"("occurredOn");

-- CreateIndex
CREATE INDEX "Memory_state_idx" ON "Memory"("state");

-- CreateIndex
CREATE INDEX "Memory_kind_idx" ON "Memory"("kind");

-- CreateIndex
CREATE INDEX "Memory_scope_scopeRef_idx" ON "Memory"("scope", "scopeRef");

-- CreateIndex
CREATE UNIQUE INDEX "Memory_shelfId_occurredOn_seq_key" ON "Memory"("shelfId", "occurredOn", "seq");

-- CreateIndex
CREATE INDEX "CallNumberAlias_memoryId_idx" ON "CallNumberAlias"("memoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_slug_key" ON "Tag"("slug");

-- CreateIndex
CREATE INDEX "MemoryTag_tagId_idx" ON "MemoryTag"("tagId");

-- CreateIndex
CREATE INDEX "MemoryRef_memoryId_idx" ON "MemoryRef"("memoryId");

-- CreateIndex
CREATE INDEX "MemoryRef_uri_idx" ON "MemoryRef"("uri");

-- CreateIndex
CREATE INDEX "MemoryVersion_memoryId_at_idx" ON "MemoryVersion"("memoryId", "at");

-- CreateIndex
CREATE INDEX "MemorySource_sourceId_idx" ON "MemorySource"("sourceId");

-- CreateIndex
CREATE INDEX "MemoryLink_toId_idx" ON "MemoryLink"("toId");

-- CreateIndex
CREATE INDEX "MemoryLink_relation_idx" ON "MemoryLink"("relation");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryLink_fromId_toId_relation_key" ON "MemoryLink"("fromId", "toId", "relation");

-- CreateIndex
CREATE INDEX "SessionNote_sessionId_idx" ON "SessionNote"("sessionId");

-- CreateIndex
CREATE INDEX "SessionNote_expiresAt_idx" ON "SessionNote"("expiresAt");

-- CreateIndex
CREATE INDEX "RecallLog_at_idx" ON "RecallLog"("at");
