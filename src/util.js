"use strict";

const fs = require("node:fs");
const path = require("node:path");

// --- display width (CJK counts as 2) -------------------------------------
function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

function width(str) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch.codePointAt(0));
  return w;
}

// Truncate to a display width, adding an ellipsis when cut.
function truncate(str, max) {
  const s = String(str ?? "");
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

function pad(str, max) {
  const t = truncate(str, max);
  return t + " ".repeat(Math.max(0, max - width(t)));
}

// Collapse whitespace and strip control chars for single-line display.
function oneLine(str) {
  return String(str ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function wrap(text, max) {
  const lines = [];
  if (max <= 1) return [String(text ?? "")];
  for (const para of String(text ?? "").split("\n")) {
    if (!para) { lines.push(""); continue; }
    let cur = "";
    let curW = 0;
    for (const ch of para) {
      const cw = charWidth(ch.codePointAt(0));
      if (curW + cw > max) { lines.push(cur); cur = ""; curW = 0; }
      cur += ch;
      curW += cw;
    }
    lines.push(cur);
  }
  return lines;
}

// --- filesystem ----------------------------------------------------------
function walkJsonl(root, limit = 20000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  return out;
}

function readHead(file, lines = 1) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(1024 * 256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").split("\n").slice(0, lines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || require("node:os").homedir();
}

function readTail(file, bytes = 1024 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(Math.min(bytes, size));
    const n = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, n).toString("utf8");
    return (start ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
  } finally { fs.closeSync(fd); }
}

module.exports = { width, truncate, pad, oneLine, wrap, charWidth, walkJsonl, readHead, readTail, safeStat, homeDir };
