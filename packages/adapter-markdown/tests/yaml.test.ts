import { describe, expect, it } from "vitest";

import { FrontMatterError, parseMarkdown, parseYaml, renderMarkdown, renderYaml } from "../src/yaml.js";

describe("front matter, written and read back", () => {
  it("round trips every value the mirror writes, byte for byte", () => {
    const data = {
      id: "0b0c7a52-5f0e-4f43-9d6c-2a41f1c1a001",
      title: 'Christmas at "home": cafe\u0301 au lait',
      quote: "line one\nline two\ttabbed \\ backslash",
      odd: "\u2028\u2029\u0085\u007f\ufeff #not a comment: still text",
      emoji: "Sam Rivera \ud83c\udf84",
      lone: "\ud800",
      number: 3,
      negative: -2,
      fraction: 0.25,
      yes: true,
      no: false,
      nothing: null,
      looksLikeNumber: "007",
      looksLikeBool: "true",
      empty: "",
      list: ["christmas", "household"],
      none: [],
      map: {},
      refs: [
        { id: "a", label: "Jane Doe", uri: "module://people/person/jane", resolved: true },
        { id: "b", label: "Sam Rivera", uri: null, resolved: false },
      ],
      nested: { inner: { deep: ["x", { y: 1 }] } },
    };
    const text = renderYaml(data);
    expect(parseYaml(text)).toEqual(data);
  });

  it("keeps a body exactly, leading blank lines and fences inside it included", () => {
    for (const body of ["", "one line", "\nstarts blank", "ends with a newline\n", "has\n---\na fence", "#tag and **bold**"]) {
      const file = renderMarkdown({ title: "x" }, body);
      expect(parseMarkdown(file)).toEqual({ data: { title: "x" }, body });
    }
  });

  it("reads a file with no front matter as all body", () => {
    expect(parseMarkdown("Just a note about Port Aster.\n")).toEqual({ data: null, body: "Just a note about Port Aster." });
  });

  it("reads what a person or Obsidian writes by hand", () => {
    const yaml = [
      "# a comment",
      "title: Walk with Sam Rivera   # trailing comment",
      "kind: episode",
      "date: 2026-12-26",
      "tags: [walk, Port-Aster]",
      "aliases:",
      "- first",
      "- 'it''s second'",
      "attendees:",
      "  - Jane Doe",
      "  - John Doe",
      "why: |",
      "  Kept on purpose.",
      "  Two lines.",
      "folded: >-",
      "  one",
      "  two",
      "description: plain text: with a colon",
      "wrapped: this runs",
      "  over two lines",
      "metadata:",
      "  type: feedback",
      "flow: {a: 1, b: [x, \"y\"]}",
      "empty:",
    ].join("\n");
    expect(parseYaml(yaml)).toEqual({
      title: "Walk with Sam Rivera",
      kind: "episode",
      date: "2026-12-26",
      tags: ["walk", "Port-Aster"],
      aliases: ["first", "it's second"],
      attendees: ["Jane Doe", "John Doe"],
      why: "Kept on purpose.\nTwo lines.\n",
      folded: "one two",
      description: "plain text: with a colon",
      wrapped: "this runs over two lines",
      metadata: { type: "feedback" },
      flow: { a: 1, b: ["x", "y"] },
      empty: null,
    });
  });

  it("reads CRLF files and a byte order mark", () => {
    const parsed = parseMarkdown("\ufeff---\r\ntitle: x\r\n---\r\nbody\r\n");
    expect(parsed).toEqual({ data: { title: "x" }, body: "body" });
  });

  it("refuses what is not front matter, naming the line", () => {
    const cases: Array<[string, RegExp]> = [
      ["a: 1\na: 2", /appears twice/],
      ["a:\n\t- x", /Tabs/],
      ['a: "never closes', /never closes/],
      ["a: &anchor 1", /Anchors/],
      ["- just\n- a list", /mapping/],
      ["a: [1, 2", /flow sequence/],
    ];
    for (const [yaml, message] of cases) {
      expect(() => parseYaml(yaml), yaml).toThrow(FrontMatterError);
      expect(() => parseYaml(yaml), yaml).toThrow(message);
    }
    expect(() => parseMarkdown("---\ntitle: x\nno fence")).toThrow(/never closes/);
  });
});
