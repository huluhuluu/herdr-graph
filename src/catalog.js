"use strict";

const path = require("node:path");

function directoryKey(cwd) {
  if (!cwd) return "";
  // Normalize Windows paths even when browsing copied records on Unix.
  if (/^[a-z]:[\\/]|^\\\\/i.test(cwd)) return path.win32.normalize(cwd).replace(/[\\/]+$/, "").toLowerCase();
  return path.posix.normalize(cwd).replace(/\/$/, "") || "/";
}

function filterSessions(nodes, { agent = "all", search = null } = {}) {
  const query = (search || "").toLowerCase();
  return nodes.filter(n => (agent === "all" || n.agent === agent) && (!query ||
    `${n.title || ""} ${n.sessionId} ${n.cwd || ""} ${n.agent}`.toLowerCase().includes(query)));
}

function catalogRows(nodes, { view = "directory", order = "newest", expanded = new Set(), collapsed = new Set() } = {}) {
  const direction = order === "oldest" ? 1 : -1;
  const compare = (a, b) => direction * (Date.parse(a.timestamp) - Date.parse(b.timestamp)) || a.id.localeCompare(b.id);
  const sorted = [...nodes].sort(compare);
  if (view === "time") return sorted.map(node => ({ ...node, parentId: null, branchCount: 0, depth: 0 }));
  const groups = new Map();
  for (const node of sorted) {
    const key = directoryKey(node.cwd);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const directories = [...groups].map(([key, sessions]) => ({
    id: `directory:${key}`, directoryOnly: true, directoryKey: key,
    cwd: sessions[0].cwd || "", sessionCount: sessions.length,
    // Directory ordering always reflects its latest session activity.
    timestamp: sessions.reduce((latest, n) => n.timestamp > latest ? n.timestamp : latest, ""),
    expanded: expanded.has(key), depth: 0,
  })).sort(compare);
  function tree(sessions) {
    const byId = new Map(sessions.map(n => [n.id, n]));
    const children = new Map();
    for (const node of sessions) {
      const parent = byId.has(node.parentId) && node.parentId !== node.id ? node.parentId : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(node);
    }
    const rows = [], seen = new Set();
    function walk(node, depth, parentId, visible = true) {
      const stack = [{ node, depth, parentId, visible }];
      while (stack.length) {
        const item = stack.pop();
        if (seen.has(item.node.id)) continue;
        seen.add(item.node.id);
        const kids = (children.get(item.node.id) || []).filter(n => !seen.has(n.id));
        if (item.visible) rows.push({ ...item.node, depth: item.depth, parentId: item.parentId, branchCount: kids.length });
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], depth: item.depth + 1,
          parentId: item.node.id, visible: item.visible && !collapsed.has(item.node.id) });
      }
    }
    for (const node of children.get(null) || []) walk(node, 1, null);
    for (const node of sessions) if (!seen.has(node.id)) walk(node, 1, null);
    return rows;
  }
  return directories.flatMap(group => [group, ...(group.expanded ? tree(groups.get(group.directoryKey)) : [])]);
}

module.exports = { directoryKey, filterSessions, catalogRows };
