/**
 * The front matter of a markdown file: a small YAML reader and writer.
 *
 * The writer emits one plain style that YAML and Obsidian both read: block
 * mappings and block sequences, every string double quoted with JSON's
 * escapes (plus the few characters YAML treats as line breaks), numbers,
 * booleans and null bare. The reader takes that, and the subset of YAML a
 * person or another tool writes by hand in front matter: plain, single and
 * double quoted scalars, block and flow collections, `|` and `>` block
 * scalars, comments. Anchors, tags and multiple documents are not front
 * matter and are refused with the line they are on.
 */

export class FrontMatterError extends Error {
  readonly line: number | null;
  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `line ${line}: ${message}`);
    this.name = "FrontMatterError";
    this.line = line;
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** A string as a YAML double quoted scalar: JSON's escapes, and the line breaks YAML adds escaped too. */
export function quoteString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FrontMatterError("A number in front matter must be finite.");
    return String(value);
  }
  if (typeof value === "string") return quoteString(value);
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (typeof value === "object" && Object.keys(value as object).length === 0) return "{}";
  return null;
}

function plainKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : quoteString(key);
}

function renderInto(lines: string[], value: unknown, indent: number): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      const inline = scalar(item);
      if (inline !== null) {
        lines.push(`${pad}- ${inline}`);
        continue;
      }
      // A mapping or a list as an item: its first line rides on the dash.
      const nested: string[] = [];
      renderInto(nested, item, indent + 2);
      const first = nested[0] ?? "";
      lines.push(`${pad}- ${first.slice(indent + 2)}`, ...nested.slice(1));
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    const inline = scalar(entry);
    if (inline !== null) {
      lines.push(`${pad}${plainKey(key)}: ${inline}`);
      continue;
    }
    lines.push(`${pad}${plainKey(key)}:`);
    renderInto(lines, entry, indent + 2);
  }
}

/** A mapping as YAML lines, each ending in a newline. */
export function renderYaml(data: Record<string, unknown>): string {
  const lines: string[] = [];
  renderInto(lines, data, 0);
  return lines.map((line) => `${line}\n`).join("");
}

/** A whole markdown file: front matter, then the body exactly, then one newline. */
export function renderMarkdown(data: Record<string, unknown>, body: string): string {
  return `---\n${renderYaml(data)}---\n${body}\n`;
}

/* ------------------------------------------------------------------ */
/* Splitting a file                                                    */
/* ------------------------------------------------------------------ */

export interface SplitFile {
  /** The YAML between the fences, or null when the file has no front matter. */
  yaml: string | null;
  /** Everything after the closing fence, less the one newline a file ends with. */
  body: string;
  /** The line the YAML starts on, for error messages. */
  yamlLine: number;
}

/** Front matter fenced by `---` lines at the very top, as Obsidian and Claude Code write it. */
export function splitFrontMatter(raw: string): SplitFile {
  let text = raw.startsWith("\ufeff") ? raw.slice(1) : raw;
  if (/^---[ \t]*\r\n/.test(text)) text = text.replace(/\r\n/g, "\n");
  const stripLast = (value: string) => (value.endsWith("\n") ? value.slice(0, -1) : value);
  if (!/^---[ \t]*\n/.test(text)) return { yaml: null, body: stripLast(text), yamlLine: 0 };
  const start = text.indexOf("\n") + 1;
  const fence = /^(?:---|\.\.\.)[ \t]*$/m;
  const rest = text.slice(start);
  const match = fence.exec(rest);
  if (!match) throw new FrontMatterError("The front matter opens with --- and never closes.", 1);
  const yaml = rest.slice(0, match.index);
  let after = rest.slice(match.index + match[0].length);
  if (after.startsWith("\n")) after = after.slice(1);
  return { yaml, body: stripLast(after), yamlLine: 2 };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const DOUBLE_ESCAPES: Record<string, string> = {
  "0": "\u0000",
  a: "\u0007",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\u000b",
  f: "\f",
  r: "\r",
  e: "\u001b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

function readDoubleQuoted(text: string, start: number, line: number): { value: string; end: number } {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') return { value: out, end: i + 1 };
    if (char === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "x" || next === "u" || next === "U") {
        const width = next === "x" ? 2 : next === "u" ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new FrontMatterError(`A bad \\${next} escape.`, line);
        const code = parseInt(hex, 16);
        out += width === 8 ? String.fromCodePoint(code) : String.fromCharCode(code);
        i += 2 + width;
        continue;
      }
      if (next === "\n") {
        i += 2;
        while (text[i] === " " || text[i] === "\t") i += 1;
        continue;
      }
      const mapped = DOUBLE_ESCAPES[next];
      if (mapped === undefined) throw new FrontMatterError(`An unknown escape \\${next}.`, line);
      out += mapped;
      i += 2;
      continue;
    }
    if (char === "\n") {
      // A line break inside double quotes folds to a space; an empty line is a newline.
      out = out.replace(/[ \t]+$/, "");
      let j = i + 1;
      let breaks = 0;
      while (j < text.length) {
        let k = j;
        while (text[k] === " " || text[k] === "\t") k += 1;
        if (text[k] === "\n") {
          breaks += 1;
          j = k + 1;
          continue;
        }
        j = k;
        break;
      }
      out += breaks > 0 ? "\n".repeat(breaks) : " ";
      i = j;
      continue;
    }
    out += char;
    i += 1;
  }
  throw new FrontMatterError("A double quoted string never closes.", line);
}

function readSingleQuoted(text: string, start: number, line: number): { value: string; end: number } {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    if (char === "\n") {
      out = out.replace(/[ \t]+$/, "") + " ";
      i += 1;
      while (text[i] === " " || text[i] === "\t") i += 1;
      continue;
    }
    out += char;
    i += 1;
  }
  throw new FrontMatterError("A single quoted string never closes.", line);
}

/** A plain scalar's value: null, a boolean, a number, or the text. */
function typedPlain(text: string): unknown {
  const value = text.trim();
  if (value === "" || value === "~" || /^(null|Null|NULL)$/.test(value)) return null;
  if (/^(true|True|TRUE)$/.test(value)) return true;
  if (/^(false|False|FALSE)$/.test(value)) return false;
  if (/^[-+]?\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
    return value;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Cuts a ` #` comment off a plain scalar. */
function uncomment(text: string): string {
  const match = /(^|[ \t])#/.exec(text);
  return (match ? text.slice(0, match.index) : text).trimEnd();
}

/* Flow collections, on one logical line: [a, "b", {c: d}]. */
function readFlow(text: string, line: number): unknown {
  let i = 0;
  const skip = () => {
    while (i < text.length && /[\s]/.test(text[i] as string)) i += 1;
  };
  const value = (inMap: boolean): unknown => {
    skip();
    const char = text[i];
    if (char === "[") {
      i += 1;
      const items: unknown[] = [];
      skip();
      if (text[i] === "]") {
        i += 1;
        return items;
      }
      for (;;) {
        items.push(value(false));
        skip();
        if (text[i] === ",") {
          i += 1;
          skip();
          if (text[i] === "]") {
            i += 1;
            return items;
          }
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return items;
        }
        throw new FrontMatterError("A flow sequence is missing a comma or a ].", line);
      }
    }
    if (char === "{") {
      i += 1;
      const map: Record<string, unknown> = {};
      skip();
      if (text[i] === "}") {
        i += 1;
        return map;
      }
      for (;;) {
        const key = value(true);
        skip();
        if (text[i] !== ":") throw new FrontMatterError("A flow mapping key has no colon.", line);
        i += 1;
        const entry = value(false);
        const name = String(key);
        if (Object.prototype.hasOwnProperty.call(map, name)) throw new FrontMatterError(`The key "${name}" appears twice.`, line);
        map[name] = entry;
        skip();
        if (text[i] === ",") {
          i += 1;
          skip();
          if (text[i] === "}") {
            i += 1;
            return map;
          }
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return map;
        }
        throw new FrontMatterError("A flow mapping is missing a comma or a }.", line);
      }
    }
    if (char === '"') {
      const read = readDoubleQuoted(text, i, line);
      i = read.end;
      return read.value;
    }
    if (char === "'") {
      const read = readSingleQuoted(text, i, line);
      i = read.end;
      return read.value;
    }
    const start = i;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === "," || c === "]" || c === "}") break;
      if (inMap && c === ":" && (i + 1 >= text.length || /[\s,\]}]/.test(text[i + 1] as string))) break;
      i += 1;
    }
    return typedPlain(text.slice(start, i));
  };
  const result = value(false);
  skip();
  if (i < text.length && !text.slice(i).trimStart().startsWith("#")) {
    throw new FrontMatterError("Text follows a flow collection.", line);
  }
  return result;
}

function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "#" && (i === 0 || /\s/.test(text[i - 1] as string))) break;
  }
  return depth;
}

interface Cursor {
  lines: string[];
  pos: number;
  base: number;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim().length === 0 || line.trimStart().startsWith("#");
const isSeqLine = (text: string) => text === "-" || text.startsWith("- ") || text.startsWith("-\t");

function lineNo(cursor: Cursor, at = cursor.pos): number {
  return cursor.base + at;
}

function skipBlank(cursor: Cursor): void {
  while (cursor.pos < cursor.lines.length && isBlank(cursor.lines[cursor.pos] as string)) cursor.pos += 1;
}

/** Where a plain mapping key ends: the first colon followed by a space or the end. -1 when there is none. */
function keyEnd(text: string): { key: string; rest: string } | null {
  const first = text[0];
  if (first === '"' || first === "'") {
    try {
      const read = first === '"' ? readDoubleQuoted(text, 0, 0) : readSingleQuoted(text, 0, 0);
      const after = text.slice(read.end);
      const match = /^[ \t]*:(?:[ \t]+|$)/.exec(after);
      if (!match) return null;
      return { key: read.value, rest: after.slice(match[0].length) };
    } catch {
      return null;
    }
  }
  if (first === "[" || first === "{" || first === "#" || first === "-" && isSeqLine(text)) return null;
  const match = /:(?:[ \t]+|$)/.exec(text);
  if (!match) return null;
  const key = text.slice(0, match.index).trim();
  if (key.length === 0 || /[#]/.test(key[0] as string)) return null;
  return { key, rest: text.slice(match.index + match[0].length) };
}

function refuseUnsupported(text: string, line: number): void {
  if (/^[&*!]/.test(text.trim())) throw new FrontMatterError("Anchors, aliases and tags are not read in front matter.", line);
}

function readBlockScalar(cursor: Cursor, header: string, parentIndent: number, line: number): string {
  const match = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(?:#.*)?$/.exec(header.trim());
  if (!match) throw new FrontMatterError("A block scalar header is malformed.", line);
  const folded = match[1] === ">";
  const chomp = match[2] || match[4] || "";
  const explicit = match[3] ? parentIndent + Number(match[3]) : null;
  const raw: string[] = [];
  let contentIndent = explicit;
  while (cursor.pos < cursor.lines.length) {
    const current = cursor.lines[cursor.pos] as string;
    if (current.trim().length === 0) {
      raw.push("");
      cursor.pos += 1;
      continue;
    }
    const indent = indentOf(current);
    if (indent <= parentIndent) break;
    if (contentIndent === null) contentIndent = indent;
    if (indent < contentIndent) break;
    raw.push(current.slice(contentIndent));
    cursor.pos += 1;
  }
  // Trailing blank lines belong to the chomping, not the content.
  let trailing = 0;
  while (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
    trailing += 1;
  }
  let text: string;
  if (folded) {
    text = "";
    raw.forEach((entry, index) => {
      if (index === 0) {
        text = entry;
        return;
      }
      const previous = raw[index - 1] as string;
      if (entry === "") text += "\n";
      else if (previous === "" || entry.startsWith(" ") || previous.startsWith(" ")) text += (previous === "" ? "" : "\n") + entry;
      else text += ` ${entry}`;
    });
  } else {
    text = raw.join("\n");
  }
  if (raw.length === 0) return "";
  if (chomp === "-") return text;
  if (chomp === "+") return `${text}\n${"\n".repeat(trailing)}`;
  return `${text}\n`;
}

/** A value written after `key: ` or `- `, with its continuation lines. */
function readInline(cursor: Cursor, text: string, parentIndent: number, line: number): unknown {
  refuseUnsupported(text, line);
  const trimmed = text.trim();
  if (trimmed.startsWith("|") || trimmed.startsWith(">")) return readBlockScalar(cursor, trimmed, parentIndent, line);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let joined = trimmed;
    while (bracketDepth(joined) > 0 && cursor.pos < cursor.lines.length) {
      joined += `\n${cursor.lines[cursor.pos] as string}`;
      cursor.pos += 1;
    }
    return readFlow(joined, line);
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    let joined = trimmed;
    for (;;) {
      try {
        const read = trimmed.startsWith('"') ? readDoubleQuoted(joined, 0, line) : readSingleQuoted(joined, 0, line);
        const after = joined.slice(read.end).trim();
        if (after.length > 0 && !after.startsWith("#")) throw new FrontMatterError("Text follows a quoted string.", line);
        return read.value;
      } catch (error) {
        if (!(error instanceof FrontMatterError) || !/never closes/.test(error.message) || cursor.pos >= cursor.lines.length) throw error;
        joined += `\n${cursor.lines[cursor.pos] as string}`;
        cursor.pos += 1;
      }
    }
  }
  // A plain scalar, folded over the more indented lines that follow it.
  let value = uncomment(trimmed);
  while (cursor.pos < cursor.lines.length) {
    const next = cursor.lines[cursor.pos] as string;
    if (next.trim().length === 0 || indentOf(next) <= parentIndent) break;
    const nextText = next.trim();
    if (nextText.startsWith("#")) break;
    value += ` ${uncomment(nextText)}`;
    cursor.pos += 1;
  }
  return typedPlain(value);
}

function readNode(cursor: Cursor, minIndent: number): unknown {
  skipBlank(cursor);
  if (cursor.pos >= cursor.lines.length) return null;
  const current = cursor.lines[cursor.pos] as string;
  const indent = indentOf(current);
  if (indent < minIndent) return null;
  const text = current.trim();
  if (isSeqLine(text)) return readSequence(cursor, indent);
  if (keyEnd(text)) return readMapping(cursor, indent);
  const line = lineNo(cursor);
  cursor.pos += 1;
  return readInline(cursor, text, indent - 1, line);
}

function readValueAfterKey(cursor: Cursor, rest: string, indent: number, line: number): unknown {
  if (uncomment(rest).trim().length > 0 || rest.trim().startsWith("|") || rest.trim().startsWith(">")) {
    return readInline(cursor, rest, indent, line);
  }
  skipBlank(cursor);
  if (cursor.pos >= cursor.lines.length) return null;
  const next = cursor.lines[cursor.pos] as string;
  const nextIndent = indentOf(next);
  if (nextIndent > indent) return readNode(cursor, nextIndent);
  // A sequence may sit at its key's own indent.
  if (nextIndent === indent && isSeqLine(next.trim())) return readSequence(cursor, indent);
  return null;
}

function readMapping(cursor: Cursor, indent: number): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (;;) {
    skipBlank(cursor);
    if (cursor.pos >= cursor.lines.length) break;
    const current = cursor.lines[cursor.pos] as string;
    const at = indentOf(current);
    if (at < indent) break;
    const line = lineNo(cursor);
    if (at > indent) throw new FrontMatterError("This line is indented further than its mapping.", line);
    const text = current.trim();
    if (isSeqLine(text)) break;
    const entry = keyEnd(text);
    if (!entry) throw new FrontMatterError("Expected `key: value`.", line);
    refuseUnsupported(entry.key, line);
    if (Object.prototype.hasOwnProperty.call(map, entry.key)) throw new FrontMatterError(`The key "${entry.key}" appears twice.`, line);
    cursor.pos += 1;
    map[entry.key] = readValueAfterKey(cursor, entry.rest, indent, line);
  }
  return map;
}

function readSequence(cursor: Cursor, indent: number): unknown[] {
  const items: unknown[] = [];
  for (;;) {
    skipBlank(cursor);
    if (cursor.pos >= cursor.lines.length) break;
    const current = cursor.lines[cursor.pos] as string;
    const at = indentOf(current);
    const text = current.trim();
    if (at !== indent || !isSeqLine(text)) {
      if (at > indent) throw new FrontMatterError("This line is indented further than its sequence.", lineNo(cursor));
      break;
    }
    const content = text.slice(1);
    const gap = content.length - content.trimStart().length;
    const rest = content.trimStart();
    if (rest.length === 0 || rest.startsWith("#")) {
      cursor.pos += 1;
      skipBlank(cursor);
      const next = cursor.lines[cursor.pos];
      items.push(next !== undefined && indentOf(next) > indent ? readNode(cursor, indentOf(next)) : null);
      continue;
    }
    // The item's content reads as if it were its own line at the column it starts on.
    const column = indent + 1 + gap;
    cursor.lines[cursor.pos] = `${" ".repeat(column)}${rest}`;
    items.push(readNode(cursor, column));
  }
  return items;
}

/** The YAML of one front matter block, as a mapping. Empty front matter is an empty mapping. */
export function parseYaml(source: string, firstLine = 1): Record<string, unknown> {
  const lines = source.split("\n").map((line) => line.replace(/\r$/, ""));
  lines.forEach((line, index) => {
    if (/^[ ]*\t/.test(line) && line.trim().length > 0) throw new FrontMatterError("Tabs are not indentation in YAML.", firstLine + index);
    if (/^(---|\.\.\.)\s*$/.test(line)) throw new FrontMatterError("Only one document is read.", firstLine + index);
  });
  const cursor: Cursor = { lines, pos: 0, base: firstLine };
  skipBlank(cursor);
  if (cursor.pos >= lines.length) return {};
  const value = readNode(cursor, 0);
  skipBlank(cursor);
  if (cursor.pos < lines.length) throw new FrontMatterError("Unexpected text after the front matter's mapping.", lineNo(cursor));
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new FrontMatterError("Front matter is a mapping of keys to values.", firstLine);
  return value as Record<string, unknown>;
}

/** A markdown file's front matter and body. */
export function parseMarkdown(raw: string): { data: Record<string, unknown> | null; body: string } {
  const split = splitFrontMatter(raw);
  if (split.yaml === null) return { data: null, body: split.body };
  return { data: parseYaml(split.yaml, split.yamlLine), body: split.body };
}
