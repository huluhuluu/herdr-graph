"use strict";

// DeepSeek Harness JSONL generations. Each Zstandard frame is one append batch.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { homeDir, oneLine, safeStat, validateSessionMeta } = require("../util");
const { isHumanText } = require("../noise");
const { textBlocks } = require("../progress");
const { sessionEnv } = require("../paths");
const META = new Map();

function sessionRoots(env = process.env) {
  env = sessionEnv(env);
  return [path.join(env.DSH_HOME || path.join(homeDir(env), ".dsh"), "sessions")];
}

function listSessionFiles(env = process.env) {
  const files = new Map(), stack = [...sessionRoots(env)];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        const version = Number(entry.name.match(/\.v(\d+)\./)?.[1] || 0);
        const key = /session\.v\d+\./.test(entry.name) ? dir : file;
        if (!files.has(key) || files.get(key).version < version) files.set(key, { file, version });
      }
    }
  }
  return [...files.values()].map(entry => entry.file);
}

function sessionIdFromFile(file) {
  return /^session\.v\d+\./.test(path.basename(file)) ? path.basename(path.dirname(file))
    : path.basename(file).replace(/\.jsonl(?:\.zstd)?$/, "");
}

// Frame boundaries follow the Zstandard format used by DSH's persistence backend.
// A torn final append is ignored; complete corrupt frames surface an error.
function frames(buffer) {
  const out = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const start = offset;
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new Error("Invalid Zstandard frame.");
    const descriptor = buffer[offset + 4];
    if (descriptor & 24) throw new Error("Invalid Zstandard frame header.");
    const single = descriptor & 32;
    const sizeFlag = descriptor >>> 6;
    const dictFlag = descriptor & 3;
    offset += 5 + (single ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) +
      (sizeFlag ? 1 << sizeFlag : single ? 1 : 0);
    let complete = false;
    while (offset + 3 <= buffer.length) {
      const block = buffer.readUIntLE(offset, 3);
      const kind = (block >>> 1) & 3;
      if (kind === 3) throw new Error("Invalid Zstandard block.");
      offset += 3 + (kind === 1 ? 1 : block >>> 3);
      if (offset > buffer.length) break;
      if (block & 1) { complete = true; break; }
    }
    if (!complete) break;
    if (descriptor & 4) offset += 4;
    if (offset > buffer.length) break;
    out.push(buffer.subarray(start, offset));
  }
  return out;
}

function batches(file) {
  const buffer = fs.readFileSync(file);
  if (!file.endsWith(".zstd")) return [buffer];
  if (!zlib.zstdDecompressSync) throw new Error("DST compressed sessions require Node.js with Zstandard support (22.15+ or 24+).");
  return frames(buffer);
}

function records(batch, compressed) {
  const text = (compressed ? zlib.zstdDecompressSync(batch) : batch).toString("utf8");
  return text.split("\n").flatMap(line => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      return row && typeof row === "object" && !Array.isArray(row) ? [row] : [];
    } catch { return []; }
  });
}

function readMeta(file) {
  const st = safeStat(file);
  const saved = META.get(file);
  if (saved && saved.mtime === st?.mtimeMs && saved.size === st?.size) return saved.meta;
  const parts = batches(file), compressed = file.endsWith(".zstd");
  const header = records(parts[0] || Buffer.alloc(0), compressed)[0];
  if (header?.type !== "session") return null;
  let title = "", forkOrdinalExclusive = null;
  for (let i = parts.length - 1; i >= 0 && (!title || (header.isSeeded && forkOrdinalExclusive === null)); i--) {
    const rows = records(parts[i], compressed);
    title ||= rows.findLast(o => o.type === "session/title")?.data?.title || "";
    const cut = rows.findLast(o => o.type === "session/end-seed" && o.data?.inherited === true);
    if (forkOrdinalExclusive === null && Number.isFinite(cut?.seq)) forkOrdinalExclusive = cut.seq;
  }
  const meta = validateSessionMeta({
    agent: "dst", sessionId: header.id || sessionIdFromFile(file), file,
    title: oneLine(title || header.id?.slice(0, 8) || "DST"),
    cwd: header.cwd || "", version: header.version,
    timestamp: Number.isFinite(header.createdAt) ? new Date(header.createdAt).toISOString() : null,
    parentSessionId: header.parentSession || null,
    forkOrdinalExclusive,
  });
  META.set(file, { meta, mtime: st?.mtimeMs, size: st?.size });
  return meta;
}

function textOf(content) {
  return textBlocks(content);
}

function parseTurns(file) {
  const turns = [];
  let current = null;
  for (const batch of batches(file)) for (const o of records(batch, file.endsWith(".zstd"))) {
    const data = o.data || {};
    if (o.type === "user/message") {
      const prompt = textOf(data.content).trim();
      if (data.source?.kind !== "user" || !isHumanText(prompt, "dst")) continue;
      current = { agent: "dst", key: String(o.seq), timestamp: Number.isFinite(o.time) ? new Date(o.time).toISOString() : null,
        ordStart: o.seq, ordEnd: o.seq,
        prompt: oneLine(prompt), promptFull: prompt, reply: "", replyFull: "" };
      turns.push(current);
    } else if (o.type === "assistant/message" && current) {
      const reply = textOf(data.message?.content).trim();
      if (reply) {
        current.ordEnd = o.seq;
        current.replyFull += (current.replyFull ? "\n\n" : "") + reply;
        current.reply = oneLine(current.replyFull);
      }
    }
  }
  return turns;
}

function* scanSessions(env = process.env) {
  for (const file of listSessionFiles(env)) {
    const st = safeStat(file);
    if (!st) continue;
    try { const meta = readMeta(file); if (meta) yield { ...meta, mtime: st.mtimeMs, size: st.size }; }
    catch (error) {
      yield { agent: "dst", sessionId: sessionIdFromFile(file), file, cwd: "", title: sessionIdFromFile(file).slice(0, 8),
        mtime: st.mtimeMs, size: st.size, readError: error.message };
    }
  }
}

function listSessions(env = process.env) {
  return [...scanSessions(env)].sort((a, b) => b.mtime - a.mtime);
}

module.exports = {
  id: "dst", label: "DST", sessionRoots, sessionIdFromFile, listSessionFiles,
  readMeta, parseTurns, listSessions, scanSessions, frames, records,
};
