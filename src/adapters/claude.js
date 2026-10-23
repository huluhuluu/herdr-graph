"use strict";

// Claude Code session adapter.
//
// Layout: ~/.claude/projects/<project-slug>/<sessionId>.jsonl
// Every message record has `uuid` + `parentUuid`, forming an in-file DAG. A
// rewind/re-send produces a node with two non-sidechain user children -- that
// is the branch shape we render.
//
// Cross-session lineage is written by the `/branch` command (and
// `--fork-session`) as a top-level `forkedFrom: { sessionId, messageUuid }`
// field. Verified present in the Claude Code 2.1.285 binary; absent from files
// when the user has never branched.
//
// Noise that MUST be filtered:
//   - records whose content blocks are all type "tool_result" (not human text)
//   - isSidechain === true (subagent sidechains)
//   - <local-command-caveat> / <command-name> / <local-command-stdout> wrappers
//   - system/compact_boundary (a compaction, not a branch)

const fs = require("node:fs");
const path = require("node:path");
const { oneLine, readHead, readTail, walkJsonl, safeStat, homeDir, validateSessionMeta } = require("../util");
const { isHumanText } = require("../noise");
const { textBlocks } = require("../progress");
const { eachRecord } = require("./codex");
const { sessionEnv } = require("../paths");

const AGENT = "claude";

function sessionRoots(env = process.env) {
  env = sessionEnv(env);
  return [path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir(env), ".claude"), "projects")];
}

function sessionIdFromFile(file) {
  return path.basename(file, ".jsonl");
}

function projectSlug(file) {
  return path.basename(path.dirname(file));
}

function listSessionFiles(env = process.env) {
  const out = [];
  for (const root of sessionRoots(env)) {
    if (fs.existsSync(root)) out.push(...walkJsonl(root).filter(file =>
      /^[0-9a-f-]{36}\.jsonl$/i.test(path.basename(file)) && !file.split(path.sep).includes("subagents")));
  }
  return out;
}

function blocksToText(content) {
  return textBlocks(content);
}

function readMeta(file) {
  const head = readHead(file, 64 * 1024);
  let first = null;
  let forkedFrom = null;
  let cwd = "";
  let version = null;
  let gitBranch = null;
  let metaSessionId = null;
  let title = "", preview = "";

  for (const line of head) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    if (!first) first = o;
    if (!forkedFrom && o.forkedFrom && typeof o.forkedFrom === "object") forkedFrom = o.forkedFrom;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!version && o.version) version = o.version;
    if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
    if (!metaSessionId && o.sessionId) metaSessionId = o.sessionId;
    if (!preview && o.type === "user" && !o.isSidechain && isHumanText(blocksToText(o.message?.content), AGENT)) {
      preview = oneLine(blocksToText(o.message?.content));
    }
  }

  for (const line of readTail(file)) {
    try {
      const o = JSON.parse(line);
      if (o.type === "custom-title" && o.sessionId === sessionIdFromFile(file)) title = o.customTitle || "";
      if (!title && o.type === "ai-title") title = o.aiTitle || "";
    } catch {}
  }
  try {
    const sidecar = path.join(path.dirname(file), sessionIdFromFile(file), "custom-title.json");
    title = JSON.parse(fs.readFileSync(sidecar, "utf8")).customTitle || title;
  } catch {}

  return validateSessionMeta({
    agent: AGENT,
    // The filename is the identity Herdr reports as agent_session.value, so it
    // is authoritative; the in-record sessionId is kept for reference only.
    sessionId: sessionIdFromFile(file),
    metaSessionId,
    file,
    title: oneLine(title || preview || sessionIdFromFile(file).slice(0, 8)),
    project: projectSlug(file),
    cwd,
    version,
    gitBranch,
    timestamp: first?.timestamp || null,
    parentSessionId: forkedFrom?.sessionId || null,
    forkMessageUuid: forkedFrom?.messageUuid || null,
  });
}

// Build the in-file DAG and reduce it to human turns.
function parseTurns(file) {
  const records = [];
  eachRecord(file, o => {
    if (o.uuid) records.push(o);
  });

  const byUuid = new Map();
  for (const r of records) byUuid.set(r.uuid, r);

  // A node is "human" when it is a user record with real prose.
  function isHuman(r) {
    if (r.type !== "user") return false;
    if (r.isSidechain === true) return false;
    if (r.isMeta === true) return false;
    // A compaction summary is machine-written and marks a continuation of the
    // same logical conversation, not a new turn. Filtering it here is safe:
    // the next human message's parentUuid points at it, so
    // nearestHumanAncestor walks straight past to the previous real turn.
    if (r.isCompactSummary === true) return false;
    return isHumanText(blocksToText(r.message?.content), AGENT);
  }

  // Resolve the effective parent, following compact_boundary redirection.
  function parentOf(r) {
    if (r.type === "system" && r.subtype === "compact_boundary" && r.logicalParentUuid) {
      return r.logicalParentUuid;
    }
    return r.parentUuid || null;
  }

  const humans = records.filter(isHuman);
  if (!humans.length) return [];
  const humanIds = new Set(humans.map(r => r.uuid));

  // Child map over human nodes: the nearest human ancestor of each human.
  function nearestHumanAncestor(r) {
    let cur = parentOf(r);
    const guard = new Set();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const p = byUuid.get(cur);
      if (!p) return null;
      if (humanIds.has(cur)) return cur;
      cur = parentOf(p);
    }
    return null;
  }

  const childrenOf = new Map();
  const parentOfHuman = new Map();
  for (const h of humans) {
    const pa = nearestHumanAncestor(h);
    parentOfHuman.set(h.uuid, pa);
    if (!childrenOf.has(pa)) childrenOf.set(pa, []);
    childrenOf.get(pa).push(h.uuid);
  }

  function descendantsUntilHuman(startUuid) {
    const out = [];
    const seen = new Set();
    const stack = [...(childrenOfRaw.get(startUuid) || [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const r = byUuid.get(id);
      if (!r) continue;
      if (humanIds.has(id)) continue; // stop at the next turn
      out.push(r);
      for (const c of childrenOfRaw.get(id) || []) stack.push(c);
    }
    return out;
  }

  // Raw child map over all records (parentUuid), excluding sidechains.
  const childrenOfRaw = new Map();
  for (const r of records) {
    if (r.isSidechain === true) continue;
    const p = parentOf(r);
    if (!p) continue;
    if (!childrenOfRaw.has(p)) childrenOfRaw.set(p, []);
    childrenOfRaw.get(p).push(r.uuid);
  }

  // Depth-first order so the tree renders parent -> children in time order.
  const roots = humans
    .filter(h => !parentOfHuman.get(h.uuid))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  const turns = [];
  const visited = new Set();
  function walk(start) {
    const stack = [{ uuid: start, depth: 0 }];
    while (stack.length) {
      const { uuid, depth } = stack.pop();
      if (visited.has(uuid)) continue;
      visited.add(uuid);
      const r = byUuid.get(uuid);
      const prompt = blocksToText(r.message?.content).trim();
      const descendants = descendantsUntilHuman(uuid);
      const reply = dedupe(descendants.filter(record => record.type === "assistant")
        .map(record => blocksToText(record.message?.content).trim())).join("\n\n").trim();
      turns.push({
        agent: AGENT,
        key: uuid,
        depth,
        parentKey: parentOfHuman.get(uuid) || null,
        messageUuids: [uuid, ...descendants.map(record => record.uuid)],
        timestamp: r.timestamp || null,
        prompt: oneLine(prompt),
        reply: oneLine(reply),
        promptFull: prompt,
        replyFull: reply,
        branchCount: (childrenOf.get(uuid) || []).length,
      });
      const kids = (childrenOf.get(uuid) || []).sort((a, b) =>
        String(byUuid.get(a).timestamp).localeCompare(String(byUuid.get(b).timestamp)));
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ uuid: kids[i], depth: depth + 1 });
    }
  }

  for (const r of roots) walk(r.uuid);
  // Any human node orphaned by a missing ancestor still belongs in the graph.
  for (const h of humans) if (!visited.has(h.uuid)) walk(h.uuid);

  // Reindex after DFS ordering.
  turns.forEach((t, i) => { t.index = i; });
  return turns;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = s.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function* scanSessions(env = process.env) {
  for (const file of listSessionFiles(env)) {
    const st = safeStat(file);
    if (!st) continue;
    try {
      const meta = readMeta(file);
      if (meta) yield { ...meta, mtime: st.mtimeMs, size: st.size };
    } catch (error) {
      const sessionId = sessionIdFromFile(file);
      yield { agent: AGENT, sessionId, file, cwd: "", title: sessionId.slice(0, 8),
        mtime: st.mtimeMs, size: st.size, readError: error.message };
    }
  }
}

function listSessions(env = process.env) {
  return [...scanSessions(env)].sort((a, b) => b.mtime - a.mtime);
}

module.exports = {
  id: AGENT,
  label: "Claude Code",
  sessionRoots,
  listSessionFiles,
  sessionIdFromFile,
  readMeta,
  parseTurns,
  listSessions,
  scanSessions,
};
