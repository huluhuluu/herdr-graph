"use strict";

// Codex session adapter.
//
// Layout: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<iso>-<session_id>.jsonl
// Line 1 is session_meta and carries the fork lineage:
//   { session_id, id, forked_from_id, forked_from_ordinal_exclusive, cwd, ... }
// Every record is { timestamp, ordinal, type, payload }.
//
// Turns are delimited by event_msg/task_started .. task_complete, both of which
// carry payload.turn_id. Message records do NOT carry turn_id (verified on
// cli_version 0.154.0), so a message belongs to the turn whose ordinal range
// contains it.
//
// Files get large on this machine (the biggest is 446 MB, 1.4 GB total), so the
// parser streams lines instead of reading the whole file into memory.

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { oneLine, readHead, walkJsonl, safeStat, homeDir } = require("../util");
const { isHumanText } = require("../noise");
const { sessionEnv } = require("../paths");

const AGENT = "codex";

function sessionRoots(env = process.env) {
  env = sessionEnv(env);
  const home = env.CODEX_HOME || path.join(homeDir(env), ".codex");
  return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
}

function sessionIdFromFile(file) {
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

function listSessionFiles(env = process.env) {
  const out = [];
  for (const root of sessionRoots(env)) {
    if (fs.existsSync(root)) out.push(...walkJsonl(root));
  }
  return out;
}

// Cheap metadata read: only the first few KB are needed for session_meta.
//
// Identity note (measured on this machine): 74 of 169 rollouts have a
// `session_meta.session_id` that differs from the uuid in their filename, and
// 59 of those inherited their PARENT's id. The filename uuid is the only
// reliable identity -- it is unique across all 169 files, it is what Herdr
// reports as agent_session.value, and parent links resolve 66/66 by it (only
// 64/66 by meta id). So `sessionId` is always taken from the filename, and the
// meta value is kept separately.
function sessionNames(env = process.env) {
  env = sessionEnv(env);
  const names = new Map();
  const file = path.join(env.CODEX_HOME || path.join(homeDir(env), ".codex"), "session_index.jsonl");
  try {
    eachRecord(file, o => {
      if (o.id && typeof o.thread_name === "string") names.set(o.id, o.thread_name);
    });
  } catch {
    // Missing/unreadable title indexes must not hide readable session files.
  }
  return names;
}

function readMeta(file, names = null, env = process.env) {
  names ||= sessionNames(env);
  const head = readHead(file, 8 * 1024);
  let meta = null;
  for (const line of head) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === "session_meta" && o.payload) { meta = o.payload; break; }
  }
  if (!meta) return null;
  const fileId = sessionIdFromFile(file);
  if (!fileId) return null;
  let preview = "";
  for (const line of head) {
    try {
      const o = JSON.parse(line), p = o.payload || {};
      const text = p.type === "user_message" ? p.message : p.role === "user"
        ? (p.content || []).filter(b => b.type === "input_text").map(b => b.text).join("\n") : "";
      if (text && isHumanText(text, AGENT)) { preview = oneLine(text); break; }
    } catch {}
  }
  return {
    agent: AGENT,
    sessionId: fileId,
    metaSessionId: meta.session_id || meta.id || null,
    file,
    title: names.get(fileId) || preview || fileId.slice(0, 8),
    archived: file.split(path.sep).includes("archived_sessions"),
    cwd: meta.cwd || "",
    timestamp: meta.timestamp || null,
    cliVersion: meta.cli_version || null,
    parentSessionId: meta.forked_from_id || null,
    // Exclusive: the child's first ordinal. The parent's fork point is the last
    // turn that started strictly before this ordinal.
    forkOrdinalExclusive: Number.isFinite(meta.forked_from_ordinal_exclusive)
      ? meta.forked_from_ordinal_exclusive : null,
    parentThreadId: meta.parent_thread_id || null,
  };
}

// Yield parsed JSON records one line at a time without buffering the file.
function eachRecord(file, fn) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1024 * 1024);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let lineNo = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      carry += decoder.write(buf.subarray(0, n));
      let idx;
      while ((idx = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        lineNo++;
        if (line.trim()) {
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          if (o && typeof o === "object" && !Array.isArray(o)) fn(o, lineNo);
        }
      }
      // Guard against a pathological single line.
      if (carry.length > 64 * 1024 * 1024) carry = carry.slice(-1024);
    }
    carry += decoder.end();
    if (carry.trim()) {
      lineNo++;
      let o;
      try { o = JSON.parse(carry); } catch { o = null; }
      if (o && typeof o === "object" && !Array.isArray(o)) fn(o, lineNo);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parseTurns(file) {
  const turns = [];
  let current = null;

  function ensureTurn(ord, timestamp, turnId) {
    if (current) return current;
    current = {
      key: turnId || `ord:${ord}`,
      turnId: turnId || null,
      ordStart: ord,
      ordEnd: ord,
      timestamp: timestamp || null,
      prompts: [],
      replies: [],
    };
    turns.push(current);
    return current;
  }

  eachRecord(file, (o, lineNo) => {
    const ord = Number.isFinite(o.ordinal) ? o.ordinal : lineNo;
    const p = o.payload || {};

    if (o.type === "event_msg" && p.type === "task_started") {
      current = null;
      ensureTurn(ord, o.timestamp, p.turn_id);
      return;
    }
    if (o.type === "event_msg" && p.type === "task_complete") {
      if (current) current.ordEnd = ord;
      current = null;
      return;
    }
    // A turn the user interrupted. It usually has a prompt but no reply, and the
    // same prompt is re-sent in the next turn -- which would render as a
    // duplicate node with an empty answer.
    if (o.type === "event_msg" && p.type === "turn_aborted") {
      if (current) current.aborted = true;
      return;
    }

    if (o.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = (p.content || [])
        .filter(b => b && (b.type === "input_text" || b.type === "output_text") && typeof b.text === "string")
        .map(b => b.text)
        .join("\n")
        .trim();
      if (!text) return;
      const t = ensureTurn(ord, o.timestamp, p.turn_id);
      t.ordEnd = ord;
      if (p.role === "user") t.prompts.push(text);
      else t.replies.push(text);
      return;
    }

    // Older rollouts mirror the text in an event; use it only as a fallback.
    if (o.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") {
      const t = ensureTurn(ord, o.timestamp, p.turn_id);
      t.ordEnd = ord;
      t.prompts.push(p.message);
    } else if (o.type === "event_msg" && p.type === "agent_message" && typeof p.message === "string") {
      const t = ensureTurn(ord, o.timestamp, p.turn_id);
      t.ordEnd = ord;
      t.replies.push(p.message);
    }
  });

  const mapped = turns.map((t, i) => {
    // Prefer a real human prompt. When every candidate is injected context
    // (environment blocks, AGENTS.md, aborted turns), leave the prompt empty
    // rather than surfacing machine text as if the user had typed it.
    const raw = dedupe(t.prompts);
    const human = raw.filter(s => isHumanText(s, AGENT));
    const prompt = human.join("\n\n").trim();
    const reply = dedupe(t.replies).join("\n\n").trim();
    return {
      agent: AGENT,
      key: t.key,
      index: i,
      turnId: t.turnId,
      ordStart: t.ordStart,
      ordEnd: t.ordEnd,
      timestamp: t.timestamp,
      prompt: oneLine(prompt),
      reply: oneLine(reply),
      promptFull: prompt,
      replyFull: reply,
      aborted: t.aborted === true,
      synthetic: human.length === 0,
      // Only the first turn of a session carries the injected context preamble;
      // it is useful to know that, so the UI can label it.
      contextOnly: human.length === 0 && raw.length > 0,
    };
  });

  // An interrupted turn has a prompt but no reply, and the user's re-send
  // repeats that prompt in the following turn. Drop the empty stub so the graph
  // shows one node instead of two.
  const laterPrompts = new Set();
  const kept = [];
  for (let i = mapped.length - 1; i >= 0; i--) {
    const t = mapped[i];
    const isStub = !t.replyFull && (t.aborted || laterPrompts.has(t.promptFull));
    if (!isStub) kept.push(t);
    if (t.promptFull) laterPrompts.add(t.promptFull);
  }
  kept.reverse();
  kept.forEach((t, i) => { t.index = i; });

  // Keep turns that either carry a human prompt or have a reply worth reading.
  return kept.filter(t => t.promptFull || t.replyFull);
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

// Newest-first list of every session, for scope=all and for child discovery.
function* scanSessions(env = process.env) {
  const names = sessionNames(env);
  for (const file of listSessionFiles(env)) {
    const sessionId = sessionIdFromFile(file);
    if (!sessionId) continue;
    const st = safeStat(file);
    if (!st) continue;
    try {
      const meta = readMeta(file, names);
      if (!meta) throw new Error("Session metadata is missing or incomplete.");
      yield { ...meta, mtime: st.mtimeMs, size: st.size };
    } catch (error) {
      yield { agent: AGENT, sessionId, file, cwd: "", title: names.get(sessionId) || sessionId.slice(0, 8),
        mtime: st.mtimeMs, size: st.size, readError: error.message };
    }
  }
}

function listSessions(env = process.env) {
  return [...scanSessions(env)].sort((a, b) => b.mtime - a.mtime);
}

module.exports = {
  id: AGENT,
  label: "Codex",
  sessionRoots,
  listSessionFiles,
  sessionIdFromFile,
  readMeta,
  parseTurns,
  eachRecord,
  listSessions,
  scanSessions,
};
