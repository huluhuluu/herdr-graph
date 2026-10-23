"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { ProgressLog } = require("../src/progress");
const { TranscriptReader } = require("../src/transcript-reader");
const { Loader } = require("../src/loader");
const { App } = require("../src/graph");
const adapters = require("../src/adapters");
const { makeStore } = require("../src/store");
const ID = "11111111-1111-4111-8111-111111111111";
const time = "2026-10-23T10:20:00Z";
const event = (type, extra = {}) => ({ timestamp: time, type: "event_msg", payload: { type, ...extra } });
const message = (text, phase = "commentary", role = "assistant") => ({ timestamp: time, type: "response_item",
  payload: { type: "message", role, phase, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-graph-progress-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function logRows() { return [event("task_started", { turn_id: "turn-1" }), message("Question", null, "user"), message("Checking files")]; }

test("progress preserves public messages, phases and repeated sentences while pairing Codex mirrors", () => {
  const log = new ProgressLog("codex");
  const rows = [event("task_started", { turn_id: "turn-1" }),
    message("# AGENTS.md instructions", null, "user"), message("Question", null, "user"),
    event("agent_message", { message: "Checking files" }), message("Checking files"),
    { type: "response_item", payload: { type: "function_call", arguments: "SECRET TOOL" } },
    message("PRIVATE THOUGHT", "analysis"),
    { ...message("PRIVATE MIXED", "analysis"), payload: { ...message("PRIVATE MIXED", "analysis").payload, channel: "commentary" } },
    message("Checking files"), event("agent_message", { message: "Checking files" }),
    message("Finished", "final_answer"), event("task_complete", { turn_id: "turn-1" })];
  rows.forEach((row, i) => log.accept(row, i, i + 1));
  const values = log.window().messages;
  assert.deepEqual(values.map(m => m.text), ["Checking files", "Checking files", "Finished"]);
  assert.deepEqual(values.map(m => m.kind), ["progress", "progress", "final"]);
  assert.ok(values.every(m => m.prompt === "Question" && m.state === "complete"));
  assert.equal(new Set(values.map(m => m.id)).size, 3);
});

test("Claude progress keeps branch parents, filters tool/thinking/sidechain and upserts UUIDs", () => {
  const log = new ProgressLog("claude");
  const user = (uuid, parentUuid, text) => ({ uuid, parentUuid, type: "user", message: { content: text } });
  const assistant = (uuid, parentUuid, text, extra = {}) => ({ uuid, parentUuid, type: "assistant", timestamp: time,
    message: { content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "tool_use", name: "SECRET" }, { type: "text", text }] }, ...extra });
  [user("u1", null, "First question"), assistant("a1", "u1", "First answer"),
    user("u2", "a1", "Second question"), assistant("a2", "u2", "Second answer"),
    user("u3", "a1", "Alternative question"), assistant("a3", "u3", "Alternative answer"),
    assistant("sub", "u3", "HIDDEN", { isSidechain: true }), assistant("a3", "u3", "Updated answer")]
    .forEach((row, i) => log.accept(row, i, i));
  const rows = log.window().messages;
  assert.deepEqual(rows.map(m => m.text), ["First answer", "Second answer", "Updated answer"]);
  assert.equal(rows[2].prompt, "Alternative question");
  assert.equal(rows[2].branchSwitch, true);
  assert.equal(rows[0].branchSwitch, false, "first question is not a branch switch");
  assert.ok(rows.every(m => m.kind === "assistant"));
});

test("JSONL reader handles split UTF-8, partial JSON, EOF without newline and idle incremental checks", async t => {
  const file = path.join(temp(t), "session.jsonl");
  fs.writeFileSync(file, jsonl(logRows()));
  const reader = new TranscriptReader("codex", file);
  await reader.check();
  const before = reader.bytesRead;
  assert.equal((await reader.check()).changed, false);
  assert.equal(reader.bytesRead, before);
  const extra = Buffer.from(JSON.stringify(message("正在检查中文🙂", "commentary")));
  const split = extra.indexOf(Buffer.from("中")) + 1;
  fs.appendFileSync(file, extra.subarray(0, split));
  assert.equal((await reader.check()).upserts.length, 0);
  fs.appendFileSync(file, extra.subarray(split));
  assert.equal((await reader.check()).upserts[0].text, "正在检查中文🙂");
  const record = reader.record.bind(reader);
  let recordCalls = 0;
  reader.record = (...args) => { recordCalls++; return record(...args); };
  await reader.check();
  assert.equal(recordCalls, 0, "an idle EOF without newline is not decoded again");
  fs.appendFileSync(file, "\r\n");
  assert.equal((await reader.check()).upserts.length, 0);
  assert.equal(reader.window().messages.length, 2);
  assert.equal(reader.bytesRead - before, extra.length + 2);
});

test("reader resets on same-size rewrite, replacement and truncation, and can cancel a large scan", async t => {
  const file = path.join(temp(t), "session.jsonl");
  fs.writeFileSync(file, jsonl(logRows()));
  const reader = new TranscriptReader("codex", file);
  await reader.check();
  const oldEpoch = reader.sourceEpoch;
  const stat = fs.statSync(file);
  fs.writeFileSync(file, jsonl(logRows()).replace("Checking files", "Changed! files"));
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal((await reader.check()).reset, true);
  assert.ok(reader.sourceEpoch > oldEpoch);
  assert.equal(reader.window().messages[0].text, "Changed! files");
  fs.writeFileSync(file, jsonl([message("New file", "final")]));
  await reader.check();
  assert.deepEqual(reader.window().messages.map(m => m.text), ["New file"]);
  fs.writeFileSync(file, jsonl([message("x".repeat(1024 * 1024))]));
  const cancelled = new TranscriptReader("codex", file);
  const pending = cancelled.check(); cancelled.cancel();
  assert.equal(await pending, null);
});

test("full cache rejects a replaced file even when size and modification time are preserved", t => {
  const dir = temp(t), file = path.join(dir, "cache-source.jsonl"), replacement = path.join(dir, "replacement.jsonl");
  const originalState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "cache");
  t.after(() => { if (originalState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR; else process.env.HERDR_PLUGIN_STATE_DIR = originalState; });
  fs.writeFileSync(file, "old body\n");
  const stat = fs.statSync(file), store = makeStore();
  store.put("codex", file, [{ replyFull: "old body" }]);
  assert.equal(store.get("codex", file)[0].replyFull, "old body");
  fs.writeFileSync(replacement, "new body\n");
  fs.utimesSync(replacement, stat.atime, stat.mtime);
  fs.renameSync(replacement, file);
  assert.equal(store.get("codex", file), null);
});

test("a same-size rewrite during a yielded read is discarded before publishing a mixed snapshot", async t => {
  const file = path.join(temp(t), "concurrent.jsonl");
  fs.writeFileSync(file, jsonl(logRows()));
  const reader = new TranscriptReader("codex", file);
  const pending = reader.check();
  fs.writeFileSync(file, jsonl(logRows()).replace("Checking files", "Changed! files"));
  const later = new Date(Date.now() + 1000);
  fs.utimesSync(file, later, later);
  await assert.rejects(pending, /changed while reading/);
  await reader.check();
  assert.equal(reader.window().messages[0].text, "Changed! files");
});

test("DST progress decodes appended complete frames and waits for a torn final frame", { skip: !zlib.zstdCompressSync }, async t => {
  const file = path.join(temp(t), "session.v1.jsonl.zstd");
  const frame = rows => zlib.zstdCompressSync(Buffer.from(jsonl(rows)));
  fs.writeFileSync(file, frame([{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: "DST question" } },
    { type: "assistant/message", seq: 2, time: Date.now(), data: { message: { content: [{ type: "tool_use", name: "SECRET" }, { type: "text", text: "DST progress" }] } } }]));
  const reader = new TranscriptReader("dst", file);
  await reader.check();
  assert.equal(reader.window().messages[0].text, "DST progress");
  const next = frame([{ type: "assistant/message", seq: 3, data: { message: { content: "Latest result" } } }]);
  fs.appendFileSync(file, next.subarray(0, next.length - 2));
  assert.equal((await reader.check()).upserts.length, 0);
  fs.appendFileSync(file, next.subarray(next.length - 2));
  assert.equal((await reader.check()).upserts[0].text, "Latest result");
  assert.equal(reader.window().messages.length, 2);
});

test("old public bodies are released and history windows hydrate JSONL and compressed locations", async t => {
  const dir = temp(t);
  for (const compressed of [false, true]) {
    if (compressed && !zlib.zstdCompressSync) continue;
    const file = path.join(dir, compressed ? "history.jsonl.zstd" : "history.jsonl");
    const rows = Array.from({ length: 900 }, (_, i) => ({ type: "assistant/message", seq: i,
      data: { message: { content: `Public result ${i}` } } }));
    const bytes = Buffer.from(jsonl(rows));
    fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(bytes) : bytes);
    const reader = new TranscriptReader("dst", file);
    await reader.check();
    assert.equal(reader.log.messages.get("seq:0").text, undefined);
    assert.equal(reader.window({ first: true }).messages[0].text, "Public result 0");
    assert.equal(reader.window().messages.at(-1).text, "Public result 899");
    assert.equal(reader.window({ before: "seq:700" }).messages.at(-1).text, "Public result 699");
    assert.equal(reader.log.messages.get("seq:0").text, undefined, "paging does not retain another full copy");
  }
});

test("history lookup locates a middle turn outside the latest window", () => {
  const log = new ProgressLog("codex");
  for (let i = 0; i < 600; i++) {
    log.accept(event("task_started", { turn_id: `turn-${i}` }), i * 2, i * 2);
    log.accept(message(`Result ${i}`), i * 2 + 1, i * 2 + 1);
  }
  const middle = log.window({ turnRef: "turn-250" });
  assert.equal(middle.messages[0].text, "Result 250");
  assert.ok(middle.hasEarlier && middle.hasLater);
});

function appFixture(t) {
  const dir = temp(t), file = path.join(dir, `rollout-${ID}.jsonl`);
  fs.writeFileSync(file, jsonl([{ type: "session_meta", payload: { id: ID, cwd: dir } }, ...logRows()]));
  const env = { CODEX_HOME: dir, CLAUDE_CONFIG_DIR: dir, DSH_HOME: dir, HERDR_PLUGIN_STATE_DIR: path.join(dir, "cache") };
  const store = { get: () => null, put() {}, flush() {} };
  const app = new App({ env, store });
  app.graph = adapters.buildGraph({ adapter: adapters.byId("codex"), file, scope: "session", env, store, entries: [] });
  app.screen.cols = 118; app.screen.rows = 28; app.screen.out = { write() {} };
  const sent = []; app.loader = { send(m) { sent.push(m); } };
  return { app, file, sent, env };
}
function deliver(app, type, extra = {}) {
  const d = app.progressView.data;
  app.backgroundMessage({ type, id: app.loadId, subscriptionId: d.subscriptionId, key: d.key,
    sourceEpoch: 1, revision: 1, messages: [], ...extra });
}
function row(id, text, order) { return { id, text, order, turnRef: "turn-1", prompt: "Question", kind: "progress", state: "running", timestamp: time }; }

test("progress reader follows updates, pauses while reading, rejects late subscriptions and preserves full scroll", t => {
  const { app, sent } = appFixture(t);
  app.scroll = 7;
  app.handleKey({ name: "m" });
  const oldSubscription = app.progressView.data.subscriptionId;
  deliver(app, "progress-snapshot", { messages: Array.from({ length: 40 }, (_, i) => row(`m${i}`, `Progress ${i}`, i)), changed: true });
  app.render();
  const d = app.progressView.data;
  assert.equal(d.scroll, d.maxScroll);
  app.handleKey({ name: "k" }); app.render();
  const bookmark = app.progressView.bookmark();
  deliver(app, "progress-delta", { baseRevision: 1, revision: 2, upserts: [row("latest", "Fresh progress", 40)] });
  app.render();
  assert.equal(d.follow, false);
  assert.equal(d.unseen, 1);
  assert.deepEqual(app.progressView.bookmark(), bookmark);
  app.handleKey({ name: "G" });
  assert.equal(sent.at(-1).type, "progress-history");
  app.handleKey({ name: "m" });
  assert.equal(app.readerMode, "full");
  assert.equal(app.scroll, 7);
  assert.equal(sent.at(-1).type, "refresh-session");
  const refreshId = sent.at(-1).refreshId;
  const turns = [{ ...app.current(), reply: "Latest full output", replyFull: "Latest full output" }];
  app.backgroundMessage({ type: "session-refreshed", id: app.loadId, refreshId,
    key: `codex:${ID}`, turns, file: app.current().file });
  assert.equal(app.current().replyFull, "Latest full output");
  assert.equal(app.scroll, 7);
  app.handleKey({ name: "m" });
  assert.notEqual(app.progressView.data.subscriptionId, oldSubscription);
  app.backgroundMessage({ type: "progress-snapshot", subscriptionId: oldSubscription, messages: [row("stale", "Wrong content", 0)] });
  assert.equal(app.progressView.data.messages.length, 0);
});

test("progress has a narrow reader, separate search and does not intercept rename/search typing", t => {
  const { app } = appFixture(t);
  app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: [row("one", "Searchable result", 0)] });
  app.screen.cols = 58; app.render();
  assert.equal(app.layout().detail.w, 58);
  app.handleKey({ name: "/" });
  assert.equal(app.mode, "progress-search");
  app.handleKey({ name: "m", printable: true, raw: "m" });
  app.handleKey({ name: "escape" });
  assert.equal(app.readerMode, "progress");
  assert.equal(app.progressView.queryInput, "m");
  app.handleKey({ name: "tab" }); app.render();
  assert.equal(app.layout().detail, null);
  app.mode = "rename";
  app.handleKey({ name: "m", printable: true, raw: "m" });
  assert.equal(app.renameInput, "m");
});

test("m during startup is applied when the graph arrives; a waiting turn is visible without assistant text", t => {
  const { app } = appFixture(t), graph = app.graph;
  app.graph = null; app.loading = "Loading current session…";
  app.handleKey({ name: "m" });
  assert.equal(app.readerMode, "progress");
  app.graph = graph; app.loading = null; app.render();
  deliver(app, "progress-snapshot", { messages: [], activeTurn: { key: "turn-2", prompt: "New question" } });
  app.render();
  assert.ok(app.progressView.data.lines.some(line => line.text.includes("No public assistant progress")));
});

test("returning to another session restores its progress bookmark and ignores old state updates in the new-message count", t => {
  const { app } = appFixture(t);
  app.handleKey({ name: "m" });
  const rows = Array.from({ length: 40 }, (_, i) => row(`m${i}`, `Progress ${i}`, i));
  deliver(app, "progress-snapshot", { messages: rows }); app.render();
  app.handleKey({ name: "k" }); app.render();
  const bookmark = app.progressView.bookmark();
  const original = app.current();
  let selected = original;
  app.current = () => selected;
  selected = { ...original, id: "another-node", sessionId: "another-session" };
  app.progressView.sync();
  selected = original;
  app.progressView.sync();
  deliver(app, "progress-snapshot", { messages: rows }); app.render();
  assert.equal(app.progressView.data.follow, false);
  assert.deepEqual(app.progressView.bookmark(), bookmark);
  deliver(app, "progress-delta", { baseRevision: 1, revision: 2, upserts: [{ ...row("old-unloaded", "Old result", 1), state: "complete" }] });
  assert.equal(app.progressView.data.unseen, 0);
});

test("worker automatically publishes new progress and full refresh reads the newest output", async t => {
  const { app, file, env } = appFixture(t), received = [];
  const loader = new Loader(env, m => received.push(m));
  t.after(() => loader.close());
  const wait = async (predicate, timeout = 8000) => {
    const start = Date.now();
    while (!received.some(predicate)) {
      if (Date.now() - start > timeout) assert.fail(JSON.stringify(received));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return received.find(predicate);
  };
  loader.send({ type: "progress-subscribe", id: 1, subscriptionId: 1, agent: "codex", sessionId: ID, file });
  await wait(m => m.type === "progress-snapshot", 30000);
  loader.send({ type: "progress-check", subscriptionId: 1, revalidate: true });
  loader.send({ type: "progress-history", subscriptionId: 1, historyId: 77, first: true });
  await wait(m => m.type === "progress-snapshot" && m.historyId === 77);
  const start = Date.now();
  fs.appendFileSync(file, jsonl([message("Automatically refreshed result", "final")]));
  const delta = await wait(m => m.type === "progress-delta");
  assert.ok(delta.upserts.some(m => m.text === "Automatically refreshed result"));
  assert.ok(Date.now() - start < 3500);
  loader.send({ type: "progress-unsubscribe", subscriptionId: 1 });
  loader.send({ type: "refresh-session", id: 1, refreshId: 1, agent: "codex", sessionId: ID, file });
  const full = await wait(m => m.type === "session-refreshed");
  assert.match(full.turns.at(-1).replyFull, /Automatically refreshed result/);
  app.progressView.ensureFull(true);
  const pending = app.progressView.pendingFull;
  loader.send({ type: "refresh-session", id: app.loadId, refreshId: 2, agent: "codex", sessionId: ID, file: `${file}.missing` });
  const failure = await wait(m => m.type === "session-refresh-error");
  app.backgroundMessage({ ...failure, refreshId: pending.refreshId });
  assert.equal(app.progressView.pendingFull, null, "failed refresh must release its pending request");
  assert.match(app.progressView.fullError, /ENOENT|not on disk/);
});

test("malformed DST timestamps do not prevent later public messages from loading", async t => {
  const file = path.join(temp(t), "session.jsonl");
  fs.writeFileSync(file, jsonl([1e30, 0].map((time, seq) => ({ type: "assistant/message", seq, time,
    data: { message: { content: `Answer ${seq}` } } }))));
  const reader = new TranscriptReader("dst", file);
  await reader.check();
  const rows = reader.window().messages;
  assert.deepEqual(rows.map(m => m.text), ["Answer 0", "Answer 1"]);
  assert.equal(rows[0].timestamp, null);
});

test("G supersedes an in-flight older-history request", t => {
  const { app, sent } = appFixture(t);
  app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: [row("tail", "Latest", 900)], total: 901, hasEarlier: true });
  app.render();
  app.handleKey({ name: "pageup" });
  const older = sent.at(-1);
  app.handleKey({ name: "G" });
  const latest = sent.at(-1);
  assert.notEqual(latest.historyId, older.historyId);
  deliver(app, "progress-snapshot", { history: true, historyId: older.historyId, messages: [row("old", "Old", 100)], prepend: true });
  assert.deepEqual(app.progressView.data.messages.map(m => m.id), ["tail"]);
  deliver(app, "progress-snapshot", { history: true, historyId: latest.historyId, messages: [row("new", "Newest", 901)], total: 902 });
  assert.equal(app.progressView.data.messages.at(-1).text, "Newest");
  assert.equal(app.progressView.data.follow, true);
});

test("a bookmark outside the latest window requests its exact message before restoring", t => {
  const { app, sent } = appFixture(t);
  app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: Array.from({ length: 40 }, (_, i) => row(`old${i}`, `Old ${i}`, i)), total: 1000, hasLater: true });
  app.render(); app.handleKey({ name: "k" }); app.render();
  const bookmark = app.progressView.bookmark();
  app.handleKey({ name: "m" }); app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: [row("tail", "Latest", 999)], total: 1000, hasEarlier: true });
  app.render();
  assert.equal(sent.at(-1).type, "progress-history");
  assert.equal(sent.at(-1).around, bookmark.messageId);
});

test("completing a full refresh keeps the user's newer turn selection", t => {
  const { app, sent } = appFixture(t);
  const first = app.current();
  const second = { ...first, id: `${first.sessionKey}#turn-2`, key: "turn-2", index: 1, prompt: "Second question", promptFull: "Second question" };
  app.graph.nodes.push(second);
  app.progressView.ensureFull(true);
  const request = sent.at(-1);
  app.selected = 1;
  app.backgroundMessage({ type: "session-refreshed", id: app.loadId, refreshId: request.refreshId, key: first.sessionKey,
    turns: [first, second], file: first.file });
  assert.equal(app.current().key, "turn-2");
});

test("hydrating indexed history rejects a replaced file before reading its old locations", async t => {
  const file = path.join(temp(t), "history.jsonl");
  const rows = Array.from({ length: 500 }, (_, i) => message(`Old ${String(i).padStart(3, "0")}`));
  fs.writeFileSync(file, jsonl(rows));
  const reader = new TranscriptReader("codex", file);
  await reader.check();
  fs.writeFileSync(file, jsonl(rows).replaceAll("Old", "New"));
  const later = new Date(Date.now() + 1000); fs.utimesSync(file, later, later);
  assert.throws(() => reader.window({ first: true }), /changed|refresh/i);
});

test("burst append sends bounded public bodies and keeps an exact paused new-message count", async t => {
  const file = path.join(temp(t), "burst.jsonl");
  fs.writeFileSync(file, jsonl(logRows()));
  const reader = new TranscriptReader("codex", file);
  await reader.check(); reader.window();
  fs.appendFileSync(file, jsonl(Array.from({ length: 1800 }, (_, i) => message(`Burst ${i}`))));
  const change = await reader.check();
  assert.ok(change.upserts.length <= 800, `oversized delta: ${change.upserts.length}`);
  const { app } = appFixture(t);
  app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: [row("one", "Initial", 0)], total: 1 });
  app.render(); app.handleKey({ name: "k" });
  deliver(app, "progress-delta", { baseRevision: 1, revision: 2, total: 1801,
    upserts: [row("last", "Burst last", 1800)] });
  assert.equal(app.progressView.data.unseen, 1800);
});

test("widening progress content keeps the bookmarked character visible", t => {
  const { app } = appFixture(t);
  app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: [row("long", "a".repeat(5000), 0)] });
  app.render(); app.handleKey({ name: "k" }); app.progressView.scroll(-12); app.render();
  const before = app.progressView.bookmark();
  app.screen.cols = 160; app.render();
  const line = app.progressView.data.lines[app.progressView.data.scroll];
  assert.equal(line.id, before.id);
  assert.ok(line.offset <= before.offset && before.offset < line.offset + line.text.length);
});

test("Codex starts a new legacy turn after completion and ignores another turn's terminal event", () => {
  const log = new ProgressLog("codex");
  const rows = [...logRows(), event("task_complete", { turn_id: "turn-1" }),
    message("Second question", null, "user"), message("Second progress"),
    event("task_complete", { turn_id: "turn-1" })];
  rows.forEach((r, i) => log.accept(r, i, i + 1));
  const messages = log.window().messages;
  assert.notEqual(messages[0].turnRef, messages[1].turnRef);
  assert.equal(messages[1].prompt, "Second question");
  assert.equal(messages[1].state, "unknown");
});

test("replayed Claude user UUIDs do not invent a branch switch", () => {
  const log = new ProgressLog("claude");
  const user = { type: "user", uuid: "u1", parentUuid: null, message: { content: "Question" } };
  [user, user, { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "Answer" } }]
    .forEach((r, i) => log.accept(r, i, i));
  assert.equal(log.window().messages[0].branchSwitch, false);
});

test("page navigation clears a pending full refresh and ignores its late response", t => {
  const { app } = appFixture(t);
  app.progressView.ensureFull(true);
  const pending = app.progressView.pendingFull;
  app.loadBackground();
  assert.equal(app.progressView.pendingFull, null);
  app.backgroundMessage({ type: "session-refreshed", id: pending.pageId, refreshId: pending.refreshId,
    key: pending.key, turns: [] });
  assert.equal(app.graph, null);
});

test("historical progress pages can be read forward without skipping the middle", t => {
  const log = new ProgressLog("codex");
  for (let i = 0; i < 900; i++) log.accept(message(`Result ${i}`), i, i + 1);
  let page = log.window({ first: true }), ids = page.messages.map(m => m.id);
  while (page.hasLater) {
    page = log.window({ after: page.messages.at(-1).id });
    ids.push(...page.messages.map(m => m.id));
  }
  assert.equal(new Set(ids).size, 900);
  const { app, sent } = appFixture(t);
  app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: [row("old", "Older page", 0)], total: 3, hasLater: true });
  app.render(); app.progressView.scroll(1000);
  assert.equal(sent.at(-1).after, "old");
  deliver(app, "progress-snapshot", { history: true, historyId: sent.at(-1).historyId, append: true,
    messages: [row("middle", "Middle page", 1)], total: 3, hasEarlier: true, hasLater: true });
  assert.deepEqual(app.progressView.data.messages.map(m => m.id), ["old", "middle"]);
});

test("an updated old UUID is rehydrated for a paused window without retaining its body", async t => {
  const file = path.join(temp(t), "claude.jsonl");
  const answer = (uuid, text) => ({ type: "assistant", uuid, parentUuid: "u1", message: { content: text } });
  fs.writeFileSync(file, jsonl([{ type: "user", uuid: "u1", message: { content: "Question" } },
    ...Array.from({ length: 600 }, (_, i) => answer(`a${i}`, `Answer ${i}`))]));
  const reader = new TranscriptReader("claude", file);
  await reader.check(); reader.window({ first: true });
  fs.appendFileSync(file, jsonl([answer("a5", "Updated old answer")]));
  const change = await reader.check();
  const update = change.upserts.find(m => m.id === "a5");
  assert.ok(update.reload);
  assert.equal(update.text, undefined);
  assert.equal(reader.window({ first: true }).messages[5].text, "Updated old answer");
  assert.equal(reader.log.messages.get("a5").text, undefined);
});

test("an old turn uses its exact identity instead of a later ordinal and empty turns stay empty", t => {
  const log = new ProgressLog("codex");
  log.accept(event("task_started", { turn_id: "new-turn" }), 1, 1);
  log.accept(message("Later answer"), 2, 20);
  assert.ok(log.window({ turnRef: "old-empty-turn", ordinal: 1 }).turnMissing);
  const { app, sent } = appFixture(t);
  const first = app.current();
  app.graph.nodes.push({ ...first, id: "later-turn-node", key: "new-turn", index: 1 });
  app.handleKey({ name: "m" });
  deliver(app, "progress-snapshot", { messages: [{ ...row("later", "Later answer", 1), turnRef: "new-turn", ordinal: 99 }], hasEarlier: true });
  app.render();
  assert.equal(sent.at(-1).type, "progress-history");
  assert.equal(sent.at(-1).turnRef, "turn-1");
});

test("detailed Family still requests its turns while progress content is active", t => {
  const { app, sent } = appFixture(t);
  app.relationView = true; app.familyDetail = true;
  app.handleKey({ name: "m" }); app.render();
  assert.ok(sent.some(m => m.type === "details" && m.includeTurns));
});

test("long runs of identical Codex messages pair mirrors in source order without deleting real repetitions", () => {
  const log = new ProgressLog("codex");
  log.accept(event("task_started", { turn_id: "repeat" }), 0, 1);
  for (let i = 0; i < 5000; i++) log.accept(event("agent_message", { message: "Still working" }), i + 1, i + 2);
  for (let i = 0; i < 5000; i++) log.accept(message("Still working"), i + 6000, i + 6001);
  assert.equal(log.order.length, 5000);
  assert.ok([...log.messages.values()].every(m => m.kind === "progress"));
});
