"use strict";

// Adapter registry plus the graph builder that stitches turns and cross-session
// lineage into a renderable tree.

const fs = require("node:fs");
const path = require("node:path");
const codex = require("./codex");
const claude = require("./claude");
const dst = require("./dst");
const { makeStore, cachedParse } = require("../store");

const ADAPTERS = [codex, claude, dst];

function byId(id) {
  return ADAPTERS.find(a => a.id === id) || null;
}

// Map a Herdr `agent_session.agent` value onto one of our adapters.
function forAgent(agent) {
  const a = String(agent || "").toLowerCase();
  if (!a) return null;
  if (a === "codex") return codex;
  if (a === "claude" || a === "claude-code") return claude;
  if (a === "dst" || a.startsWith("dsh") || a === "deepseek") return dst;
  return ADAPTERS.find(x => a.startsWith(x.id)) || null;
}

function detect() {
  const found = [];
  for (const a of ADAPTERS) {
    const roots = a.sessionRoots();
    if (roots.some(r => fs.existsSync(r))) found.push(a);
  }
  return found;
}

// Locate a session file by native session id, across every adapter.
function findSession(sessionId, adapters = ADAPTERS, env = process.env) {
  if (!sessionId) return null;
  for (const a of adapters) {
    for (const file of a.listSessionFiles(env)) {
      if (a.sessionIdFromFile(file) === sessionId) return { adapter: a, file };
    }
  }
  return null;
}

function listSessions(env = process.env, registry = ADAPTERS) {
  const sessions = new Map();
  for (const adapter of registry) for (const meta of adapter.listSessions(env)) {
    if (!meta.sessionId) continue;
    const key = `${adapter.id}:${meta.sessionId}`;
    if (!sessions.has(key) || sessions.get(key).mtime < meta.mtime) {
      sessions.set(key, { ...meta, key, adapter });
    }
  }
  return [...sessions.values()].sort((a, b) => b.mtime - a.mtime);
}

// Build the node tree for one session.
//
//   scope "session"  -> just this session's turns
//   scope "lineage"  -> walk parents and children to form the full fork tree
//   scope "all"      -> metadata-only catalog; parse a session when it is opened
function buildGraph({ adapter, sessionId, file, scope = "session", env = process.env, store = null, registry = ADAPTERS, entries = null }) {
  if (scope === "all") {
    entries ||= listSessions(env, registry);
    const children = new Map();
    for (const entry of entries) {
      const parent = `${entry.adapter.id}:${entry.parentSessionId}`;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push({ sessionKey: entry.key, sessionId: entry.sessionId, title: entry.title, agent: entry.adapter.id });
    }
    const sessionMeta = new Map(entries.map(entry => [entry.key, { ...entry, agent: entry.adapter.id }]));
    const focusKey = adapter && sessionId ? `${adapter.id}:${sessionId}` : null;
    const sessions = new Map(entries.map(entry => [entry.key, { ...entry, meta: entry, turns: [], loaded: false }]));
    return {
      scope, sessions, sessionMeta, rootKey: focusKey, focusKey, focusSessionId: sessionId || null, focusAgent: adapter?.id || null,
      nodes: entries.map((entry, index) => ({
        id: `${entry.key}#session`, key: "session", sessionKey: entry.key, sessionId: entry.sessionId,
        agent: entry.adapter.id, file: entry.file, cwd: entry.cwd, title: entry.title,
        prompt: entry.title || entry.sessionId.slice(0, 8), reply: entry.cwd || "",
        timestamp: new Date(entry.mtime).toISOString(), index, depth: 0, branchCount: 0,
        parentSessionId: entry.parentSessionId || null,
        parentId: entry.parentSessionId ? `${entry.adapter.id}:${entry.parentSessionId}#session` : null,
        forkedChildren: children.get(entry.key) || [],
        isFocusSession: entry.key === focusKey, sessionOnly: true,
        readError: entry.readError, archived: entry.archived,
      })),
      flush: () => {},
    };
  }
  const adapterList = adapter ? [adapter] : ADAPTERS;
  const found = file ? { adapter, file } : findSession(sessionId, adapterList, env);
  if (!found) throw new Error(`Session ${sessionId} not found on disk.`);

  const cache = store || makeStore();
  const parse = (ad, f) => cachedParse(ad, f, cache);

  const sessions = new Map();
  function load(ad, sid, f) {
    const id = `${ad.id}:${sid}`;
    if (sessions.has(id)) return sessions.get(id);
    const meta = ad.readMeta(f, null, env) || { cwd: "", parentSessionId: null };
    const entry = {
      key: id,
      agent: ad.id,
      adapter: ad,
      sessionId: sid,
      file: f,
      meta,
      turns: [],
      loaded: false,
    };
    sessions.set(id, entry);
    return entry;
  }

  const rootEntry = load(found.adapter, found.adapter.sessionIdFromFile(found.file), found.file);
  rootEntry.turns = parse(found.adapter, found.file);
  rootEntry.loaded = true;

  // Index every session on disk once; lineage walks are then pure lookups.
  // Default view reads family metadata but never parses sibling transcripts.
  let index = null;
  function ensureIndex() {
    if (index) return index;
    index = new Map();
    for (const entry of entries || listSessions(env, adapterList)) index.set(entry.key, { adapter: entry.adapter, meta: entry });
    if (!index.has(rootEntry.key)) index.set(rootEntry.key, { adapter: found.adapter, meta: { ...rootEntry.meta, sessionId: rootEntry.sessionId, file: rootEntry.file } });
    return index;
  }

  function childrenOf(key) {
    const [agent, sid] = key.split(":");
    const out = [];
    for (const v of ensureIndex().values()) {
      if (v.adapter.id === agent && v.meta.parentSessionId === sid) out.push(v);
    }
    return out;
  }

  if (scope !== "session") {
    ensureIndex();
    // Walk up to the root.
    let cur = rootEntry;
    const seen = new Set([cur.key]);
    while (cur.meta.parentSessionId) {
      const pkey = `${cur.agent}:${cur.meta.parentSessionId}`;
      const hit = index.get(pkey);
      if (!hit || seen.has(pkey)) break;
      seen.add(pkey);
      const parent = load(hit.adapter, hit.meta.sessionId, hit.meta.file);
      parent.turns = parse(hit.adapter, hit.meta.file);
      parent.loaded = true;
      cur = parent;
    }
    // Walk down through every descendant.
    const queue = [cur.key];
    const guard = new Set(queue);
    while (queue.length) {
      const key = queue.shift();
      for (const c of childrenOf(key)) {
        const ckey = `${c.adapter.id}:${c.meta.sessionId}`;
        if (guard.has(ckey)) continue;
        guard.add(ckey);
        const child = load(c.adapter, c.meta.sessionId, c.meta.file);
        child.turns = parse(c.adapter, c.meta.file);
        child.loaded = true;
        queue.push(ckey);
      }
    }
  }

  const sessionMeta = new Map([...ensureIndex()].map(([key, entry]) => [key, { ...entry.meta, key, agent: entry.adapter.id }]));

  return {
    scope,
    sessions,
    sessionMeta,
    rootKey: rootEntry.key,
    // `sessionId` comes from the filename, which is the identity Herdr reports
    // as agent_session.value and the only unique key across all 169 rollouts.
    focusKey: rootEntry.key,
    focusSessionId: rootEntry.sessionId,
    focusAgent: rootEntry.agent,
    nodes: flatten(sessions, rootEntry, scope, sessionMeta),
    flush: () => cache.flush(),
  };
}

// Flatten sessions into a single depth-first node list for hjkl navigation.
//
// Session boundaries connect to their fork turn, or to the parent session
// boundary when the point is not recorded. Shared history is displayed once.
// A linear conversation remains flat; only boundaries and branch points indent.
function sameTurn(a, b) {
  const identity = (a.turnId && b.turnId && a.turnId === b.turnId) ||
    (a.timestamp && a.timestamp === b.timestamp);
  return identity && a.promptFull === b.promptFull && a.replyFull === b.replyFull;
}

function sharedPrefix(parentTurns, childTurns) {
  let count = 0;
  while (count < parentTurns.length && count < childTurns.length && sameTurn(parentTurns[count], childTurns[count])) count++;
  return count;
}

// Number turns in the direct parent's full transcript, including inherited turns.
function forkInfo(parentTurns, childMeta, sharedTurns = 0) {
  let turn = null, location = "unknown";
  if (childMeta.forkMessageUuid) {
    turn = parentTurns.find(t => t.key === childMeta.forkMessageUuid || t.messageUuids?.includes(childMeta.forkMessageUuid));
    if (turn) location = "message";
  }
  if (!turn && Number.isFinite(childMeta.forkOrdinalExclusive)) {
    for (const candidate of parentTurns) if (Number.isFinite(candidate.ordStart) && candidate.ordStart < childMeta.forkOrdinalExclusive) turn = candidate;
    if (turn) location = "ordinal";
  }
  if (!turn && sharedTurns) { turn = parentTurns[sharedTurns - 1]; location = "shared history"; }
  return { turn, location, number: turn ? parentTurns.indexOf(turn) + 1 : null };
}

function flatten(sessions, rootEntry, scope, metadata = null) {
  const all = new Map(), headers = new Map();
  const meta = metadata || new Map([...sessions].map(([key, s]) => [key, { ...s.meta, agent: s.agent, sessionId: s.sessionId }]));
  const shared = new Map();
  for (const s of sessions.values()) {
    const parent = sessions.get(`${s.agent}:${s.meta.parentSessionId}`);
    let count = 0;
    if (scope !== "session" && parent && parent !== s) {
      count = sharedPrefix(parent.turns, s.turns);
    }
    shared.set(s.key, count);
    const base = { sessionKey: s.key, agent: s.agent, sessionId: s.sessionId, title: s.meta.title || "",
      file: s.file, cwd: s.meta.cwd, parentSessionId: s.meta.parentSessionId || null,
      isFocusSession: s.key === rootEntry.key };
    let header = null;
    if (scope !== "session") {
      header = { ...base, id: `${s.key}#session`, key: "session", sessionBoundary: true,
        sharedTurns: count, timestamp: s.meta.timestamp, parentId: null };
      headers.set(s.key, header);
      all.set(header.id, header);
    }
    const kept = s.turns.slice(count);
    const keys = new Set(kept.map(t => t.key));
    kept.forEach((t, i) => {
      const parentKey = Object.hasOwn(t, "parentKey") ? t.parentKey : kept[i - 1]?.key;
      const node = { ...t, ...base, id: `${s.key}#${t.key}`,
        parentId: parentKey && keys.has(parentKey) ? `${s.key}#${parentKey}` : header?.id || null };
      all.set(node.id, node);
    });
  }

  // A hidden inherited turn belongs to the ancestor that originally displayed it.
  function displayedTurn(s, turn, seen = new Set()) {
    if (!s || !turn || seen.has(s.key)) return null;
    seen.add(s.key);
    const node = all.get(`${s.key}#${turn.key}`);
    if (node) return node;
    const parent = sessions.get(`${s.agent}:${s.meta.parentSessionId}`);
    return parent ? displayedTurn(parent, parent.turns.find(t => sameTurn(t, turn)), seen) : null;
  }
  for (const [key, child] of meta) {
    const parent = sessions.get(`${child.agent}:${child.parentSessionId}`);
    if (!parent || parent.key === key) continue;
    const { turn: target, location } = forkInfo(parent.turns, child, shared.get(key));
    const point = displayedTurn(parent, target);
    const header = headers.get(key);
    if (header) {
      header.parentId = point?.id || headers.get(parent.key)?.id || null;
      header.forkLocation = location;
      header.forkPointId = point?.id || null;
    }
    if (point) {
      point.forkedChildren ||= [];
      point.forkedChildren.push({ sessionKey: key, sessionId: child.sessionId, title: child.title, agent: child.agent, cwd: child.cwd });
    }
  }

  const children = new Map();
  for (const node of all.values()) {
    if (!all.has(node.parentId) || node.parentId === node.id) node.parentId = null;
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  }
  // Display fork headers beside the fork point, before the parent's continuation.
  for (const list of children.values()) list.sort((a, b) => Number(!!b.sessionBoundary) - Number(!!a.sessionBoundary));
  const nodes = [], visited = new Set();
  function walk(node, depth) {
    const stack = [{ node, depth, guides: [] }];
    while (stack.length) {
      const current = stack.pop();
      const n = current.node;
      if (visited.has(n.id)) continue;
      visited.add(n.id);
      n.depth = current.depth;
      n.guideDepths = current.guides;
      const kids = (children.get(n.id) || []).filter(child => !visited.has(child.id));
      n.branchCount = kids.length;
      nodes.push(n);
      const childDepth = current.depth + (n.sessionBoundary ? 2 : kids.length > 1 || (scope !== "session" && n.forkedChildren?.length) ? 1 : 0);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], depth: childDepth,
        guides: i < kids.length - 1 ? [...current.guides, childDepth] : current.guides });
    }
  }
  for (const node of children.get(null) || []) walk(node, 0);
  // Malformed cyclic metadata must neither loop nor hide an entire family.
  for (const node of all.values()) if (!visited.has(node.id)) { node.parentId = null; walk(node, 0); }
  nodes.forEach((n, i) => { n.index = i; });
  return nodes;
}

module.exports = { ADAPTERS, byId, forAgent, detect, findSession, listSessions, buildGraph, flatten, sharedPrefix, forkInfo };
