"use strict";

const { parentPort } = require("node:worker_threads");
const adapters = require("./adapters");
const { makeStore, cachedParse } = require("./store");
const { edgeInfo } = require("./relations");
const { directoryKey } = require("./catalog");
const herdr = require("./herdr");
const { safeStat } = require("./util");

const store = makeStore(), entries = new Map(), renamed = new Map();
let pageId = 0, scanning = false, complete = false, flushTimer;
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
      const value = cachedParse(adapters.byId(meta.agent), meta.file, store);
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
  const graph = adapters.buildGraph({ adapter, sessionId: session?.value, file,
    scope: family || scope === "lineage" ? "all" : scope, entries: list(), store });
  if (family || scope === "lineage") graph.scope = "lineage";
  send({ type: "page", id, graph: portable(graph), scope: family ? "lineage" : scope, complete });
  await yieldIO();
  flushLater();
}

parentPort.on("message", async message => {
  try {
    if (message.type === "start") {
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
  } catch (error) { send({ type: "error", id: message.id, error: error.message }); }
});
