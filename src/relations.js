"use strict";

const { forkInfo, sharedPrefix, flatten } = require("./adapters");
const { oneLine } = require("./util");

function recordsFor(graph) {
  if (graph?.sessionMeta) return graph.sessionMeta;
  const records = new Map();
  for (const entry of graph?.sessions?.values() || []) {
    const agent = entry.agent || entry.adapter?.id;
    records.set(`${agent}:${entry.sessionId}`, { ...entry.meta, agent, sessionId: entry.sessionId, file: entry.file });
  }
  for (const node of graph?.nodes || []) {
    const key = `${node.agent}:${node.sessionId}`;
    if (!records.has(key)) records.set(key, node);
  }
  return records;
}

// Session edges always follow native parent IDs. Turn anchors may point to an
// earlier ancestor's shared history and must never replace these edges.
function familyRows(graph, agent, sessionId, collapsed = new Set()) {
  const records = new Map([...recordsFor(graph)].filter(([, meta]) => meta.agent === agent));
  const focusKey = `${agent}:${sessionId}`;
  if (!records.has(focusKey)) return [];
  let rootKey = focusKey;
  const ancestors = new Set([rootKey]);
  for (;;) {
    const parentId = records.get(rootKey)?.parentSessionId;
    if (!parentId) break;
    const parentKey = `${agent}:${parentId}`;
    if (ancestors.has(parentKey)) break;
    ancestors.add(parentKey);
    if (!records.has(parentKey)) records.set(parentKey, { agent, sessionId: parentId, title: "(not on disk)", missing: true });
    rootKey = parentKey;
  }
  const children = new Map();
  for (const [key, meta] of records) {
    const parentKey = `${agent}:${meta.parentSessionId}`;
    if (!meta.parentSessionId || key === rootKey || parentKey === key) continue;
    if (!children.has(parentKey)) children.set(parentKey, []);
    children.get(parentKey).push(key);
  }
  for (const keys of children.values()) keys.sort((a, b) => {
    const time = key => Date.parse(records.get(key).timestamp) || records.get(key).mtime || 0;
    return time(a) - time(b) || a.localeCompare(b);
  });
  const rows = [], visited = new Set();
  const stack = [{ key: rootKey, depth: 0, parentId: null, guides: [], last: true }];
  while (stack.length) {
    const item = stack.pop();
    if (visited.has(item.key)) continue;
    visited.add(item.key);
    const meta = records.get(item.key);
    const kids = (children.get(item.key) || []).filter(key => !visited.has(key));
    const id = `${item.key}#session`;
    rows.push({ ...meta, id, sessionKey: item.key, key: "session", prompt: meta.title || meta.sessionId,
      sessionBoundary: true, parentId: item.parentId, depth: item.depth, guideDepths: item.guides,
      isLast: item.last, branchCount: kids.length, index: rows.length, folded: collapsed.has(id) });
    if (collapsed.has(id)) continue;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ key: kids[i], depth: item.depth + 1, parentId: id,
      last: i === kids.length - 1, guides: item.last ? item.guides : [...item.guides, item.depth] });
  }
  return rows;
}

function pathTo(rows, sessionId) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const path = new Set();
  let row = rows.find(row => row.sessionId === sessionId);
  while (row && !path.has(row.id)) { path.add(row.id); row = byId.get(row.parentId); }
  return path;
}

function previewRows(rows, sessionId) {
  const target = rows.find(row => row.sessionId === sessionId);
  if (!target) return [];
  const keep = pathTo(rows, sessionId);
  for (const row of rows.filter(row => row.parentId === target.parentId && row.id !== target.id).slice(0, 2)) keep.add(row.id);
  for (const row of rows.filter(row => row.parentId === target.id).slice(0, 2)) keep.add(row.id);
  return rows.filter(row => keep.has(row.id));
}

function edgeInfo(row, records, getTurns) {
  const turns = getTurns(row, false);
  const parent = row.parentSessionId ? records.get(`${row.agent}:${row.parentSessionId}`) : null;
  const parentTurns = parent ? getTurns(parent, false) : null;
  const sharedTurns = row.parentSessionId ? (turns && parentTurns ? sharedPrefix(parentTurns, turns) : null) : 0;
  const point = parentTurns ? forkInfo(parentTurns, row, sharedTurns || 0) : { turn: null, number: null, location: "unknown" };
  return { ...point, sharedTurns, addedTurns: turns && sharedTurns !== null ? turns.length - sharedTurns : null,
    totalTurns: turns?.length ?? null, parentUnavailable: !!row.parentSessionId && !parent,
    pending: !!parent && !parentTurns };
}

function formatTime(timestamp) {
  const ms = timestamp == null ? NaN : Date.parse(timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC" : null;
}

function shortIds(records) {
  const groups = new Map();
  for (const id of new Set([...records].flatMap(meta => [meta.sessionId, meta.parentSessionId]).filter(Boolean))) {
    const prefix = id.slice(0, 8);
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(id);
  }
  const labels = new Map();
  for (const ids of groups.values()) for (const id of ids) {
    if (ids.length === 1) { labels.set(id, id.slice(0, 8)); continue; }
    let size = 4;
    while (size < id.length && ids.some(other => other !== id && other.endsWith(id.slice(-size)))) size++;
    labels.set(id, `${id.slice(0, 4)}…${id.slice(-size)}`);
  }
  return labels;
}

function branchLabel(info) {
  if (info.error) return `could not read fork point: ${info.error}`;
  if (info.parentUnavailable) return "parent not on disk";
  if (info.pending) return "fork point not loaded";
  if (!info.turn) return "fork point not recorded";
  return `turn ${info.number} · ${oneLine(info.turn.prompt || info.turn.promptFull || info.turn.reply || "(no text)")}`;
}

// The detailed view uses the same verified fork anchors as the turn graph.
// Keep unloaded/empty/missing sessions as headers while their turns arrive.
function familyContentRows(graph, getContent) {
  const family = familyRows(graph, graph.focusAgent, graph.focusSessionId);
  const sessions = new Map(family.map(row => {
    const content = row.missing ? null : getContent(row);
    return [row.sessionKey, { key: row.sessionKey, agent: row.agent, sessionId: row.sessionId,
      file: row.file, meta: row, turns: content?.turns || [], loaded: !!content,
      missing: row.missing, error: content?.error }];
  }));
  const root = sessions.get(graph.focusKey) || sessions.values().next().value;
  if (!root) return [];
  const rows = flatten(sessions, root, "lineage", recordsFor(graph));
  const numbers = new Map([...sessions.values()].flatMap(entry => entry.turns.map((turn, index) => [`${entry.key}#${turn.key}`, index + 1])));
  return rows.map(row => {
    const entry = sessions.get(row.sessionKey);
    return { ...row, turnNumber: numbers.get(row.id), missing: entry.missing,
      contentState: entry.missing ? "missing" : entry.error ? "read error" : !entry.loaded ? "loading…" : !entry.turns.length ? "empty" : null };
  });
}

module.exports = { recordsFor, familyRows, familyContentRows, pathTo, previewRows, edgeInfo, formatTime, shortIds, branchLabel };
