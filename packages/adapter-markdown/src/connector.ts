import { readClaudeCodeDirectory } from "./claude-code.js";
import { adoptFiles, readMirror, writeMirror, type MirrorDocument, type ReadFile, type WriteReport } from "./mirror-fs.js";
import { MarkdownUnavailable } from "./paths.js";

/**
 * The `markdown` connector. docs/SPEC.md section 12: the optional
 * `connectors` port reaches the mirror folder; core never touches a file.
 *
 *   pull(cursor)    cursor is JSON: { op: "read_mirror" | "read_claude_code", folder }
 *                   and the items are the files read, one per item, id the
 *                   relative path, payload the file
 *   push(payload)   { op: "write_mirror", folder, documents, forgotten? }
 *                   or { op: "adopt", folder, files: { path: sha256 } }
 *
 * The shape it answers is the port's, declared here rather than imported, so
 * the package depends on nothing of core's, as the transcripts connector.
 */

export const CONNECTOR_NAME = "markdown";

export interface MarkdownItem {
  id: string;
  payload: ReadFile;
}

export interface MarkdownConnector {
  readonly name: typeof CONNECTOR_NAME;
  pull(cursor?: string | null): Promise<{ items: MarkdownItem[]; cursor: null }>;
  push(payload: unknown): Promise<WriteReport | { adopted: number }>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function documentsOf(value: unknown): MirrorDocument[] {
  if (!Array.isArray(value)) throw new MarkdownUnavailable("bad_payload", "A mirror is written from a list of documents.");
  return value.map((entry) => {
    const document = record(entry);
    const data = record(document?.["data"]);
    if (!document || typeof document["path"] !== "string" || !data) {
      throw new MarkdownUnavailable("bad_payload", "Each document has a path and data.");
    }
    if (document["format"] === "json") return { path: document["path"], format: "json", data };
    if (document["format"] !== "markdown" || typeof document["body"] !== "string") {
      throw new MarkdownUnavailable("bad_payload", "A markdown document has a body.");
    }
    return { path: document["path"], format: "markdown", data, body: document["body"] };
  });
}

export function createMarkdownConnector(): MarkdownConnector {
  return {
    name: CONNECTOR_NAME,
    async pull(cursor) {
      let request: Record<string, unknown> | null = null;
      try {
        request = record(JSON.parse(cursor ?? ""));
      } catch {
        request = null;
      }
      if (!request || (request["op"] !== "read_mirror" && request["op"] !== "read_claude_code")) {
        throw new MarkdownUnavailable("bad_cursor", "A markdown cursor is JSON naming an op and a folder.");
      }
      const files = request["op"] === "read_mirror" ? readMirror(request["folder"]) : readClaudeCodeDirectory(request["folder"]);
      return { items: files.map((file) => ({ id: file.path, payload: file })), cursor: null };
    },
    async push(payload) {
      const request = record(payload);
      if (request?.["op"] === "write_mirror") {
        const forgotten = Array.isArray(request["forgotten"])
          ? request["forgotten"].filter((id): id is string => typeof id === "string")
          : [];
        return writeMirror(request["folder"], documentsOf(request["documents"]), { forgotten });
      }
      if (request?.["op"] === "adopt") {
        return adoptFiles(request["folder"], record(request["files"]) ?? {});
      }
      throw new MarkdownUnavailable("bad_payload", "A markdown push is write_mirror or adopt.");
    },
  };
}
