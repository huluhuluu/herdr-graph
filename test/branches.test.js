"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const adapters = require("../src/adapters");
const codex = require("../src/adapters/codex");
const claude = require("../src/adapters/claude");
const dst = require("../src/adapters/dst");
const { App } = require("../src/graph");
const { catalogRows, directoryKey, filterSessions } = require("../src/catalog");
const { recordsFor, familyRows, edgeInfo, formatTime } = require("../src/relations");
const { Loader } = require("../src/loader");
const { spawn } = require("node:child_process");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const store = () => ({ get: () => null, put() {}, flush() {} });
function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "session-graph-branches-"));
  t.after(() => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith("session-graph-branches-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    DSH_HOME: path.join(root, "dst"), HERDR_PLUGIN_CONFIG_DIR: path.join(root, "config") };
}
function write(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}
function rollout(env, id, turns, { parent = null, ordinal = null, cwd = "/work/demo" } = {}) {
  const rows = [{ type: "session_meta", payload: { id, cwd, timestamp: "2026-10-12T09:00:00Z",
    forked_from_id: parent, forked_from_ordinal_exclusive: ordinal } }];
  turns.forEach((key, i) => {
    const timestamp = `2026-10-12T09:${key === "intro" ? "00" : String(i + 1).padStart(2, "0")}:00Z`;
    rows.push(...[
      { type: "task_started", turn_id: key }, { type: "user_message", message: `Prompt ${key}` },
      { type: "agent_message", message: `Reply ${key}` }, { type: "task_complete" },
    ].map((payload, j) => ({ type: "event_msg", timestamp, ordinal: i * 4 + j + 1, payload })));
  });
  return write(path.join(env.CODEX_HOME, "sessions", `rollout-2026-10-12-${id}.jsonl`), rows);
}
function appFor(graph, env) {
  const app = new App({ scope: graph.scope, env, store: store(), herdr: { paneList: () => [] } });
  app.graph = graph;
  app.callerPane = () => null;
  app.screen.cols = 118; app.screen.rows = 30;
  app.screen.out = { write(frame) { this.frame = frame; } };
  return app;
}

test("lineage attaches sibling forks at the recorded turn, counts edges and hides inherited copies", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main", "finish"]);
  rollout(env, B, ["intro", "branch-b"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "branch-c"], { parent: A, ordinal: 5 });
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: store() });
  const fork = graph.nodes.find(n => n.sessionId === A && n.key === "intro");
  const boundaries = graph.nodes.filter(n => n.sessionBoundary && n.parentSessionId === A);
  assert.equal(fork.branchCount, 3, "two child sessions plus parent continuation");
  assert.equal(fork.forkedChildren.length, 2);
  assert.deepEqual(new Set(boundaries.map(n => n.sessionId)), new Set([B, C]));
  for (const node of boundaries) {
    assert.equal(node.parentId, fork.id);
    assert.equal(node.forkLocation, "ordinal");
    assert.equal(node.sharedTurns, 1);
    assert.ok(node.depth > fork.depth);
    assert.ok(node.index > fork.index && node.index < graph.nodes.find(n => n.sessionId === A && n.key === "main").index);
  }
  assert.equal(graph.nodes.filter(n => n.key === "intro").length, 1);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const node of graph.nodes) if (node.parentId) assert.ok(byId.has(node.parentId));
});

test("fork without an ordinal uses the copied prefix; an unrecorded point never guesses the parent's latest turn", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main", "finish"]);
  rollout(env, B, ["intro", "new-path"], { parent: A });
  rollout(env, C, ["unrelated-text"], { parent: A });
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: store() });
  const known = graph.nodes.find(n => n.sessionId === B && n.sessionBoundary);
  assert.equal(known.forkPointId, `codex:${A}#intro`);
  assert.equal(known.forkLocation, "shared history");
  const unknown = graph.nodes.find(n => n.sessionId === C && n.sessionBoundary);
  assert.equal(unknown.parentId, `codex:${A}#session`);
  assert.equal(unknown.forkPointId, null);
  assert.equal(unknown.forkLocation, "unknown");
  const app = appFor(graph, env);
  app.selected = unknown.index;
  app.render();
  assert.ok(app.screen.out.frame.includes("fork point: not recorded"));
});

test("nested forks from inherited turns resolve back to the displayed ancestor; an empty fork still appears", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch-b"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro"], { parent: B, ordinal: 5 });
  rollout(env, D, [], { parent: B });
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: store() });
  const nested = graph.nodes.find(n => n.sessionId === C && n.sessionBoundary);
  assert.equal(nested.parentSessionId, B);
  assert.equal(nested.parentId, `codex:${A}#intro`);
  assert.equal(nested.sharedTurns, 1);
  assert.equal(graph.nodes.filter(n => n.sessionId === C).length, 1);
  const empty = graph.nodes.find(n => n.sessionId === D && n.sessionBoundary);
  assert.equal(empty.parentId, `codex:${B}#session`);
  assert.equal(empty.forkLocation, "unknown");
});

test("default conversation shows branch metadata without parsing child bodies; b loads the actual family", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  const parsed = [];
  const adapter = { ...codex, parseTurns(file) { parsed.push(file); return codex.parseTurns(file); } };
  const graph = adapters.buildGraph({ adapter, file, scope: "session", env, store: store() });
  assert.deepEqual(parsed, [file]);
  assert.equal(graph.nodes[0].forkedChildren[0].sessionId, B);
  const app = appFor(graph, env);
  app.render();
  assert.ok(app.screen.out.frame.includes("1 branches"));
  assert.ok(app.screen.out.frame.includes("[1 forks]"));
  app.handleKey({ name: "l" });
  assert.equal(app.scope, "lineage");
  assert.ok(app.nodes().some(n => n.sessionId === B && n.sessionBoundary));
  assert.equal(app.current().id, `codex:${A}#session`);
  assert.equal(app.relationView, true);
});

test("fold keys are idempotent and collapse linked child sessions together with the parent's continuation", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main", "finish"]);
  rollout(env, B, ["intro", "branch-b"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "branch-c"], { parent: A, ordinal: 5 });
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: store() });
  const app = appFor(graph, env);
  app.selected = graph.nodes.findIndex(n => n.key === "intro");
  const count = app.nodes().length;
  app.handleKey({ name: "h" });
  app.handleKey({ name: "h" });
  assert.equal(app.nodes().length, 2);
  app.handleKey({ name: "l" });
  app.handleKey({ name: "l" });
  assert.equal(app.nodes().length, count);
  app.selected = app.nodes().findIndex(n => n.sessionBoundary && n.sessionId === B);
  app.handleKey({ name: "h" });
  assert.ok(!app.nodes().some(n => n.sessionId === B && !n.sessionBoundary));
  assert.ok(app.nodes().some(n => n.sessionId === C && !n.sessionBoundary));
  assert.ok(app.nodes().some(n => n.sessionId === A && n.key === "finish"));
  app.render();
  assert.ok(app.screen.out.frame.includes("├─") || app.screen.out.frame.includes("└─"));
  assert.ok(app.screen.out.frame.includes("branch 22222222"));
});

test("directory history nests fork sessions; time, cross-directory and filtered views retain their native parent", t => {
  const env = fixture(t);
  rollout(env, A, ["intro"]);
  rollout(env, B, ["intro", "branch"], { parent: A });
  rollout(env, C, ["intro"], { parent: A, cwd: "/work/other" });
  const graph = adapters.buildGraph({ scope: "all", env, store: store(), registry: [codex] });
  const options = { expanded: new Set([directoryKey("/work/demo"), directoryKey("/work/other")]) };
  const rows = catalogRows(graph.nodes, options);
  const root = rows.find(n => n.sessionId === A);
  const branch = rows.find(n => n.sessionId === B);
  assert.equal(branch.parentId, root.id);
  assert.equal(branch.depth, root.depth + 1);
  assert.equal(root.branchCount, 1);
  assert.equal(rows.find(n => n.sessionId === C).parentId, null);
  assert.equal(rows.find(n => n.sessionId === C).parentSessionId, A);
  const folded = catalogRows(graph.nodes, { ...options, collapsed: new Set([root.id]) });
  assert.ok(!folded.some(n => n.sessionId === B));
  assert.ok(folded.some(n => n.sessionId === C));
  const filtered = catalogRows(filterSessions(graph.nodes, { search: B }), options);
  assert.equal(filtered.find(n => n.sessionId === B).parentId, null);
  assert.equal(filtered.find(n => n.sessionId === B).parentSessionId, A);
  const time = catalogRows(graph.nodes, { view: "time" });
  assert.equal(time.find(n => n.sessionId === B).parentSessionId, A);
  assert.ok(time.every(n => !n.parentId));
  const app = appFor(graph, env);
  app.expandedDirectories = options.expanded;
  app.render();
  assert.ok(app.screen.out.frame.includes("[branch]"));
  app.selected = app.nodes().findIndex(n => n.sessionId === B);
  app.handleKey({ name: "b" });
  assert.equal(app.scope, "lineage");
  assert.ok(app.nodes().some(n => n.sessionId === A));
});

test("back navigation restores history, conversation and family state across nested session pages", t => {
  const env = fixture(t);
  rollout(env, A, ["intro", ...Array.from({ length: 40 }, (_, i) => `turn-${i}`)]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "nested"], { parent: B, ordinal: 5 });
  rollout(env, D, ["other"], { cwd: "/work/other" });
  const history = adapters.buildGraph({ scope: "all", env, store: store() });
  const app = appFor(history, env);
  app.historyOrder = "oldest";
  app.agentFilter = "codex";
  app.search = "demo";
  app.expandedDirectories.add(directoryKey("/work/demo"));
  app.collapsed.add(`codex:${B}#session`);
  app.selected = app.nodes().findIndex(n => n.sessionId === A);
  const historySelected = app.selected;
  app.handleKey({ name: "enter" });
  assert.equal(app.scope, "session");
  const conversation = app.graph;
  app.search = "Prompt";
  app.selected = 30;
  app.top = 10;
  app.focus = "detail";
  app.scroll = 11;
  app.current().replyFull = "Saved content\n".repeat(80);
  const selectedTurn = app.current().id;
  app.handleKey({ name: "b" });
  const family = app.graph;
  assert.equal(app.scope, "lineage");
  app.collapsed.add(`codex:${C}#session`);
  app.selected = app.nodes().findIndex(n => n.sessionBoundary && n.sessionId === B);
  const familySelected = app.selected;
  app.handleKey({ name: "enter" });
  assert.equal(app.graph.focusSessionId, B);
  assert.equal(app.navigationStack.length, 3);
  // The new page may change these independent view settings.
  app.historyView = "time"; app.historyOrder = "newest"; app.agentFilter = "all";
  app.expandedDirectories.clear();
  app.load = () => assert.fail("returning must reuse the saved page, not reload transcripts");
  app.handleKey({ name: "backspace" });
  assert.equal(app.graph, family);
  assert.equal(app.scope, "lineage");
  assert.equal(app.selected, familySelected);
  assert.ok(app.collapsed.has(`codex:${C}#session`));
  assert.equal(app.activeSession.value, A);
  app.render();
  assert.ok(app.screen.out.frame.includes("Backspace/Esc back"));
  app.handleKey({ name: "escape" });
  assert.equal(app.graph, conversation);
  assert.equal(app.scope, "session");
  assert.equal(app.current().id, selectedTurn);
  assert.equal(app.search, "Prompt");
  assert.equal(app.top, 10);
  assert.equal(app.focus, "detail");
  assert.equal(app.scroll, 11);
  app.render();
  assert.equal(app.scroll, 11, "the restored detail position survives rendering");
  app.handleKey({ name: "backspace" });
  assert.equal(app.graph, history);
  assert.equal(app.scope, "all");
  assert.equal(app.selected, historySelected);
  assert.equal(app.activeSession, null);
  assert.equal(app.search, "demo");
  assert.equal(app.agentFilter, "codex");
  assert.equal(app.historyView, "directory");
  assert.equal(app.historyOrder, "oldest");
  assert.deepEqual(app.expandedDirectories, new Set([directoryKey("/work/demo")]));
  assert.deepEqual(app.collapsed, new Set([`codex:${B}#session`]));
  assert.equal(app.navigationStack.length, 0);
});

test("same-page commands and directory folding do not add back-navigation entries", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ adapter: codex, file, scope: "session", env, store: store() }), env);
  app.activeSession = { agent: "codex", value: A, file };
  app.handleKey({ name: "l" });
  assert.equal(app.navigationStack.length, 1);
  app.handleKey({ name: "b" });
  app.handleKey({ name: "b" });
  assert.equal(app.navigationStack.length, 1);
  app.handleKey({ name: "s" });
  assert.equal(app.navigationStack.length, 2);
  app.handleKey({ name: "s" });
  app.selected = 0;
  assert.ok(app.current().directoryOnly);
  app.handleKey({ name: "enter" });
  assert.equal(app.navigationStack.length, 2);
  for (const name of ["a", "v", "o"]) app.handleKey({ name });
  assert.equal(app.navigationStack.length, 2);
  app.handleKey({ name: "backspace" });
  assert.equal(app.scope, "lineage");
  app.handleKey({ name: "backspace" });
  assert.equal(app.scope, "session");
  app.handleKey({ name: "t" });
  assert.equal(app.scope, "lineage");
  app.handleKey({ name: "escape" });
  assert.equal(app.scope, "session");
});

test("editing consumes back keys; browse Escape goes back and root Escape or q closes", t => {
  const env = fixture(t);
  rollout(env, A, ["intro"]);
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time";
  let closes = 0;
  app.quit = () => { closes++; };
  app.handleKey({ name: "backspace" });
  assert.equal(closes, 0);
  assert.match(app.message, /first page/);
  app.handleKey({ name: "enter" });
  for (const [mode, field] of [["search", "searchInput"], ["rename", "renameInput"]]) {
    app.mode = mode; app[field] = "名称🙂";
    app.handleKey({ name: "backspace" });
    assert.equal(app[field], "名称");
    app.handleKey({ name: "escape" });
    assert.equal(app.mode, "browse");
    assert.equal(app.scope, "session");
    assert.equal(app.navigationStack.length, 1);
  }
  app.handleKey({ name: "?" });
  app.handleKey({ name: "escape" });
  assert.equal(app.navigationStack.length, 1);
  app.handleKey({ name: "q" });
  assert.equal(closes, 1);
  app.handleKey({ name: "escape" });
  assert.equal(app.scope, "all");
  assert.equal(closes, 1);
  app.handleKey({ name: "escape" });
  assert.equal(closes, 2);
});

test("a confirmed native rename remains visible after returning to saved family and history pages", async t => {
  const env = fixture(t);
  rollout(env, A, ["intro"]);
  rollout(env, B, ["intro", "branch"], { parent: A });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time";
  app.selected = app.nodes().findIndex(n => n.sessionId === A);
  app.handleKey({ name: "b" });
  app.selected = app.nodes().findIndex(n => n.sessionBoundary && n.sessionId === B);
  app.handleKey({ name: "enter" });
  app.renameSession = async (_session, title) => title;
  app.handleKey({ name: "R" });
  app.renameInput = "新分支名称";
  await app.handleKey({ name: "enter" });
  app.handleKey({ name: "backspace" });
  assert.equal(app.current().title, "新分支名称");
  assert.equal(app.familyFor("codex", A).children[0].title, "新分支名称");
  app.handleKey({ name: "backspace" });
  const renamed = app.nodes().find(n => n.sessionId === B);
  assert.equal(renamed.title, "新分支名称");
  assert.equal(renamed.prompt, "新分支名称");
  assert.equal(app.nodes().find(n => n.sessionId === A).forkedChildren[0].title, "新分支名称");
});

test("session relationship edges retain the direct parent when the fork anchor belongs to an inherited ancestor turn", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "nested"], { parent: B, ordinal: 5 });
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: store() });
  assert.equal(graph.nodes.find(n => n.sessionId === C && n.sessionBoundary).parentId, `codex:${A}#intro`);
  const rows = familyRows(graph, "codex", C);
  const nested = rows.find(n => n.sessionId === C);
  assert.equal(nested.parentId, `codex:${B}#session`);
  assert.equal(nested.depth, 2);
  assert.ok(rows.every(row => row.sessionBoundary));
  const info = edgeInfo(nested, recordsFor(graph), meta => graph.sessions.get(`codex:${meta.sessionId}`)?.turns);
  assert.equal(info.number, 1, "the turn number belongs to the direct parent's complete conversation");
  assert.equal(formatTime(info.turn.timestamp), "2026-10-12 09:00:00 UTC");
  assert.equal(info.sharedTurns, 1);
  assert.equal(info.addedTurns, 1);
});

test("selecting a history branch previews its parent, siblings and children and only parses the selection and direct parent", t => {
  const env = fixture(t);
  rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "sibling"], { parent: A, ordinal: 5 });
  rollout(env, D, ["intro", "nested"], { parent: B, ordinal: 5 });
  const graph = adapters.buildGraph({ scope: "all", env, store: store() });
  const parsed = [];
  for (const entry of graph.sessions.values()) entry.adapter = { ...codex, parseTurns(file) { parsed.push(codex.sessionIdFromFile(file)); return codex.parseTurns(file); } };
  const app = appFor(graph, env);
  app.historyView = "time";
  app.search = B;
  app.render();
  const frame = app.screen.out.frame;
  assert.deepEqual(parsed, [B, A]);
  for (const id of [A, B, C, D]) assert.ok(frame.includes(id.slice(0, 8)), `missing relationship ${id}`);
  assert.ok(frame.includes("turn 1"));
  assert.ok(frame.includes("2026-10-12 09:00:00 UTC"));
  assert.ok(frame.includes("1 shared") && frame.includes("1 new") && frame.includes("1 children"));
  app.render();
  assert.deepEqual(parsed, [B, A], "cached preview must not reparse while rendering or scrolling");
});

test("b opens a full session relationship page; T folds only its timestamps and repeated b never returns", t => {
  const env = fixture(t);
  rollout(env, A, ["intro", "main", "finish"]);
  rollout(env, B, ["intro", "main", "branch"], { parent: A, ordinal: 9 });
  rollout(env, C, ["intro", "sibling"], { parent: A, ordinal: 5 });
  const graph = adapters.buildGraph({ scope: "all", env, store: store() });
  const app = appFor(graph, env);
  app.historyView = "time"; app.search = B;
  app.handleKey({ name: "b" });
  assert.equal(app.relationView, true);
  assert.equal(app.current().sessionId, B);
  assert.ok(app.nodes().every(node => node.sessionBoundary));
  app.render();
  assert.ok(app.screen.out.frame.includes("session relationships"));
  assert.ok(app.screen.out.frame.includes("turn 2"), "human turn number must differ from the native event ordinal 9");
  assert.ok(app.screen.out.frame.includes("2026-10-12 09:02:00 UTC"));
  const nodeIds = app.nodes().map(node => node.id);
  app.handleKey({ name: "T" });
  app.render();
  assert.ok(!app.screen.out.frame.includes("2026-10-12"));
  assert.ok(app.screen.out.frame.includes("turn 2"));
  assert.deepEqual(app.nodes().map(node => node.id), nodeIds);
  const depth = app.navigationStack.length;
  app.handleKey({ name: "b" }); app.handleKey({ name: "b" });
  assert.equal(app.relationView, true);
  assert.equal(app.navigationStack.length, depth);
  app.handleKey({ name: "enter" });
  assert.equal(app.relationView, false);
  assert.equal(app.scope, "session");
  assert.equal(app.graph.focusSessionId, B);
  app.handleKey({ name: "backspace" });
  assert.equal(app.relationView, true);
  assert.equal(app.current().sessionId, B);
  app.handleKey({ name: "escape" });
  assert.equal(app.graph, graph);
  assert.equal(app.relationView, false);
  assert.equal(app.search, B);
  assert.equal(app.showRelationTime, false, "time visibility is kept across page navigation");
});

test("relationship preview stays fixed while the conversation content scrolls", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ adapter: codex, file, scope: "session", env, store: store() }), env);
  app.current().replyFull = Array.from({ length: 80 }, (_, i) => `Content line ${i}`).join("\n");
  app.focus = "detail";
  app.render();
  const before = JSON.stringify(app.screen.buffer.slice(2, 8));
  app.handleKey({ name: "pagedown" });
  app.render();
  assert.equal(app.scroll, 10);
  assert.equal(JSON.stringify(app.screen.buffer.slice(2, 8)), before);
});

test("family opens every session under the common ancestor, including sibling descendants, and excludes unrelated sessions", t => {
  const env = fixture(t);
  const unrelated = "55555555-5555-4555-8555-555555555555";
  rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "selected"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "sibling"], { parent: A, ordinal: 5 });
  rollout(env, D, ["intro", "nested"], { parent: C, ordinal: 5 });
  rollout(env, unrelated, ["unrelated"], { cwd: "/work/demo" });
  write(path.join(env.CODEX_HOME, "session_index.jsonl"), [
    { id: A, thread_name: "Root conversation" }, { id: B, thread_name: "Selected branch" },
    { id: C, thread_name: "Sibling branch" }, { id: D, thread_name: "Nested sibling" },
  ]);
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time";
  app.selected = app.nodes().findIndex(row => row.sessionId === B);
  app.handleKey({ name: "b" });
  assert.deepEqual(app.nodes().map(row => row.sessionId), [A, B, C, D]);
  assert.equal(app.current().sessionId, B);
  assert.equal(app.collapsed.size, 0, "opening a family must not silently fold sibling descendants");
  app.render();
  const G = app.layout().graph;
  const tree = app.screen.buffer.slice(G.y, G.y + G.h).flatMap(row => row.filter(item => item.x < G.w && item.prio > 0).map(item => item.text));
  for (const title of ["Root conversation", "Selected branch", "Sibling branch", "Nested sibling"]) assert.ok(tree.some(line => line.includes(title)));
  assert.equal(tree.filter(line => line.includes("conversation") || line.includes("branch") || line.includes("sibling")).length, 4);
  assert.ok(tree.find(line => line.includes("Selected branch")).startsWith("├─ ▶"));
  assert.ok(tree.find(line => line.includes("Nested sibling")).startsWith("  └─"));
  assert.equal(tree.filter(line => line.includes("[turn 1]")).length, 3, "every branch exposes its source turn without selecting it");
  assert.ok(tree.every(line => !line.includes("UTC")), "timestamps stay in the detail panel");
  assert.ok(app.screen.out.frame.includes("4 sessions"));
  assert.ok(!app.screen.out.frame.includes(unrelated));
});

test("family selection updates its parent and children panel; time folding preserves every tree row", t => {
  const env = fixture(t);
  rollout(env, A, ["intro"]);
  rollout(env, B, ["intro", "selected"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "sibling"], { parent: A, ordinal: 5 });
  rollout(env, D, ["intro", "nested"], { parent: C, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time";
  app.selected = app.nodes().findIndex(row => row.sessionId === B);
  app.handleKey({ name: "b" });
  app.handleKey({ name: "j" });
  assert.equal(app.current().sessionId, C);
  app.render();
  const Dp = app.layout().detail;
  const details = app.screen.buffer.slice(Dp.y, Dp.y + Dp.h).flatMap(row => row.filter(item => item.x >= Dp.x).map(item => item.text)).join("\n");
  assert.ok(details.includes("Parent session"));
  assert.ok(details.includes("11111111"));
  assert.ok(details.includes("Child branches · 1"));
  assert.ok(details.includes("44444444"));
  assert.ok(details.includes("turn 1") && details.includes("2026-10-12 09:00:00 UTC"));
  const before = app.relationLines(app.nodes(), C, app.layout().graph.w - 4);
  app.handleKey({ name: "T" }); app.render();
  assert.deepEqual(app.relationLines(app.nodes(), C, app.layout().graph.w - 4), before);
  assert.ok(!app.screen.out.frame.includes("2026-10-12"));
  app.handleKey({ name: "backspace" });
  assert.equal(app.relationView, false);
  assert.equal(app.current().sessionId, B);
});

test("same-name family sessions with colliding UUID prefixes get distinct stable short identifiers", t => {
  const env = fixture(t);
  const rootId = "019a1234-1111-4111-8111-11111111abcd";
  const childId = "019a1234-2222-4222-8222-22222222abcd";
  rollout(env, rootId, ["intro"]);
  rollout(env, childId, ["intro", "branch"], { parent: rootId, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time";
  app.selected = app.nodes().findIndex(row => row.sessionId === childId);
  app.handleKey({ name: "b" });
  const rootLabel = app.relationId(rootId), childLabel = app.relationId(childId);
  assert.notEqual(rootLabel, childLabel);
  assert.ok(rootLabel.includes("1abcd") && childLabel.includes("2abcd"));
  app.render();
  assert.ok(app.screen.out.frame.includes(rootLabel) && app.screen.out.frame.includes(childLabel));
  assert.ok(app.screen.out.frame.includes(childId), "the selection panel retains the full native identity");
  app.selected = 0;
  app.handleKey({ name: "h" });
  assert.equal(app.nodes().length, 1);
  assert.equal(app.relationId(rootId), rootLabel);
  app.handleKey({ name: "l" });
  assert.equal(app.relationId(childId), childLabel);
  app.handleKey({ name: "/" }); app.searchInput = childLabel; app.handleKey({ name: "enter" });
  assert.deepEqual(app.nodes().map(row => row.sessionId), [rootId, childId], "displayed identifiers remain searchable with their ancestor context");
});

test("compact family paging follows one session per row and keeps source details available on narrow screens", t => {
  const env = fixture(t);
  rollout(env, A, ["intro"]);
  const ids = Array.from({ length: 20 }, (_, i) => `${String(i + 10).padStart(8, "0")}-2222-4222-8222-222222222222`);
  for (const id of ids) rollout(env, id, ["intro", "branch"], { parent: A, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time";
  app.selected = app.nodes().findIndex(row => row.sessionId === A);
  app.handleKey({ name: "b" });
  app.screen.cols = 60; app.screen.rows = 16;
  const size = app.layout().graph.h - 1;
  app.handleKey({ name: "pagedown" });
  assert.equal(app.selected, size);
  app.render();
  assert.ok(app.screen.out.frame.includes("turn 1"));
  assert.ok(app.screen.out.frame.includes("2026-10-12 09:00:00 UTC"));
  assert.ok(app.screen.out.frame.includes("Backspace/Esc back"));
});

test("relationship pages fold a single child, search session names, and handle narrow terminals", t => {
  const env = fixture(t);
  rollout(env, A, ["intro"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "nested"], { parent: B, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time";
  app.selected = app.nodes().findIndex(row => row.sessionId === B);
  app.handleKey({ name: "b" });
  app.handleKey({ name: "h" }); app.handleKey({ name: "h" });
  assert.ok(!app.nodes().some(row => row.sessionId === C));
  app.handleKey({ name: "l" }); app.handleKey({ name: "l" });
  assert.ok(app.nodes().some(row => row.sessionId === C));
  app.handleKey({ name: "/" }); app.searchInput = C; app.handleKey({ name: "enter" });
  assert.deepEqual(app.nodes().map(row => row.sessionId), [A, B, C], "search retains the ancestor path");
  app.screen.cols = 60; app.screen.rows = 16;
  app.selected = 2;
  app.render();
  assert.ok(app.screen.out.frame.includes(C.slice(0, 8)));
  assert.ok(app.screen.out.frame.includes("Backspace/Esc back"));
});

test("unavailable parents and missing timestamps stay explicit without inventing activity times as fork times", t => {
  const env = fixture(t);
  const file = rollout(env, B, ["branch"], { parent: A });
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: store() });
  const rows = familyRows(graph, "codex", B);
  assert.equal(rows[0].sessionId, A);
  assert.ok(rows[0].missing);
  assert.equal(rows[1].parentId, rows[0].id);
  const app = appFor(graph, env);
  app.relationView = true; app.selected = 1;
  app.render();
  assert.ok(app.screen.out.frame.includes("parent not on disk"));
  assert.ok(app.screen.out.frame.includes("turn time not recorded"));
  app.selected = 0;
  app.handleKey({ name: "enter" });
  assert.match(app.message, /not on disk/);
  assert.equal(app.relationView, true);
  app.handleKey({ name: "n" });
  assert.match(app.message, /not on disk/);
  assert.equal(formatTime("not a date"), null);
  assert.equal(formatTime(null), null);
});

test("DST records without time fields show unknown source times instead of fabricated epoch dates", t => {
  const env = fixture(t);
  const file = write(path.join(env.DSH_HOME, "sessions/demo", A, "session.v4.jsonl"), [
    { type: "session", version: 4, id: A, cwd: "/work/demo" },
    { seq: 0, type: "user/message", data: { source: { kind: "user" }, content: "Untimed prompt" } },
  ]);
  write(path.join(env.DSH_HOME, "sessions/demo", B, "session.v4.jsonl"), [
    { type: "session", version: 4, id: B, cwd: "/work/demo", parentSession: A, isSeeded: true },
    { seq: 1, type: "session/end-seed", data: { inherited: true } },
  ]);
  assert.equal(dst.readMeta(file).timestamp, null);
  assert.equal(dst.parseTurns(file)[0].timestamp, null);
  const app = appFor(adapters.buildGraph({ adapter: dst, file, scope: "lineage", env, store: store() }), env);
  app.relationView = true; app.selected = 1;
  app.render();
  assert.ok(app.screen.out.frame.includes("turn 1"));
  assert.ok(app.screen.out.frame.includes("turn time not recorded"));
  assert.ok(!app.screen.out.frame.includes("1970"));
});

test("Claude assistant message fork anchors resolve to their human turn; independent roots stay independent", t => {
  const env = fixture(t);
  const first = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: A, cwd: "/work/demo", timestamp: "2026-10-12T09:00:00Z", message: { content: "First prompt" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-10-12T09:01:00Z", message: { content: "First answer" } },
  ];
  const file = write(path.join(env.CLAUDE_CONFIG_DIR, "projects/demo", `${A}.jsonl`), [...first,
    { type: "user", uuid: "u2", parentUuid: "a1", timestamp: "2026-10-12T09:02:00Z", message: { content: "Continue original" } }]);
  write(path.join(env.CLAUDE_CONFIG_DIR, "projects/demo", `${B}.jsonl`), [
    { type: "system", forkedFrom: { sessionId: A, messageUuid: "a1" } }, ...first,
    { type: "user", uuid: "b1", parentUuid: "a1", timestamp: "2026-10-12T09:03:00Z", message: { content: "Try branch" } }]);
  const graph = adapters.buildGraph({ adapter: claude, file, scope: "lineage", env, store: store() });
  const boundary = graph.nodes.find(n => n.sessionBoundary && n.sessionId === B);
  assert.equal(boundary.parentId, `claude:${A}#u1`);
  assert.equal(boundary.forkLocation, "message");
  assert.equal(graph.nodes.filter(n => n.key === "u1").length, 1);
  const independent = write(path.join(env.CLAUDE_CONFIG_DIR, "projects/demo", `${C}.jsonl`), [first[0],
    { type: "user", uuid: "u-independent", parentUuid: null, message: { content: "Independent root" } }]);
  const roots = adapters.buildGraph({ adapter: claude, file: independent, scope: "session", env, store: store() }).nodes;
  assert.ok(roots.every(n => n.parentId === null));
});

test("missing parents and cyclic fork metadata never hide sessions or produce dangling graph edges", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["a"], { parent: B });
  rollout(env, B, ["b"], { parent: A });
  rollout(env, C, ["c"], { parent: D });
  const graph = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: store() });
  assert.deepEqual(new Set(graph.nodes.map(n => n.sessionId)), new Set([A, B]));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const node of graph.nodes) {
    let cur = node;
    const seen = new Set();
    while (cur?.parentId) { assert.ok(!seen.has(cur.id)); seen.add(cur.id); cur = byId.get(cur.parentId); assert.ok(cur); }
  }
  const history = adapters.buildGraph({ scope: "all", env, registry: [codex], store: store() });
  const rows = catalogRows(history.nodes, { expanded: new Set([directoryKey("/work/demo")]) });
  assert.equal(rows.filter(n => n.sessionOnly).length, 3);
  assert.equal(new Set(rows.map(n => n.id)).size, rows.length);
  assert.equal(rows.find(n => n.sessionId === C).parentSessionId, D);
});

test("DST seed markers anchor forks at the inherited event cut", t => {
  const env = fixture(t);
  const first = [
    { seq: 0, time: 1000, type: "user/message", data: { source: { kind: "user" }, content: "Original prompt" } },
    { seq: 1, time: 1001, type: "assistant/message", data: { message: { content: "Original answer" } } },
  ];
  const file = write(path.join(env.DSH_HOME, "sessions/demo", A, "session.v4.jsonl"), [
    { type: "session", version: 4, id: A, cwd: "/work/demo", createdAt: 1000, isSeeded: false }, ...first,
    { seq: 2, time: 2000, type: "user/message", data: { source: { kind: "user" }, content: "Continue original" } },
  ]);
  const child = write(path.join(env.DSH_HOME, "sessions/demo", B, "session.v4.jsonl"), [
    { type: "session", version: 4, id: B, cwd: "/work/demo", createdAt: 3000, parentSession: A, isSeeded: true }, ...first,
    { seq: 2, time: 3000, type: "session/end-seed", data: { inherited: true } },
    { seq: 3, time: 3001, type: "user/message", data: { source: { kind: "user" }, content: "Try branch" } },
  ]);
  assert.equal(dst.readMeta(child).forkOrdinalExclusive, 2);
  const graph = adapters.buildGraph({ adapter: dst, file, scope: "lineage", env, store: store() });
  const boundary = graph.nodes.find(n => n.sessionBoundary && n.sessionId === B);
  assert.equal(boundary.parentId, `dst:${A}#0`);
  assert.equal(boundary.forkLocation, "ordinal");
  assert.equal(boundary.sharedTurns, 1);
  assert.equal(graph.nodes.filter(n => n.key === "0").length, 1);
});

test("large linear transcripts keep flat depth without overflowing the traversal stack", () => {
  const entry = { key: `codex:${A}`, agent: "codex", sessionId: A, meta: { cwd: "/work/demo" },
    turns: Array.from({ length: 12000 }, (_, index) => ({ key: String(index), prompt: `Turn ${index}` })) };
  const nodes = adapters.flatten(new Map([[entry.key, entry]]), entry, "session");
  assert.equal(nodes.length, 12000);
  assert.ok(nodes.every(n => n.depth === 0));
  assert.equal(nodes.at(-1).parentId, `codex:${A}#11998`);
});

test("family search selects the actual matching turn and highlights a deep full-text reply in the reader", t => {
  const env = fixture(t);
  rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time"; app.selected = app.nodes().findIndex(row => row.sessionId === B);
  app.handleKey({ name: "d" });
  const turn = app.graph.sessions.get(`codex:${B}`).turns.at(-1);
  turn.reply = "Short summary without the query";
  turn.replyFull = Array.from({ length: 80 }, (_, index) => index === 60 ? "中文 Unique.Needle end" : `Ordinary reply line ${index}`).join("\n");
  app._contentFor = null;
  app.handleKey({ name: "/" }); app.searchInput = "unique.needle"; app.handleKey({ name: "enter" });
  assert.equal(app.current().key, "branch", "ancestor context must not steal the selection");
  assert.ok(app.nodes().some(row => row.sessionId === A));
  app.render();
  assert.ok(app.scroll > 40, "reader jumps to the actual matching answer");
  const Dp = app.layout().detail;
  const highlights = app.screen.buffer.flat().filter(item => item.style?.bg === "yellow" && item.text === "Unique.Needle");
  assert.ok(highlights.some(item => item.x < Dp.x), "tree uses a highlighted match excerpt");
  assert.ok(highlights.some(item => item.x > Dp.x), "answer contains the highlighted hit");
  const first = app.scroll;
  app.handleKey({ name: "tab" }); app.render(); assert.equal(app.scroll, first);
  app.handleKey({ name: "down" }); app.render(); assert.equal(app.scroll, first + 1);
  app.handleKey({ name: "up" }); app.render(); assert.equal(app.scroll, first);
  app.handleKey({ name: "home" }); app.render(); assert.equal(app.scroll, 0, "manual scroll is not forced back to the match");
  app.handleKey({ name: "tab" }); app.render(); assert.equal(app.scroll, 0);
});

test("ordinary conversation search covers full text and history search skips directory headings", t => {
  const env = fixture(t);
  const file = rollout(env, A, ["intro", "main"]);
  const app = appFor(adapters.buildGraph({ adapter: codex, file, scope: "session", env, store: store() }), env);
  const target = app.graph.nodes.at(-1);
  target.replyFull = "tail-only-match"; target.reply = "summary";
  app.handleKey({ name: "/" }); app.searchInput = "tail-only-match"; app.handleKey({ name: "enter" });
  assert.equal(app.current().id, target.id);
  app.render();
  assert.ok(app.screen.buffer.flat().some(item => item.style?.bg === "yellow" && item.text === "tail-only-match"));
  app.handleKey({ name: "s" });
  app.handleKey({ name: "/" }); app.searchInput = A; app.handleKey({ name: "enter" });
  assert.equal(app.current().sessionId, A);
  assert.equal(app.current().directoryOnly, undefined);
});

test("a family search submitted before transcripts arrive selects and displays the later real hit", t => {
  const env = fixture(t);
  const a = rollout(env, A, ["intro"]);
  const b = rollout(env, B, ["intro", "late-match"], { parent: A, ordinal: 5 });
  const graph = adapters.buildGraph({ scope: "all", adapter: codex, sessionId: B, env, store: store() });
  graph.scope = "lineage";
  const app = appFor(graph, env);
  app.relationView = app.familyDetail = true;
  app.loader = { send() {} }; app.loadId = 7;
  app.handleKey({ name: "/" }); app.searchInput = "late-match"; app.handleKey({ name: "enter" });
  assert.equal(app.nodes().length, 0);
  app.backgroundMessage({ type: "transcript", id: 7, key: `codex:${A}`, turns: codex.parseTurns(a) });
  app.backgroundMessage({ type: "transcript", id: 7, key: `codex:${B}`, turns: codex.parseTurns(b) });
  assert.equal(app.current().key, "late-match");
  assert.equal(app.searchSelectionPending, false);
  app.render();
  const Dp = app.layout().detail;
  assert.ok(app.screen.buffer.flat().some(item => item.x > Dp.x && item.style?.bg === "yellow" && item.text === "late-match"));
});

test("compact Family content can focus and scroll on narrow screens without losing its position", t => {
  const env = fixture(t);
  rollout(env, A, Array.from({ length: 30 }, (_, i) => `prompt-${i}`));
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time"; app.handleKey({ name: "f" });
  app.screen.cols = 80; app.screen.rows = 20;
  app.handleKey({ name: "tab" }); app.render();
  assert.equal(app.focus, "detail");
  assert.equal(app.layout().detail.w, 80);
  assert.ok(app.screen.out.frame.includes("Content [focused]"));
  app.handleKey({ name: "pagedown" }); app.render(); assert.equal(app.scroll, 10);
  app.handleKey({ name: "down" }); app.render(); assert.equal(app.scroll, 11);
  app.handleKey({ name: "up" }); app.render(); assert.equal(app.scroll, 10);
  app.handleKey({ name: "tab" }); app.render();
  app.handleKey({ name: "tab" }); app.render();
  assert.equal(app.scroll, 10, "a temporary return to the tree must preserve the reader offset");
});

test("f opens Family without forking; d shows actual branch turns and replies with preserved numbering", t => {
  const env = fixture(t);
  rollout(env, A, ["intro", "main", "finish"]);
  rollout(env, B, ["intro", "main", "branch"], { parent: A, ordinal: 9 });
  rollout(env, C, ["intro", "sibling"], { parent: A, ordinal: 5 });
  rollout(env, D, ["intro", "main", "branch", "nested"], { parent: B, ordinal: 13 });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time"; app.selected = app.nodes().findIndex(row => row.sessionId === B);
  let forks = 0; app.forkSession = async () => { forks++; };
  app.handleKey({ name: "f" });
  assert.equal(app.relationView, true); assert.equal(forks, 0);
  app.render();
  assert.ok(app.screen.out.frame.includes("Prompt branch"), "the structure sidebar includes actual conversation history");
  app.handleKey({ name: "d" });
  assert.equal(app.familyDetail, true);
  const rows = app.nodes(), branch = rows.find(row => row.sessionId === B && row.key === "branch");
  assert.equal(branch.turnNumber, 3);
  assert.equal(rows.filter(row => row.key === "intro").length, 1);
  assert.equal(rows.find(row => row.sessionId === B && row.sessionBoundary).parentId, `codex:${A}#main`);
  assert.equal(rows.find(row => row.sessionId === D && row.sessionBoundary).parentId, branch.id);
  app.selected = rows.indexOf(branch); app.render();
  assert.ok(app.screen.out.frame.includes("Prompt branch"));
  assert.ok(app.screen.out.frame.includes("Reply branch"), "selected turn displays its full answer");
  app.handleKey({ name: "enter" }); assert.equal(app.focus, "detail");
  app.screen.cols = 60; app.render();
  assert.ok(app.screen.out.frame.includes("Reply branch"), "narrow terminals can read the full answer");
  app.handleKey({ name: "tab" }); assert.equal(app.focus, "graph");
  assert.equal(app.current().id, branch.id);
  app.screen.cols = 118;
  const depth = app.navigationStack.length;
  app.handleKey({ name: "f" }); assert.equal(app.navigationStack.length, depth);
  app.handleKey({ name: "T" }); app.render();
  assert.ok(!app.screen.out.frame.includes("2026-10-12"));
  app.handleKey({ name: "d" }); assert.equal(app.current().sessionId, B);
  assert.ok(app.nodes().every(row => row.sessionBoundary));
  app.handleKey({ name: "d" });
  app.handleKey({ name: "/" }); app.searchInput = "Prompt nested"; app.handleKey({ name: "enter" });
  assert.ok(app.nodes().some(row => row.sessionId === D && row.key === "nested"));
  assert.ok(app.nodes().some(row => row.sessionId === B && row.sessionBoundary));
  app.handleKey({ name: "backspace" });
  assert.equal(app.scope, "all"); assert.equal(app.current().sessionId, B);
});

test("detailed family folds real fork subtrees and restores its view when returning from a conversation", t => {
  const env = fixture(t);
  rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  const app = appFor(adapters.buildGraph({ scope: "all", env, store: store() }), env);
  app.historyView = "time"; app.selected = app.nodes().findIndex(row => row.sessionId === B);
  app.handleKey({ name: "d" });
  assert.equal(app.familyDetail, true);
  app.handleKey({ name: "h" });
  assert.ok(!app.nodes().some(row => row.sessionId === B && row.key === "branch"));
  app.handleKey({ name: "l" });
  assert.ok(app.nodes().some(row => row.sessionId === B && row.key === "branch"));
  app.handleKey({ name: "enter" }); assert.equal(app.scope, "session");
  app.handleKey({ name: "backspace" });
  assert.equal(app.familyDetail, true); assert.equal(app.relationView, true);
  assert.equal(app.current().sessionId, B);
});

test("background loading publishes the caller before directory history and resolves every family edge lazily", async t => {
  const env = fixture(t);
  env.HERDR_PLUGIN_STATE_DIR = path.join(env.CODEX_HOME, "cache");
  env.HERDR_BIN_PATH = path.join(env.CODEX_HOME, "no-herdr");
  const file = rollout(env, A, ["intro", "main"]);
  rollout(env, B, ["intro", "branch"], { parent: A, ordinal: 5 });
  rollout(env, C, ["intro", "main", "nested"], { parent: B, ordinal: 9, cwd: "/work/other" });
  const messages = [], waiters = [];
  const loader = new Loader(env, message => {
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  t.after(() => loader.close());
  const wait = match => {
    const existing = messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => reject(new Error(`Loader timeout: ${JSON.stringify(messages.map(m => [m.type, m.error]))}`)), 10000) };
      waiters.push(waiter);
    });
  };
  loader.send({ type: "start", id: 1, scope: "session", callerId: "test:p1", cwd: "/work/demo",
    pane: { pane_id: "test:p1", cwd: "/work/demo", agent: "codex", agent_session: { agent: "codex", value: A } } });
  const first = await wait(m => m.type === "page" && m.id === 1);
  assert.equal(first.graph.nodes.length, 2);
  assert.equal(first.graph.sessionMeta.size, 1, "the first conversation does not wait for a global metadata scan");
  await wait(m => m.type === "catalog" && m.complete);
  assert.ok(messages.findIndex(m => m.type === "page") < messages.findIndex(m => m.type === "catalog"));
  const history = messages.filter(m => m.type === "catalog").flatMap(m => m.entries);
  assert.deepEqual(new Set(history.slice(0, 2).map(m => m.sessionId)), new Set([A, B]));
  assert.equal(history.at(-1).sessionId, C, "other directories appear after the caller's directory");
  loader.send({ type: "page", id: 2, scope: "lineage", family: true, session: { agent: "codex", value: B } });
  const family = (await wait(m => m.type === "page" && m.id === 2)).graph;
  assert.ok([...family.sessions.values()].every(entry => !entry.loaded), "family structure is delivered before transcript parsing");
  loader.send({ type: "details", id: 2, rows: familyRows(family, "codex", B), includeTurns: true });
  const edgeB = await wait(m => m.type === "edge" && m.key === `codex:${B}`);
  const edgeC = await wait(m => m.type === "edge" && m.key === `codex:${C}`);
  assert.equal(edgeB.info.number, 1);
  assert.equal(edgeC.info.number, 2, "nested forks count turns in their direct parent");
  assert.equal(edgeC.info.turn.prompt, "Prompt branch");
  const transcript = await wait(m => m.type === "transcript" && m.key === `codex:${C}`);
  assert.equal(transcript.turns.at(-1).prompt, "Prompt nested");
  assert.equal(transcript.turns.at(-1).replyFull, "Reply nested");
  assert.ok(!messages.some(m => m.type === "error"), JSON.stringify(messages.filter(m => m.type === "error")));
  assert.equal(codex.parseTurns(file).length, 2, "browsing leaves the native transcript intact");
});

test("late background results cannot replace a restored page or move its selection", t => {
  const env = fixture(t);
  rollout(env, A, ["intro"]); rollout(env, B, ["branch"]);
  const graph = adapters.buildGraph({ scope: "all", env, store: store() });
  const app = appFor(graph, env), sent = [];
  app.historyView = "time"; app.selected = app.nodes().findIndex(row => row.sessionId === B);
  app.loader = { send: message => sent.push(message) };
  app.handleKey({ name: "enter" });
  const pendingId = app.loadId;
  assert.equal(app.graph, null);
  app.handleKey({ name: "backspace" });
  assert.equal(app.graph, graph);
  app.backgroundMessage({ type: "page", id: pendingId, scope: "session", graph: { nodes: [] } });
  app.backgroundMessage({ type: "edge", id: pendingId, key: `codex:${B}`, info: { number: 999 } });
  app.backgroundMessage({ type: "transcript", id: pendingId, key: `codex:${B}`, turns: [{ key: "stale" }] });
  assert.equal(app.graph, graph);
  assert.equal(app.current().sessionId, B);
  assert.equal(app.graph.edges, undefined);
  assert.equal(app.graph.familyTurns, undefined);
  const meta = [...graph.sessionMeta.values()].map(({ adapter, ...entry }) => entry);
  app.backgroundMessage({ type: "catalog", entries: meta, complete: true });
  assert.equal(app.current().sessionId, B, "catalog updates preserve selection by ID");
  assert.ok(sent.some(m => m.type === "cancel"));
});

test("paging and focus keys agree across history, conversation, narrow terminals and input modes", t => {
  const env = fixture(t);
  const file = rollout(env, A, Array.from({ length: 50 }, (_, i) => `turn-${i}`));
  const app = appFor(adapters.buildGraph({ adapter: codex, file, scope: "session", env, store: store() }), env);
  app.selected = 0;
  app.handleKey({ name: "pagedown" });
  assert.equal(app.selected, app.layout().graph.h - 1);
  app.handleKey({ name: "pageup" }); assert.equal(app.selected, 0);
  app.current().replyFull = Array.from({ length: 100 }, (_, i) => `Reply ${i}`).join("\n");
  app.handleKey({ name: "shift-tab" }); assert.equal(app.focus, "detail");
  app.handleKey({ name: "end" }); app.render();
  assert.equal(app.selected, 0); assert.ok(app.scroll > 50);
  app.handleKey({ name: "home" }); assert.equal(app.scroll, 0);
  app.screen.cols = 60; app.render(); assert.equal(app.focus, "graph");
  app.handleKey({ name: "tab" }); assert.equal(app.focus, "graph");
  app.screen.rows = 16;
  app.handleKey({ name: "?" }); app.handleKey({ name: "pagedown" }); app.render();
  assert.ok(app.helpTop > 0);
  app.handleKey({ name: "escape" });
  app.handleKey({ name: "/" }); app.searchInput = "some query";
  app.handleKey({ name: "ctrl-u" }); assert.equal(app.searchInput, "");
  let closed = false; app.quit = () => { closed = true; };
  app.handleKey({ name: "ctrl-c" }); assert.equal(closed, true);
});

test("streamed transcript records preserve Chinese text and emoji across the read-buffer boundary", t => {
  const env = fixture(t), chunkSize = 1024 * 1024;
  const prefix = '{"value":"', padding = "x".repeat(chunkSize - Buffer.byteLength(prefix) - 1);
  const file = path.join(env.CODEX_HOME, "unicode.jsonl");
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(file, `${prefix}${padding}中🙂文"}\n`);
  const rows = []; codex.eachRecord(file, row => rows.push(row));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, padding + "中🙂文");
});

test("the interactive app paints before loading and exits without waiting for cache writes", async t => {
  const env = fixture(t);
  env.HERDR_PLUGIN_STATE_DIR = path.join(env.CODEX_HOME, "cache");
  env.HERDR_BIN_PATH = path.join(env.CODEX_HOME, "no-herdr");
  rollout(env, A, ["intro"]);
  const code = `
    const { App } = require('./src/graph');
    const app = new App({ store: { flush() { throw new Error('UI thread must not flush on exit'); } } });
    let painted = false;
    app.screen.input = Object.assign(new (require('node:events').EventEmitter)(), { isTTY: true });
    app.screen.start = function () { this.active = true; };
    app.screen.stop = function () { this.active = false; process.send({ stopped: true }); };
    app.screen.out = { write() { if (!painted) { painted = true; process.send({ painted: true, hasLoader: !!app.loader }); } } };
    process.on('message', () => app.handleKey({ name: 'q' }));
    app.run();
  `;
  const child = spawn(process.execPath, ["-e", code], { cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env, SESSION_GRAPH_CALLER: "", HERDR_PANE_ID: "", HERDR_PLUGIN_CONTEXT_JSON: "{}" },
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let error = "", first, stopped = false;
  child.stderr.on("data", data => { error += data; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Interactive close timed out")); }, 5000);
    child.on("message", message => {
      if (message.painted) { first = message; child.send("quit"); }
      if (message.stopped) stopped = true;
    });
    child.on("error", reject);
    child.on("exit", code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(result, 0, error);
  assert.equal(first?.hasLoader, false, "the loading frame is painted before worker startup");
  assert.equal(stopped, true, "the terminal is restored during close");
});
