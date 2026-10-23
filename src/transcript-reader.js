"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");
const { ProgressLog, textBlocks } = require("./progress");
const { frames } = require("./adapters/dst");
const yieldIO = () => new Promise(resolve => setImmediate(resolve));
const MAX_RECORD = 64 * 1024 * 1024;

// One instance belongs to one live subscription in the existing loader worker.
class TranscriptReader {
  constructor(agent, file) {
    this.agent = agent;
    this.file = file;
    this.sourceEpoch = 0;
    this.revision = 0;
    this.bytesRead = 0;
    this.cancelled = false;
    this.reset();
  }
  reset() {
    this.log = new ProgressLog(this.agent);
    this.offset = 0;
    this.carry = Buffer.alloc(0);
    this.lineNo = 0;
    this.provisional = null;
    this.signature = null;
    this.boundary = null;
    this.invalidRecords = 0;
    this.windowIds = new Set();
    this.sourceEpoch++;
  }
  cancel() { this.cancelled = true; }
  sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
  async check({ revalidate = false } = {}) {
    if (this.cancelled) return null;
    const fd = fs.openSync(this.file, "r");
    try {
      const stat = fs.fstatSync(fd), previous = this.signature;
      let reset = !previous;
      if (previous && (!this.sameFile(previous, stat) || stat.size < this.offset || revalidate ||
        (stat.size === previous.size && (stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs)))) reset = true;
      if (!reset && this.boundary) {
        const sample = Buffer.alloc(this.boundary.length);
        fs.readSync(fd, sample, 0, sample.length, this.offset - sample.length);
        if (!sample.equals(this.boundary)) reset = true;
      }
      if (reset) this.reset();
      this.log.collect = !reset;
      const readStart = this.offset;
      const target = stat.size;
      const buffer = this.offset < target ? Buffer.alloc(1024 * 1024) : null;
      while (this.offset < target) {
        if (this.cancelled) return null;
        const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, target - this.offset), this.offset);
        if (!n) break;
        const start = this.offset - this.carry.length;
        this.offset += n;
        this.bytesRead += n;
        this.carry = Buffer.concat([this.carry, buffer.subarray(0, n)]);
        if (this.file.endsWith(".zstd")) this.decodeFrames();
        else this.decodeLines(start);
        this.log.compact();
        if (this.carry.length > MAX_RECORD) throw new Error("A pending log record/frame exceeds the 64 MiB reading limit.");
        await yieldIO();
      }
      if (!this.file.endsWith(".zstd") && this.carry.length && this.offset !== readStart) {
        // EOF without newline is legal. Keep bytes until newline, and upsert by
        // location so finishing that line cannot produce a duplicate message.
        this.record(this.carry, this.offset - this.carry.length, true);
      }
      this.log.compact();
      if (this.cancelled) return null;
      const after = fs.fstatSync(fd), named = fs.statSync(this.file);
      if (!this.sameFile(stat, after) || !this.sameFile(after, named) || after.size < target ||
        (after.size === target && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs))) {
        this.reset();
        throw new Error("Session file changed while reading; retrying on the next check.");
      }
      const sample = Buffer.alloc(Math.min(256, this.offset));
      fs.readSync(fd, sample, 0, sample.length, this.offset - sample.length);
      this.boundary = sample;
      // Keep the start signature: writes arriving during this read are checked
      // again rather than treated as already consumed.
      this.signature = stat;
      const upserts = this.log.drain().filter(m => m.text !== undefined || this.windowIds.has(m.id));
      const changed = reset || target !== previous?.size || upserts.length > 0;
      if (changed) this.revision++;
      return { reset, upserts, revision: this.revision, sourceEpoch: this.sourceEpoch,
        changed, invalidRecords: this.invalidRecords };
    } catch (error) {
      this.reset();
      throw error;
    } finally { fs.closeSync(fd); }
  }
  decodeLines(start) {
    let from = 0, at;
    while ((at = this.carry.indexOf(10, from)) >= 0) {
      this.record(this.carry.subarray(from, at), start + from);
      from = at + 1;
    }
    this.carry = this.carry.subarray(from);
  }
  record(buffer, location, provisional = false, reference = null) {
    if (buffer.length > MAX_RECORD) throw new Error("A log record exceeds the 64 MiB reading limit.");
    const text = buffer.toString("utf8").trim();
    if (!text) { if (!provisional) this.lineNo++; return; }
    const hash = provisional || this.provisional?.location === location ? createHash("sha256").update(text).digest("hex") : null;
    if (this.provisional?.location === location && this.provisional.hash === hash) {
      if (!provisional) { this.provisional = null; this.lineNo++; }
      return;
    }
    let row;
    try { row = JSON.parse(text); } catch {
      if (!provisional) { this.invalidRecords++; this.lineNo++; }
      return;
    }
    this.log.accept(row, location, this.lineNo + 1, reference || { offset: location, length: buffer.length });
    if (provisional) this.provisional = { location, hash };
    else this.lineNo++;
  }
  decodeFrames() {
    if (!zlib.zstdDecompressSync) throw new Error("DST compressed sessions require Node.js 22.15+ or 24+.");
    const complete = frames(this.carry);
    let consumed = 0;
    for (const frame of complete) {
      if (frame.length > MAX_RECORD) throw new Error("A compressed frame exceeds the 64 MiB reading limit.");
      const location = this.offset - this.carry.length + consumed;
      const decoded = zlib.zstdDecompressSync(frame, { maxOutputLength: MAX_RECORD });
      let line = 0;
      for (const text of decoded.toString("utf8").split("\n")) {
        this.record(Buffer.from(text), `${location}:${line}`, false, { frame: location, frameLength: frame.length, line: line++ });
      }
      consumed += frame.length;
    }
    this.carry = this.carry.subarray(consumed);
  }
  window(options) {
    if (!this.signature) throw new Error("Session snapshot is not ready; refresh after synchronization succeeds.");
    const result = this.log.window(options);
    if (result.messages.every(m => m.text !== undefined)) { this.trackWindow(result, options); return result; }
    const fd = fs.openSync(this.file, "r"), decoded = new Map();
    try {
      this.verifyHistoryFile(fd);
      result.messages = result.messages.map(message => {
        if (message.text !== undefined) return message;
        const ref = message.record;
        let row;
        if (ref.frame !== undefined) {
          if (!decoded.has(ref.frame)) {
            const bytes = Buffer.alloc(ref.frameLength);
            if (fs.readSync(fd, bytes, 0, bytes.length, ref.frame) !== bytes.length) throw new Error("Session file changed; refresh its history.");
            if (decoded.size >= 2) decoded.clear();
            decoded.set(ref.frame, zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_RECORD }).toString("utf8").split("\n"));
          }
          row = JSON.parse(decoded.get(ref.frame)[ref.line]);
        } else {
          const bytes = Buffer.alloc(ref.length);
          if (fs.readSync(fd, bytes, 0, bytes.length, ref.offset) !== bytes.length) throw new Error("Session file changed; refresh its history.");
          row = JSON.parse(bytes.toString("utf8"));
        }
        const p = row.payload || {};
        const text = this.agent === "codex" ? (typeof p.message === "string" ? p.message : textBlocks(p.content, ["input_text", "output_text"]))
          : this.agent === "claude" ? textBlocks(row.message?.content) : textBlocks(row.data?.message?.content);
        return { ...message, text: text.trim() };
      });
      this.verifyHistoryFile(fd);
      this.trackWindow(result, options);
      return result;
    } finally { fs.closeSync(fd); }
  }
  trackWindow(result, options) {
    const ids = result.messages.map(m => m.id);
    this.windowIds = new Set(options?.after ? [...this.windowIds, ...ids].slice(-400)
      : (options?.before ? [...ids, ...this.windowIds] : ids).slice(0, 400));
  }
  verifyHistoryFile(fd) {
    const stat = fs.fstatSync(fd), named = fs.statSync(this.file), saved = this.signature;
    if (!this.sameFile(saved, stat) || !this.sameFile(stat, named) || stat.size < saved.size ||
      (stat.size === saved.size && (stat.mtimeMs !== saved.mtimeMs || stat.ctimeMs !== saved.ctimeMs))) {
      throw new Error("Session file changed; refresh before loading indexed history.");
    }
    if (this.boundary) {
      const bytes = Buffer.alloc(this.boundary.length);
      if (fs.readSync(fd, bytes, 0, bytes.length, this.offset - bytes.length) !== bytes.length || !bytes.equals(this.boundary)) {
        throw new Error("Session file changed; refresh before loading indexed history.");
      }
    }
  }
}

module.exports = { TranscriptReader };
