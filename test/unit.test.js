"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { mergeConfig, removeBlock, BEGIN, END } = require("../src/install");
const { width, truncate, pad, oneLine, wrap } = require("../src/util");
const { parseKeys, Screen, matchRanges, wrapMatches } = require("../src/ui");
const { isHumanText, isBracketNotice } = require("../src/noise");

test("search highlights literal case-insensitive matches, CJK columns and matches across wraps", () => {
  assert.deepStrictEqual(matchRanges("A.b a.B axb", "a.b"), [[0, 3], [4, 7]]);
  const screen = new Screen(); screen.clear();
  screen.highlightedText(2, 2, "中文🙂Needle", "needle", {});
  const highlight = screen.buffer[2].find(item => item.style?.bg === "yellow");
  assert.strictEqual(highlight.x, 8);
  assert.strictEqual(highlight.text, "Needle");
  const lines = wrapMatches("xx中文needle尾", 9, "needle");
  const marked = lines.flatMap(line => line.matches.map(([a, b]) => line.text.slice(a, b))).join("");
  assert.strictEqual(marked, "needle");
  assert.ok(lines.filter(line => line.matches.length).length > 1);
});

test("split terminal arrow sequences do not become a back or close command", async () => {
  const screen = new Screen(), keys = [];
  screen.onKey = key => keys.push(key.name);
  screen._handleInput("\x1b"); screen._handleInput("["); screen._handleInput("B");
  assert.deepStrictEqual(keys, ["down"]);
  screen._handleInput("\x1b");
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepStrictEqual(keys, ["down", "escape"]);
  screen._handleInput("\x1b[");
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepStrictEqual(keys, ["down", "escape"]);
  screen.stop();
});

test("mergeConfig appends a fenced block to an empty config", () => {
  const out = mergeConfig("", 'key = "prefix+g"');
  assert.ok(out.includes(BEGIN));
  assert.ok(out.includes(END));
  assert.ok(out.indexOf(BEGIN) < out.indexOf('key = "prefix+g"'));
});

test("mergeConfig replaces an existing block instead of duplicating it", () => {
  const first = mergeConfig("theme = \"dark\"\n", 'key = "prefix+g"');
  const second = mergeConfig(first, 'key = "prefix+j"');
  assert.strictEqual(second.split(BEGIN).length - 1, 1, "block must appear once");
  assert.ok(second.includes("prefix+j"));
  assert.ok(!second.includes("prefix+g"));
  assert.ok(second.includes('theme = "dark"'), "unrelated config is preserved");
});

test("mergeConfig preserves CRLF line endings", () => {
  const out = mergeConfig('theme = "dark"\r\n', 'key = "prefix+g"');
  assert.ok(out.includes("\r\n"));
});

test("mergeConfig refuses to steal a key bound outside the block", () => {
  const existing = '[[keys.command]]\nkey = "prefix+g"\ncommand = "other"\n';
  assert.throws(() => mergeConfig(existing, 'key = "prefix+g"'), /already bound/);
});

test("mergeConfig rejects malformed markers", () => {
  assert.throws(() => mergeConfig(`${BEGIN}\nkey = "x"\n`, 'key = "y"'), /markers/);
});

test("removeBlock deletes the managed block and nothing else", () => {
  const merged = mergeConfig('theme = "dark"\n', 'key = "prefix+g"');
  const { text, removed } = removeBlock(merged);
  assert.strictEqual(removed, true);
  assert.ok(!text.includes(BEGIN));
  assert.ok(text.includes('theme = "dark"'));
});

test("removeBlock is a no-op when no block exists", () => {
  const { removed } = removeBlock('theme = "dark"\n');
  assert.strictEqual(removed, false);
});

test("width counts CJK as two columns", () => {
  assert.strictEqual(width("abc"), 3);
  assert.strictEqual(width("中文"), 4);
  assert.strictEqual(width("a中"), 3);
});

test("truncate respects display width and adds an ellipsis", () => {
  assert.strictEqual(truncate("abcdef", 10), "abcdef");
  assert.strictEqual(width(truncate("abcdef", 4)), 4);
  assert.ok(truncate("abcdef", 4).endsWith("…"));
  // Must never cut a wide character in half.
  assert.ok(width(truncate("中文字符", 5)) <= 5);
});

test("pad fills to the requested display width", () => {
  assert.strictEqual(width(pad("ab", 6)), 6);
  assert.strictEqual(width(pad("中文", 6)), 6);
});

test("oneLine collapses whitespace and strips control characters", () => {
  assert.strictEqual(oneLine("a\n\n  b\tc"), "a b c");
  assert.strictEqual(oneLine("a\u0000b"), "a b");
});

test("wrap breaks on display width", () => {
  const lines = wrap("aaaa bbbb cccc", 5);
  for (const l of lines) assert.ok(width(l) <= 5, `line too wide: ${l}`);
});

test("parseKeys decodes arrows, enter, tab, and ctrl", () => {
  assert.deepStrictEqual(parseKeys("\x1b[A").map(k => k.name), ["up"]);
  assert.deepStrictEqual(parseKeys("\x1b[B").map(k => k.name), ["down"]);
  assert.deepStrictEqual(parseKeys("\r").map(k => k.name), ["enter"]);
  assert.deepStrictEqual(parseKeys("\t").map(k => k.name), ["tab"]);
  assert.deepStrictEqual(parseKeys("\x03").map(k => k.name), ["ctrl-c"]);
  assert.deepStrictEqual(parseKeys("q").map(k => k.name), ["q"]);
  assert.deepStrictEqual(parseKeys("\x1b[5~").map(k => k.name), ["pageup"]);
});

test("parseKeys keeps a multi-byte character intact", () => {
  const keys = parseKeys("中");
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(keys[0].name, "中");
  assert.strictEqual(keys[0].printable, true);
});

test("isBracketNotice filters CLI-injected notices", () => {
  assert.ok(isBracketNotice("[Request interrupted by user]"));
  assert.ok(isBracketNotice("[Request interrupted by user for tool use]"));
  assert.ok(isBracketNotice("[Image #1]"));
  assert.ok(!isBracketNotice("[my own note]"));
});

test("isHumanText rejects injected context for each agent", () => {
  // codex
  assert.ok(!isHumanText("<environment_context>\n<cwd>D:\\Code</cwd>", "codex"));
  assert.ok(!isHumanText("# AGENTS.md instructions\n<INSTRUCTIONS>", "codex"));
  assert.ok(!isHumanText("<codex_internal_context source=\"goal\">", "codex"));
  assert.ok(!isHumanText("<image name=[Image #1]>", "codex"));
  // claude
  assert.ok(!isHumanText("<local-command-caveat>x", "claude"));
  assert.ok(!isHumanText("<command-name>/foo</command-name>", "claude"));
  assert.ok(!isHumanText("[Request interrupted by user]", "claude"));
  assert.ok(!isHumanText("This session is being continued from a previous conversation", "claude"));
  // real prompts survive
  assert.ok(isHumanText("继续执行", "codex"));
  assert.ok(isHumanText("怎么约束的 为什么v0.2不是新页面", "claude"));
  assert.ok(isHumanText("Implement the plan.", "codex"));
  assert.ok(!isHumanText("", "codex"));
});
