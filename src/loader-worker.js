"use strict";

const { parentPort } = require("node:worker_threads");
const adapters = require("./adapters");
const { makeStore, cachedParse } = require("./store");
const { edgeInfo } = require("./relations");
const { directoryKey } = require("./catalog");
const herdr = require("./herdr");
const { safeStat } = require("./util");
const fs = require("node:fs");
const path = require("node:path");
const { TranscriptReader } = require("./transcript-reader");

const store = makeStore(), entries = new Map(), renamed = new Map();
let pageId = 0, scanning = false, complete = false, flushTimer;
let progress = null;
const fullVersions = new Map();
const signature = st => st && `${st.dev}|${st.ino}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
const yieldIO = () => new Promise(resolve => setImmediate(resolve));
const send = message => parentPort.postMessage(message);
const list = () => [...entries.values()].sort((a, b) => b.mtime - a.mtime);
function remember(meta, adapter) {
  if (meta.mtime == null) {
    const st = safeStat(meta.file);
    if (!st) return;
    meta = { ...meta, mtime: st.mtimeMs, size: st.size };
  }
  const key = `${adapter.id}:${meta.sessionId}`, old = entries.get(key);
  if (renamed.has(key)) meta = { ...meta, title: renamed.get(key) };
  if (!old || (meta.mtime || 0) >= (old.mtime || 0)) entries.set(key, { ...meta, key, agent: adapter.id, adapter });
}
function portable(graph) {
  // Adapter methods and flush callbacks cannot cross the worker boundary.
  const clean = entry => { const { adapter, ...rest } = entry; return rest; };
  return { ...graph, flush: undefined,
    sessions: new Map([...graph.sessions].map(([key, entry]) => [key, { ...clean(entry), meta: clean(entry.meta) }])),
    sessionMeta: new Map([...graph.sessionMeta].map(([key, entry]) => [key, clean(entry)])) };
}
function flushLater() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { store.flush(); }, 500);
}

function stopProgress() {
  if (!progress) return;
  clearTimeout(progress.timer);
  progress.reader.cancel();
  progress = null;
}
function progressTarget(message) {
  const adapter = adapters.byId(message.agent);
  if (!adapter || !message.sessionId) throw new Error("Select a saved session first.");
  const found = entries.get(`${adapter.id}:${message.sessionId}`);
  const file = found?.file || message.file || adapters.findSession(message.sessionId, [adapter])?.file;
  if (!file) throw new Error("Session file is not on disk.");
  return { adapter, file };
}
function progressEnvelope(sub) {
  return { id: sub.id, subscriptionId: sub.subscriptionId, key: sub.key,
    sourceEpoch: sub.reader.sourceEpoch, revision: sub.reader.revision,
    total: sub.reader.log.order.length,
    activeTurn: sub.reader.log.turn ? { ...sub.reader.log.turn,
      state: sub.reader.log.states.get(sub.reader.log.turn.key) || "unknown" } : null };
}
async function checkProgress(sub, revalidate = false) {
  if (progress !== sub) return;
  if (sub.checking) { sub.pending = true; sub.revalidate ||= revalidate; return; }
  clearTimeout(sub.timer);
  sub.checking = true;
  try {
    // DSH writes new generations in the same session directory.
    if (sub.agent === "dst" && /^session\.v\d+\./.test(path.basename(sub.reader.file))) {
      const candidates = fs.readdirSync(path.dirname(sub.reader.file)).filter(name => /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name));
      candidates.sort((a, b) => Number(b.match(/\.v(\d+)/)[1]) - Number(a.match(/\.v(\d+)/)[1]));
      const newest = candidates[0] && path.join(path.dirname(sub.reader.file), candidates[0]);
      if (newest && newest !== sub.reader.file) { sub.reader.file = newest; revalidate = true; }
    } else if (!fs.existsSync(sub.reader.file) && Date.now() - (sub.relocatedAt || 0) > 10000) {
      sub.relocatedAt = Date.now();
      const found = adapters.findSession(sub.sessionId, [adapters.byId(sub.agent)]);
      if (found) { sub.reader.file = found.file; revalidate = true; }
    }
    const change = await sub.reader.check({ revalidate });
    if (!change || progress !== sub) return;
    if (change.changed) {
      const fullChanged = (change.reset && sub.publishedRevision > 0) || fullVersions.get(sub.key) !== signature(sub.reader.signature);
      if (fullChanged) store.invalidate(sub.agent, sub.reader.file);
      if (entries.has(sub.key)) entries.get(sub.key).file = sub.reader.file;
      const envelope = progressEnvelope(sub);
      if (change.reset) send({ type: "progress-snapshot", ...envelope, ...sub.reader.window(), changed: true, fullChanged, file: sub.reader.file });
      else send({ type: "progress-delta", ...envelope, baseRevision: sub.publishedRevision,
        upserts: change.upserts, changed: true, fullChanged, file: sub.reader.file });
      sub.publishedRevision = change.revision;
    }
    sub.failures = 0;
    if (sub.history) {
      const history = sub.history; sub.history = null;
      send({ type: "progress-snapshot", ...progressEnvelope(sub), ...sub.reader.window(history),
        history: true, historyId: history.historyId, prepend: !!history.before, append: !!history.after, file: sub.reader.file });
    }
    send({ type: "progress-state", ...progressEnvelope(sub), checkedAt: Date.now(),
      status: change.invalidRecords ? `Skipped ${change.invalidRecords} malformed log record(s)` : "Synced" });
  } catch (error) {
    if (progress === sub) {
      sub.failures = Math.min(4, (sub.failures || 0) + 1);
      send({ type: "progress-state", ...progressEnvelope(sub), error: error.message, status: "Sync failed; showing last snapshot" });
    }
  } finally {
    sub.checking = false;
    if (progress === sub) {
      const pending = sub.pending, force = sub.revalidate;
      sub.pending = sub.revalidate = false;
      sub.timer = setTimeout(() => void checkProgress(sub, force), pending ? 0 : Math.min(16000, 2000 * 2 ** (sub.failures || 0)));
    }
  }
}

async function progressMessage(message) {
  if (message.type === "progress-subscribe") {
    stopProgress();
    const { adapter, file } = progressTarget(message);
    const sub = progress = { id: message.id, subscriptionId: message.subscriptionId,
      key: `${adapter.id}:${message.sessionId}`, agent: adapter.id, sessionId: message.sessionId,
      reader: new TranscriptReader(adapter.id, file), publishedRevision: 0 };
    await checkProgress(sub);
  } else if (message.type === "progress-unsubscribe") {
    if (progress?.subscriptionId === message.subscriptionId) stopProgress();
  } else if (progress?.subscriptionId === message.subscriptionId) {
    if (message.type === "progress-check") await checkProgress(progress, message.revalidate);
    else if (message.type === "progress-history") {
      const sub = progress;
      if (sub.checking) { sub.history = message; return; }
      send({ type: "progress-snapshot", ...progressEnvelope(sub), ...sub.reader.window(message),
        history: true, historyId: message.historyId, prepend: !!message.before, append: !!message.after, file: sub.reader.file });
    }
  }
}

async function scan(cwd, agent) {
  if (scanning || complete) return;
  scanning = true;
  const pending = [], batch = [];
  let lastPublish = 0;
  const publish = (stage, done = false) => {
    if (batch.length || done) send({ type: "catalog", entries: batch.splice(0), stage, complete: done });
  };
  // The current agent is scanned first; directory matches become usable as
  // soon as they are found. Other directories are published after this pass.
  const registry = [...adapters.ADAPTERS].sort((a, b) => Number(b.id === agent) - Number(a.id === agent));
  for (const adapter of registry) {
    try {
      for (const meta of adapter.scanSessions()) {
        remember(meta, adapter);
        if (directoryKey(meta.cwd) === directoryKey(cwd)) batch.push({ ...meta, agent: adapter.id });
        else pending.push({ ...meta, agent: adapter.id });
        if (batch.length && (batch.length >= 25 || Date.now() - lastPublish >= 50)) {
          publish("current directory"); lastPublish = Date.now();
        }
        await yieldIO();
      }
    } catch (error) { send({ type: "warning", error: `${adapter.label}: ${error.message}` }); }
  }
  publish("current directory");
  for (const meta of pending) {
    batch.push(meta);
    if (batch.length >= 50) { publish("other directories"); await yieldIO(); }
  }
  complete = true; scanning = false;
  publish("complete", true);
  flushLater();
}

async function details(id, rows, includeTurns = false) {
  const turns = new Map(), errors = new Map();
  const get = meta => {
    const key = `${meta.agent}:${meta.sessionId}`;
    if (turns.has(key)) return turns.get(key);
    try {
      const before = signature(safeStat(meta.file));
      const value = cachedParse(adapters.byId(meta.agent), meta.file, store);
      if (before === signature(safeStat(meta.file))) fullVersions.set(key, before);
      turns.set(key, value); return value;
    } catch (error) { errors.set(key, error.message); turns.set(key, null); return null; }
  };
  for (const requested of rows) {
    await yieldIO();
    if (id !== pageId) return;
    const row = entries.get(`${requested.agent}:${requested.sessionId}`) || requested;
    const parent = entries.get(`${row.agent}:${row.parentSessionId}`);
    if (!row.missing) get(row);
    if (parent) get(parent);
    if (includeTurns) send({ type: "transcript", id, key: `${row.agent}:${row.sessionId}`,
      turns: turns.get(`${row.agent}:${row.sessionId}`) || [], error: errors.get(`${row.agent}:${row.sessionId}`) });
    const info = edgeInfo(row, entries, meta => turns.get(`${meta.agent}:${meta.sessionId}`) ?? null);
    const error = errors.get(`${row.agent}:${row.sessionId}`) || errors.get(`${row.agent}:${row.parentSessionId}`);
    if (error) { info.error = error; info.pending = false; }
    // The sidebar needs a prompt and timestamp, not full copies of every reply.
    if (info.turn) info.turn = { prompt: info.turn.prompt, timestamp: info.turn.timestamp };
    send({ type: "edge", id, key: `${row.agent}:${row.sessionId}`, info });
  }
  flushLater();
}

async function page(message) {
  const { id, session, family } = message;
  pageId = id;
  let scope = message.scope, adapter = adapters.forAgent(session?.agent), file = session?.file;
  if (!adapter || !session?.value) scope = "all";
  if (scope !== "all" && !file) file = entries.get(`${adapter.id}:${session.value}`)?.file || adapters.findSession(session.value, [adapter])?.file;
  if (scope !== "all" && !file) scope = "all";
  if (file) {
    const meta = adapter.readMeta(file);
    if (meta) remember(meta, adapter);
  }
  const before = file && signature(safeStat(file));
  const graph = adapters.buildGraph({ adapter, sessionId: session?.value, file,
    scope: family || scope === "lineage" ? "all" : scope, entries: list(), store });
  if (file && scope === "session" && !family && before === signature(safeStat(file))) fullVersions.set(`${adapter.id}:${session.value}`, before);
  if (family || scope === "lineage") graph.scope = "lineage";
  send({ type: "page", id, graph: portable(graph), scope: family ? "lineage" : scope, complete });
  await yieldIO();
  flushLater();
}

parentPort.on("message", async message => {
  try {
    if (message.type.startsWith("progress-")) await progressMessage(message);
    else if (message.type === "refresh-session") {
      const { adapter, file } = progressTarget(message);
      store.invalidate(adapter.id, file);
      const before = signature(safeStat(file));
      const turns = cachedParse(adapter, file, store), meta = adapter.readMeta(file);
      if (before === signature(safeStat(file))) fullVersions.set(`${adapter.id}:${message.sessionId}`, before);
      send({ type: "session-refreshed", id: message.id, refreshId: message.refreshId,
        key: `${adapter.id}:${message.sessionId}`, turns, meta, file });
      flushLater();
    } else if (message.type === "start") {
      let pane = message.pane?.pane_id === message.callerId ? message.pane : null;
      try { if (!pane && message.callerId) pane = herdr.paneGet(message.callerId); } catch {}
      send({ type: "caller", pane });
      try {
        await page({ ...message, session: pane?.agent_session ? { ...pane.agent_session, agent: pane.agent_session.agent || pane.agent } : null });
      } catch (error) { send({ type: "error", id: message.id, error: error.message }); }
      void scan(pane?.cwd || message.cwd, pane?.agent_session?.agent || pane?.agent);
      try { send({ type: "panes", panes: herdr.paneList() }); } catch {}
    } else if (message.type === "page") await page(message);
    else if (message.type === "details") await details(message.id, message.rows, message.includeTurns);
    else if (message.type === "cancel") pageId = message.id;
    else if (message.type === "rename") {
      renamed.set(message.key, message.title);
      if (entries.has(message.key)) entries.get(message.key).title = message.title;
    }
    else if (message.type === "panes") {
      try { send({ type: "panes", panes: herdr.paneList() }); } catch {}
    }
  } catch (error) {
    send({ type: message.type.startsWith("progress-") ? "progress-state" : message.type === "refresh-session" ? "session-refresh-error" : "error",
      id: message.id, subscriptionId: message.subscriptionId, refreshId: message.refreshId,
      key: message.agent && message.sessionId ? `${message.agent}:${message.sessionId}` : undefined,
      error: error.message, status: "Could not read session" });
  }
});
