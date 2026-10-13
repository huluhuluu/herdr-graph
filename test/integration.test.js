"use strict";

// Integration tests against the sessions that actually exist on this machine.
// They skip cleanly when an agent has no sessions on disk, so the suite stays
// portable.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const codex = require("../src/adapters/codex");
const claude = require("../src/adapters/claude");
const adapters = require("../src/adapters");
const { makeStore } = require("../src/store");
const { width } = require("../src/util");

const hasCodex = codex.listSessionFiles().length > 0;
const hasClaude = claude.listSessionFiles().length > 0;

test("codex: session ids are unique and taken from the filename", { skip: !hasCodex }, () => {
  const files = codex.listSessionFiles();
  const ids = files.map(codex.sessionIdFromFile);
  assert.ok(ids.every(Boolean), "every rollout filename must carry a uuid");
  assert.strictEqual(new Set(ids).size, ids.length, "session ids must be unique");
  // Herdr reports the filename uuid, so readMeta must agree with it.
  for (const f of files.slice(0, 25)) {
    const meta = codex.readMeta(f);
    assert.strictEqual(meta.sessionId, codex.sessionIdFromFile(f));
  }
});

// Missing parent transcripts are valid; fixture branch tests cover that case.
test("codex: turns never carry injected context as a prompt", { skip: !hasCodex }, t => {
  const files = codex.listSessionFiles().filter(f => fs.statSync(f).size < 2 * 1048576).slice(0, 12);
  let checked = 0;
  for (const f of files) {
    for (const t of codex.parseTurns(f)) {
      checked++;
      assert.ok(!/^<environment_context>/.test(t.promptFull), `env context leaked in ${f}`);
      assert.ok(!/^#\s*AGENTS\.md instructions/.test(t.promptFull), `AGENTS.md leaked in ${f}`);
    }
  }
  if (!checked) t.skip("No human turns in the sampled local sessions");
});

test("codex: turn ordinals are monotonically ordered within a session", { skip: !hasCodex }, () => {
  const file = codex.listSessionFiles()
    .map(f => ({ f, s: fs.statSync(f).size }))
    .filter(x => x.s > 20000 && x.s < 2 * 1048576)
    .sort((a, b) => b.s - a.s)[0]?.f;
  if (!file) return;
  const turns = codex.parseTurns(file);
  for (let i = 1; i < turns.length; i++) {
    assert.ok(turns[i].ordStart >= turns[i - 1].ordStart, "ordinals must not go backwards");
  }
});

test("codex: a forked child's fork ordinal locates a turn in the parent", { skip: !hasCodex }, () => {
  const all = codex.listSessions();
  const byId = new Map(all.map(s => [s.sessionId, s]));
  const child = all.find(s => s.parentSessionId && Number.isFinite(s.forkOrdinalExclusive) && byId.has(s.parentSessionId));
  if (!child) return;
  const parentTurns = codex.parseTurns(byId.get(child.parentSessionId).file);
  assert.ok(parentTurns.length > 0, "parent must have turns");
  let target = null;
  for (const t of parentTurns) {
    if (Number.isFinite(t.ordStart) && t.ordStart < child.forkOrdinalExclusive) target = t;
  }
  assert.ok(target, "fork ordinal must fall inside the parent's turn range");
});

test("claude: session ids come from the filename", { skip: !hasClaude }, () => {
  const files = claude.listSessionFiles();
  const ids = files.map(claude.sessionIdFromFile);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const f of files.slice(0, 25)) {
    assert.strictEqual(claude.readMeta(f).sessionId, claude.sessionIdFromFile(f));
  }
});

test("claude: parses turns and filters tool_result-only records", { skip: !hasClaude }, () => {
  const file = claude.listSessionFiles()
    .map(f => ({ f, s: fs.statSync(f).size }))
    .sort((a, b) => b.s - a.s)[0].f;
  const turns = claude.parseTurns(file);
  assert.ok(turns.length > 0, "expected turns");
  for (const t of turns) {
    assert.ok(t.promptFull.length > 0, "every node must carry a prompt");
    assert.ok(!t.promptFull.includes('"tool_use_id"'), "tool_result JSON leaked into a prompt");
    assert.ok(!/^<local-command-caveat>/.test(t.promptFull), "caveat wrapper leaked");
    assert.ok(!/^This session is being continued from a previous/.test(t.promptFull), "compaction summary leaked");
    assert.ok(!/^\[Request interrupted by user/.test(t.promptFull), "interrupt notice leaked");
  }
});

test("claude: parentKey links resolve inside the session", { skip: !hasClaude }, () => {
  const file = claude.listSessionFiles()
    .map(f => ({ f, s: fs.statSync(f).size }))
    .filter(x => x.s > 20000)
    .sort((a, b) => b.s - a.s)[0]?.f;
  if (!file) return;
  const turns = claude.parseTurns(file);
  const keys = new Set(turns.map(t => t.key));
  for (const t of turns) {
    if (t.parentKey) assert.ok(keys.has(t.parentKey), `dangling parentKey ${t.parentKey}`);
  }
});

test("buildGraph: node parents resolve and depth is non-negative", { skip: !hasCodex && !hasClaude }, t => {
  const adapter = hasCodex ? codex : claude;
  const file = adapter.listSessionFiles()
    .map(f => ({ f, s: fs.statSync(f).size }))
    .filter(x => x.s > 10000 && x.s < 4 * 1048576)
    .sort((a, b) => b.s - a.s)[0]?.f;
  if (!file) return t.skip("No local session within the test size range");
  const store = makeStore();
  const graph = adapters.buildGraph({ adapter, file, scope: "session", store });
  assert.ok(graph.nodes.length > 0, "expected nodes");
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const n of graph.nodes) {
    assert.ok(n.depth >= 0, "depth must be non-negative");
    if (n.parentId) assert.ok(byId.has(n.parentId), `dangling parentId ${n.parentId}`);
  }
  assert.strictEqual(graph.focusSessionId, adapter.sessionIdFromFile(file));
});

test("buildGraph: a linear session renders flat (no fake indentation)", { skip: !hasCodex }, () => {
  const all = codex.listSessions();
  // Find a session with no children and no parent: a plain linear conversation.
  const childIds = new Set(all.map(s => s.parentSessionId).filter(Boolean));
  const linear = all.find(s => !s.parentSessionId && !childIds.has(s.sessionId) && s.size > 8000 && s.size < 2 * 1048576);
  if (!linear) return;
  const store = makeStore();
  const graph = adapters.buildGraph({ adapter: codex, file: linear.file, scope: "session", store });
  if (graph.nodes.length < 2) return;
  const depths = new Set(graph.nodes.map(n => n.depth));
  assert.strictEqual(depths.size, 1, `linear session must be flat, got depths ${[...depths]}`);
  assert.strictEqual([...depths][0], 0);
});

test("buildGraph: lineage scope pulls in the parent session", { skip: !hasCodex }, () => {
  const all = codex.listSessions();
  const byId = new Map(all.map(s => [s.sessionId, s]));
  const child = all.find(s => s.parentSessionId && byId.has(s.parentSessionId) && s.size < 2 * 1048576);
  if (!child) return;
  const store = makeStore();
  const graph = adapters.buildGraph({ adapter: codex, file: child.file, scope: "lineage", store });
  assert.ok(graph.sessions.size >= 2, "lineage must include parent and child");
  const sessionIds = [...graph.sessions.values()].map(s => s.sessionId);
  assert.ok(sessionIds.includes(child.parentSessionId), "parent session must be loaded");
});

test("render width: every node label fits the graph column", { skip: !hasCodex }, () => {
  const file = codex.listSessionFiles()
    .map(f => ({ f, s: fs.statSync(f).size }))
    .filter(x => x.s > 10000 && x.s < 2 * 1048576)
    .sort((a, b) => b.s - a.s)[0]?.f;
  if (!file) return;
  const store = makeStore();
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "session", store });
  const GW = 55;
  for (const n of graph.nodes) {
    const depth = Math.min(n.depth || 0, Math.floor((GW - 26) / 2));
    const labelX = 1 + 2 + depth * 2 + 2 + 2;
    const room = GW - labelX - 2;
    assert.ok(room >= 8, `no room left for label at depth ${depth}`);
  }
});
