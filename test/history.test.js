"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { EventEmitter } = require("node:events");
const { App } = require("../src/graph");
const adapters = require("../src/adapters");
const codex = require("../src/adapters/codex");
const claude = require("../src/adapters/claude");
const dst = require("../src/adapters/dst");
const native = require("../src/native");
const { rememberSessionRoots, sessionEnv } = require("../src/paths");
const { parseKeys } = require("../src/ui");
const { directoryKey, filterSessions, catalogRows } = require("../src/catalog");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "session-graph-history-"));
  t.after(() => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith("session-graph-history-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const env = { ...process.env, HOME: root, USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), DSH_HOME: path.join(root, "dsh"),
    HERDR_PLUGIN_CONFIG_DIR: path.join(root, "plugin-config"), HERDR_PLUGIN_STATE_DIR: path.join(root, "plugin-state") };
  return { root, env };
}

function write(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(o => JSON.stringify(o)).join("\n") + "\n");
  return file;
}

function rollout(env, id, { archived = false, parent = null, cwd = "demo", prompt = "Human prompt" } = {}) {
  return write(path.join(env.CODEX_HOME, archived ? "archived_sessions" : "sessions/2026/10/12", `rollout-2026-10-12T00-00-00-${id}.jsonl`), [
    { type: "session_meta", payload: { id, timestamp: "2026-10-12T00:00:00Z", cwd, source: "cli", originator: "codex_cli_rs",
      cli_version: "0.162.1", model_provider: "openai", forked_from_id: parent } },
    { type: "event_msg", ordinal: 1, payload: { type: "task_started", turn_id: `turn-${id}` } },
    { type: "event_msg", ordinal: 2, payload: { type: "user_message", message: prompt } },
    { type: "event_msg", ordinal: 3, payload: { type: "agent_message", message: "Assistant reply" } },
    { type: "event_msg", ordinal: 4, payload: { type: "task_complete" } },
  ].map(row => ({ timestamp: "2026-10-12T00:00:00.000Z", ...row })));
}

function memoryStore() { return { get: () => null, put() {}, flush() {} }; }
class Output extends EventEmitter {
  constructor() { super(); this.columns = 118; this.rows = 30; this.frames = []; }
  write(frame) { this.frames.push(frame); }
}

function appFor(env, pane = null, options = {}) {
  const app = new App({ env, store: memoryStore(), historyView: "time", herdr: { paneList: () => [] }, ...options });
  app.callerPane = () => pane;
  app.screen.out = new Output();
  app.screen.cols = 118; app.screen.rows = 30;
  app.load();
  return app;
}

test("history includes unrelated and archived Codex sessions without parsing their turns", t => {
  const { env } = fixture(t);
  rollout(env, A);
  rollout(env, B, { archived: true });
  write(path.join(env.CODEX_HOME, "session_index.jsonl"), [{ id: A, thread_name: "中文项目名称" }]);
  let parses = 0;
  const registry = [{ ...codex, parseTurns: () => { parses++; assert.fail("catalog must not parse bodies"); } }];
  const graph = adapters.buildGraph({ scope: "all", env, registry, store: memoryStore() });
  assert.deepEqual(new Set(graph.nodes.map(n => n.sessionId)), new Set([A, B]));
  assert.equal(graph.nodes.find(n => n.sessionId === A).title, "中文项目名称");
  assert.equal(graph.nodes.find(n => n.sessionId === B).archived, true);
  assert.ok(graph.nodes.every(n => n.sessionOnly));
  assert.equal(parses, 0);
});

test("missing or unknown pane session id falls back to browsable, searchable history", t => {
  const { env } = fixture(t);
  rollout(env, A, { cwd: "project-alpha", prompt: "Fix alpha history" });
  rollout(env, B, { cwd: "project-beta", prompt: "Fix beta history" });
  for (const pane of [null, { agent: "codex", cwd: "project-alpha" },
    { agent_session: { agent: "codex", value: C }, cwd: "project-alpha" }]) {
    const app = appFor(env, pane);
    assert.equal(app.scope, "all");
    assert.equal(app.nodes().length, 2);
    if (pane) assert.equal(app.current().sessionId, A);
    else assert.ok([A, B].includes(app.current().sessionId));
    app.search = "project-beta"; app.selected = 0;
    assert.equal(app.current().sessionId, B);
    app.handleKey({ name: "enter" });
    assert.equal(app.scope, "session");
    assert.equal(app.graph.focusSessionId, B);
    assert.equal(app.current().promptFull, "Fix beta history");
    app.handleKey({ name: "s" });
    assert.equal(app.nodes().length, 2);
    assert.equal(app.scope, "all");
  }
});

test("lineage renders ancestor turns when opened from a child session", t => {
  const { env } = fixture(t);
  rollout(env, A);
  const child = rollout(env, B, { parent: A });
  const graph = adapters.buildGraph({ adapter: codex, file: child, scope: "lineage", env, store: memoryStore() });
  assert.deepEqual(new Set(graph.nodes.map(n => n.sessionId)), new Set([A, B]));
  assert.equal(graph.nodes[0].sessionId, A);
  assert.equal(graph.focusSessionId, B);
});

test("installer remembers non-default agent roots for a Herdr server started without those variables", t => {
  const { env } = fixture(t);
  const target = rememberSessionRoots(env);
  assert.ok(fs.existsSync(target));
  const inherited = { ...env };
  delete inherited.CODEX_HOME; delete inherited.CLAUDE_CONFIG_DIR; delete inherited.DSH_HOME;
  assert.equal(sessionEnv(inherited).CODEX_HOME, env.CODEX_HOME);
  assert.equal(sessionEnv({ ...inherited, CODEX_HOME: "explicit" }).CODEX_HOME, "explicit");
  rollout(env, A);
  assert.equal(codex.listSessions(inherited)[0].sessionId, A);
});

test("invalid saved roots do not block history, and a conflicting temporary file is preserved", t => {
  const { env } = fixture(t);
  const target = rememberSessionRoots(env);
  rollout(env, A);
  for (const value of ["null", "[]", '"wrong shape"', "{invalid JSON"]) {
    fs.writeFileSync(target, value);
    assert.equal(codex.listSessions(env)[0].sessionId, A);
  }
  const staged = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(staged, "another write");
  assert.throws(() => rememberSessionRoots(env), { code: "EEXIST" });
  assert.equal(fs.readFileSync(staged, "utf8"), "another write");
});

test("malformed caches are rebuilt and benchmarks leave the plugin cache unchanged", t => {
  const { env } = fixture(t);
  const file = rollout(env, A);
  const { makeStore, cacheFile, cachedParse } = require("../src/store");
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = env.HERDR_PLUGIN_STATE_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previous;
  });
  fs.mkdirSync(env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
  for (const value of ["null", '{"entries":true}', '{"entries":[]}', '{"entries":"invalid"}']) {
    fs.writeFileSync(cacheFile(), value);
    const store = makeStore();
    assert.equal(cachedParse(codex, file, store).length, 1);
    store.flush();
    assert.equal(makeStore().get("codex", file).length, 1);
  }
  const original = fs.readFileSync(cacheFile());
  const before = fs.readdirSync(env.HERDR_PLUGIN_STATE_DIR);
  const result = require("node:child_process").spawnSync(process.execPath, [path.join(__dirname, "bench.js")], {
    env, encoding: "utf8", windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cache 0 hit \/ 1 miss/);
  assert.match(result.stdout, /cache 1 hit \/ 0 miss/);
  assert.deepEqual(fs.readFileSync(cacheFile()), original);
  assert.deepEqual(fs.readdirSync(env.HERDR_PLUGIN_STATE_DIR), before);
});

test("rename UI captures the selected session, persists once, supports cancel and Unicode deletion", async t => {
  const { env } = fixture(t);
  rollout(env, A); rollout(env, B);
  const saved = [];
  const app = appFor(env, null, { renameSession: async (session, title) => { saved.push({ session, title }); return title; } });
  app.selected = app.nodes().findIndex(n => n.sessionId === B);
  app.handleKey({ name: "R" });
  app.renameInput = "会话🙂";
  app.handleKey({ name: "backspace" });
  assert.equal(app.renameInput, "会话");
  app.handleKey({ name: "escape" });
  assert.equal(saved.length, 0);
  app.handleKey({ name: "R" });
  app.handleKey({ name: "ctrl-u" });
  for (const key of parseKeys("历史会话新名称🙂")) app.handleKey(key);
  app.handleKey({ name: "backspace" });
  await app.handleKey({ name: "enter" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].session.sessionId, B);
  assert.equal(app.graph.nodes.find(n => n.sessionId === B).title, "历史会话新名称");
  assert.notEqual(app.graph.nodes.find(n => n.sessionId === A).title, "历史会话新名称");
});

test("rename failures are visible and do not show an unpersisted name", async t => {
  const { env } = fixture(t);
  rollout(env, A);
  const app = appFor(env, null, { renameSession: async () => { throw new Error("session locked"); } });
  const previous = app.current().title;
  app.handleKey({ name: "R" }); app.renameInput = "new name";
  await app.handleKey({ name: "enter" });
  app.render();
  assert.equal(app.current().title, previous);
  assert.equal(app.mode, "rename");
  assert.ok(app.screen.out.frames.at(-1).includes("session locked"));
});

function catalogApp(options = {}) {
  const nodes = [
    { id: `codex:${A}#session`, sessionId: A, agent: "codex", cwd: "D:\\Code\\alpha", title: "Alpha history", timestamp: "2026-10-10T12:00:00Z" },
    { id: `claude:${B}#session`, sessionId: B, agent: "claude", cwd: "d:\\code\\ALPHA\\", title: "Alpha review", timestamp: "2026-10-12T12:00:00Z" },
    { id: `dst:${C}#session`, sessionId: C, agent: "dst", cwd: "/work/beta", title: "Beta history", timestamp: "2026-10-11T12:00:00Z" },
  ].map((n, index) => ({ ...n, index, prompt: n.title, reply: n.cwd, sessionOnly: true, depth: 0 }));
  const commands = [];
  const app = new App({ scope: "all", store: memoryStore(),
    herdr: { paneList: () => [], runInPane: (...args) => commands.push(args), focusPane: () => {},
      splitPane: () => assert.fail("must not split"), startAgent: () => assert.fail("must not start an agent") },
    ...options });
  app.graph = { nodes };
  app.callerPane = () => ({ pane_id: "caller:1", agent: "codex", agent_status: "idle" });
  app.quit = () => { app.closed = true; };
  app.screen.out = new Output();
  app.screen.cols = 118; app.screen.rows = 30;
  return { app, nodes, commands };
}

test("directories normalize Windows separators and case without merging distinct Unix paths", () => {
  assert.equal(directoryKey("D:/Code/alpha/"), directoryKey("d:\\code\\ALPHA"));
  assert.equal(directoryKey("\\\\server\\share\\alpha\\"), directoryKey("\\\\SERVER\\SHARE\\alpha"));
  assert.notEqual(directoryKey("/work/Alpha"), directoryKey("/work/alpha"));
  assert.equal(directoryKey("/"), "/");
  assert.equal(directoryKey(null), "");
});

test("history defaults to collapsed directory groups; folder keys are idempotent and protected from rename", () => {
  const { app } = catalogApp();
  assert.equal(app.historyView, "directory");
  assert.equal(app.nodes().length, 2);
  assert.ok(app.nodes().every(n => n.directoryOnly));
  assert.equal(app.current().sessionCount, 2);
  app.handleKey({ name: "R" });
  assert.equal(app.mode, "browse");
  assert.match(app.message, /Select a session/);
  app.handleKey({ name: "l" });
  assert.equal(app.nodes().length, 4);
  app.handleKey({ name: "l" });
  assert.equal(app.nodes().length, 4);
  app.handleKey({ name: "h" });
  app.handleKey({ name: "h" });
  assert.equal(app.nodes().length, 2);
  app.handleKey({ name: "enter" });
  assert.equal(app.nodes().length, 4);
  assert.equal(app.scope, "all");
});

test("initial history expands and selects only the caller's directory", t => {
  const { env } = fixture(t);
  rollout(env, A, { cwd: "D:\\Code\\alpha" });
  rollout(env, B, { cwd: "D:\\Code\\beta" });
  const app = appFor(env, { cwd: "D:\\Code\\alpha", agent: "codex" }, { historyView: "directory" });
  assert.equal(app.nodes().length, 3);
  assert.equal(app.current().sessionId, A);
  assert.equal(app.nodes().filter(n => n.directoryOnly && n.expanded).length, 1);
});

test("time view sorts both ways; directory order follows latest activity and retains session selection", () => {
  const { app, nodes } = catalogApp();
  assert.equal(app.nodes()[0].directoryKey, directoryKey(nodes[0].cwd));
  app.handleKey({ name: "v" });
  assert.deepEqual(app.nodes().map(n => n.sessionId), [B, C, A]);
  app.selected = 1;
  app.handleKey({ name: "o" });
  assert.deepEqual(app.nodes().map(n => n.sessionId), [A, C, B]);
  assert.equal(app.current().sessionId, C);
  app.handleKey({ name: "v" });
  assert.equal(app.nodes()[0].directoryKey, "/work/beta");
  assert.equal(app.current().sessionId, C);
});

test("agent filter cycles all supported agents and composes with search, sorting and view changes", () => {
  const { app } = catalogApp();
  const expected = [["codex", A], ["claude", B], ["dst", C]];
  for (const [agent, id] of expected) {
    app.handleKey({ name: "a" });
    assert.equal(app.agentFilter, agent);
    assert.deepEqual(app.historySessions().map(n => n.sessionId), [id]);
  }
  app.handleKey({ name: "a" });
  assert.equal(app.agentFilter, "all");
  app.search = "alpha";
  app.handleKey({ name: "a" });
  app.handleKey({ name: "v" });
  app.handleKey({ name: "o" });
  assert.deepEqual(app.nodes().map(n => n.sessionId), [A]);
  app.handleKey({ name: "a" });
  assert.equal(app.current().sessionId, B);
  app.handleKey({ name: "a" });
  assert.equal(app.nodes().length, 0);
  assert.equal(app.selected, 0);
  app.render();
  assert.ok(app.screen.out.frames.at(-1).includes("0 sessions / 0 dirs"));
});

test("search opens matching directories and shows session totals independent of collapsed rows", () => {
  const { app } = catalogApp();
  app.handleKey({ name: "/" });
  app.searchInput = "alpha review";
  app.handleKey({ name: "enter" });
  assert.equal(app.nodes().length, 2);
  assert.equal(app.nodes()[1].sessionId, B);
  assert.equal(app.current().sessionId, B, "search selects the actual result rather than its directory");
  app.handleKey({ name: "home" });
  app.handleKey({ name: "h" });
  assert.equal(app.nodes().length, 1);
  app.render();
  assert.ok(app.screen.out.frames.at(-1).includes("1 sessions / 1 dirs"));
  const filtered = filterSessions(app.graph.nodes, { agent: "claude", search: "ALPHA" });
  assert.equal(filtered.length, 1);
  assert.equal(catalogRows(filtered, { view: "time" })[0].sessionId, B);
});

test("linear conversation rows have one space between the dot and text", () => {
  const { app, nodes } = catalogApp();
  app.scope = "session";
  app.graph.nodes = [{ ...nodes[0], sessionOnly: false, prompt: "Compact prompt", promptFull: "Compact prompt", branchCount: 1 }];
  app.render();
  const row = app.screen.buffer[2];
  assert.equal(row.find(item => item.text === "○").x, 1);
  assert.equal(row.find(item => item.text === "Compact prompt").x, 3);
});

test("resume refuses directories, missing callers, busy agents, mismatched agents and duplicate writers", () => {
  const { app, commands } = catalogApp({ historyView: "time" });
  const invalid = [
    [null, /Open the graph/],
    [{ pane_id: "caller:1", agent: "codex", agent_status: "working" }, /must be idle/],
    [{ pane_id: "caller:1", agent: "claude", agent_status: "idle" }, /Codex pane/],
  ];
  app.selected = app.nodes().findIndex(n => n.sessionId === A);
  for (const [pane, reason] of invalid) {
    app.callerPane = () => pane;
    app.handleKey({ name: "n" });
    assert.match(app.message, reason);
  }
  app.callerPane = () => ({ pane_id: "caller:1", agent: "codex", agent_status: "idle" });
  app.herdr.paneList = () => [{ pane_id: "other:1", agent_session: { value: A } }];
  app.handleKey({ name: "n" });
  assert.match(app.message, /another pane/);
  app.historyView = "directory";
  app.selected = 0;
  app.handleKey({ name: "n" });
  assert.match(app.message, /Select a session/);
  assert.deepEqual(commands, []);
});

test("fork failure and caller changes leave the current pane untouched and expose a saved child's ID", async () => {
  const { app, commands } = catalogApp({ historyView: "time", forkSession: async () => { throw new Error("native failure"); } });
  app.selected = app.nodes().findIndex(n => n.sessionId === A);
  await app.handleKey({ name: "F" });
  assert.match(app.message, /native failure/);
  assert.equal(app.mode, "browse");
  app.forkSession = async () => { app.callerPane = () => ({ pane_id: "caller:1", agent: "codex", agent_status: "working" }); return B; };
  await app.handleKey({ name: "F" });
  assert.match(app.message, /Saved fork: 22222222/);
  assert.deepEqual(commands, []);
});

test("Claude resumes by ID and branches only its current native session; DST opens its native picker", async () => {
  const { app, commands } = catalogApp({ historyView: "time" });
  app.selected = app.nodes().findIndex(n => n.sessionId === B);
  app.callerPane = () => ({ pane_id: "caller:1", agent: "claude", agent_status: "idle", agent_session: { value: A, agent: "claude" } });
  app.handleKey({ name: "n" });
  assert.deepEqual(commands.pop(), ["caller:1", `/resume ${B}`]);
  await app.handleKey({ name: "F" });
  assert.match(app.message, /Resume this Claude session first/);
  app.callerPane = () => ({ pane_id: "caller:1", agent: "claude", agent_status: "idle", agent_session: { value: B, agent: "claude" } });
  await app.handleKey({ name: "F" });
  assert.deepEqual(commands.pop(), ["caller:1", "/branch"]);
  app.selected = app.nodes().findIndex(n => n.sessionId === C);
  app.callerPane = () => ({ pane_id: "caller:1", agent: "dsh-tui", agent_status: "idle" });
  app.handleKey({ name: "n" });
  assert.deepEqual(commands.pop(), ["caller:1", "/resume"]);
  await app.handleKey({ name: "F" });
  assert.match(app.message, /native session menu/);
  assert.deepEqual(commands, []);
});

test("Claude rename appends native metadata and writes its native sidecar without replacing messages", async t => {
  const { env } = fixture(t);
  const file = write(path.join(env.CLAUDE_CONFIG_DIR, "projects/demo", `${A}.jsonl`), [
    { type: "user", uuid: "user-1", sessionId: A, cwd: "demo", message: { content: "Original prompt" } },
    { type: "assistant", uuid: "reply-1", parentUuid: "user-1", message: { content: "Original answer" } },
  ]);
  const before = fs.readFileSync(file, "utf8");
  const oldTurns = claude.parseTurns(file);
  await native.renameSession({ agent: "claude", sessionId: A, file }, "新会话名称", { env });
  assert.ok(fs.readFileSync(file, "utf8").startsWith(before));
  assert.equal(claude.readMeta(file).title, "新会话名称");
  assert.deepEqual(claude.parseTurns(file), oldTurns);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file), A, "custom-title.json"), "utf8")).customTitle, "新会话名称");
  await assert.rejects(native.renameSession({ agent: "claude", sessionId: B, file }, "wrong", { env }), /identity mismatch/);
});

test("Codex rename uses only the native metadata method; invalid titles do not dispatch", async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return {}; };
  await native.renameSession({ agent: "codex", sessionId: A }, "  新名称  ", { request });
  assert.equal(calls[0][0], "thread/name/set");
  assert.deepEqual(calls[0][1], { threadId: A, name: "新名称" });
  await assert.rejects(native.renameSession({ agent: "codex", sessionId: A }, " ", { request }), /empty/);
  assert.equal(calls.length, 1);
  await assert.rejects(native.renameSession({ agent: "unknown", sessionId: A }, "name"), /not supported/);
});

const hasZstd = typeof zlib.zstdCompressSync === "function";
function dstFile(env, id, title = "Original DST name") {
  const file = path.join(env.DSH_HOME, "sessions/demo", id, "session.v4.jsonl.zstd");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = { type: "session", version: 4, id, createdAt: 1000, cwd: path.dirname(env.DSH_HOME), isSeeded: false, delegationDepth: 0 };
  const titleRow = { seq: 0, time: 1001, type: "session/title", data: { title, messageSeqs: [], source: { kind: "user" } } };
  fs.writeFileSync(file, Buffer.concat([header, titleRow].map(row => zlib.zstdCompressSync(Buffer.from(JSON.stringify(row) + "\n")))));
  return file;
}

test("DST discovers current generations and decodes all frames, preserving readable data before a torn append", { skip: !hasZstd }, t => {
  const { env } = fixture(t);
  const file = dstFile(env, A);
  const rows = [
    { seq: 1, time: 1002, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "DST human prompt" }] } },
    { seq: 2, time: 1003, type: "assistant/message", data: { message: { content: [{ type: "text", text: "DST assistant reply" }] } } },
  ];
  for (const row of rows) fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(row) + "\n")));
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from('incomplete append')).subarray(0, 7));
  fs.copyFileSync(file, file.replace(".v4.", ".v3."));
  assert.equal(dst.listSessionFiles(env).length, 1);
  assert.equal(dst.readMeta(file).title, "Original DST name");
  assert.equal(dst.parseTurns(file)[0].promptFull, "DST human prompt");
  assert.equal(dst.parseTurns(file)[0].replyFull, "DST assistant reply");
  assert.equal(adapters.forAgent("dsh-tui"), dst);
  assert.equal(adapters.forAgent("dst"), dst);
});

test("real Codex metadata rename persists in an isolated CODEX_HOME without starting a turn", async t => {
  const { env } = fixture(t);
  const binary = native.codexBinary(env);
  if (!fs.existsSync(binary)) { t.skip("Codex binary not installed"); return; }
  rollout(env, A, { cwd: path.dirname(env.CODEX_HOME) });
  await native.renameSession({ agent: "codex", sessionId: A }, "Isolated history test", { env });
  const result = await native.codexRequest("thread/read", { threadId: A, includeTurns: false }, { env });
  assert.equal(result.thread.name, "Isolated history test");
  assert.equal(codex.listSessions(env)[0].title, "Isolated history test");
});

test("real Codex fork creates a resumable saved child without changing its parent or starting a turn", async t => {
  const { env } = fixture(t);
  if (!fs.existsSync(native.codexBinary(env))) { t.skip("Codex binary not installed"); return; }
  const file = rollout(env, A, { cwd: path.dirname(env.CODEX_HOME) });
  const before = fs.readFileSync(file, "utf8");
  const id = await native.forkSession({ agent: "codex", sessionId: A }, { env });
  assert.notEqual(id, A);
  const child = adapters.findSession(id, [codex], env);
  assert.ok(child, "fork must be on disk before switching the current TUI");
  assert.equal(codex.readMeta(child.file, null, env).parentSessionId, A);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const family = adapters.buildGraph({ adapter: codex, file, scope: "lineage", env, store: memoryStore() });
  const branch = family.nodes.find(n => n.sessionBoundary && n.sessionId === id);
  assert.ok(branch);
  assert.equal(branch.sharedTurns, 1);
  assert.equal(branch.forkPointId, `codex:${A}#turn-${A}`);
  assert.equal(family.nodes.filter(n => n.key === `turn-${A}`).length, 1);
  const result = await native.codexRequest("thread/read", { threadId: id, includeTurns: false }, { env });
  assert.equal(result.thread.id, id);
});

test("real DST persistence rename is durable and refuses a held write lease", { skip: !hasZstd }, async t => {
  const { env } = fixture(t);
  let holder;
  try { holder = await native.dshBackend(path.join(env.DSH_HOME, "sessions"), "zstd", env); }
  catch (error) { if (/not installed/.test(error.message)) { t.skip("DST not installed"); return; } throw error; }
  try {
    const created = await holder.backend.create({ version: 4, id: A, createdAt: 1000, cwd: path.dirname(env.DSH_HOME),
      isSeeded: false, delegationDepth: 0 });
    try { await created.flush(); } finally { await created.close(); }
    const file = dst.listSessionFiles(env)[0];
    assert.ok(file);
    await native.renameSession({ agent: "dst", sessionId: A, file }, "Renamed DST session", { env });
    assert.equal(dst.readMeta(file).title, "Renamed DST session");
    const handle = await holder.backend.open(A, "write");
    try {
      await assert.rejects(native.renameSession({ agent: "dst", sessionId: A, file }, "Must refuse", { env }), /lease|owner|busy|writ/i);
      assert.equal(dst.readMeta(file).title, "Renamed DST session");
    } finally { await handle.close(); }
  } finally { await holder.context.fiber.dispose(); }
});
