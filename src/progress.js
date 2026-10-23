"use strict";

// Public message projection. Tool and reasoning blocks never enter this model.
const { isHumanText } = require("./noise");
const { oneLine } = require("./util");
const { createHash } = require("node:crypto");
const promptPreview = text => oneLine(text).slice(0, 500);

function textBlocks(content, types = ["text"]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(b => b && types.includes(b.type) && typeof b.text === "string")
    .map(b => b.text).join("\n");
}
function kindOf(p) {
  const phase = p.phase || p.channel;
  return phase === "commentary" ? "progress" : ["final", "final_answer"].includes(phase) ? "final" : "assistant";
}
function epochTime(value) {
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null;
}

class ProgressLog {
  constructor(agent) {
    this.agent = agent;
    this.messages = new Map();
    this.order = [];
    this.updates = new Map();
    this.states = new Map();
    this.nodes = new Map();
    this.mirrors = new Map();
    this.turn = null;
    this.sequence = 0;
  }
  ensureTurn(key, prompt = "") {
    if (!this.turn || this.turn.key !== key) this.turn = { key, prompt };
    else if (prompt) this.turn.prompt = prompt;
    return this.turn;
  }
  put(id, text, data) {
    const previous = this.messages.get(id);
    if (typeof text === "string" ? !text.trim() : !previous) return;
    const message = { ...previous, id, text: typeof text === "string" ? text.trim() : previous?.text, ...data };
    if (!previous) { message.order = this.sequence++; this.order.push(id); }
    if (previous && JSON.stringify(previous) === JSON.stringify(message)) return;
    this.messages.set(id, message.record && message.order < (this.compacted || 0) ? { ...message, text: undefined } : message);
    if (this.collect !== false) this.updates.set(id, message.record && message.order < (this.compacted || 0)
      ? { ...message, text: undefined, reload: typeof text === "string" } : message);
  }
  state(value) {
    if (!this.turn) return;
    this.states.set(this.turn.key, value);
    // A terminal event changes existing rows, without inventing a new message.
    for (let i = this.order.length - 1; i >= 0; i--) {
      const m = this.messages.get(this.order[i]);
      if (m.turnRef !== this.turn.key) break;
      this.put(m.id, m.text, { ...m, state: value });
    }
  }
  accept(row, location, lineNo, record) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    this.record = record;
    if (this.agent === "codex") this.codex(row, location, lineNo);
    else if (this.agent === "claude") this.claude(row, location);
    else this.dst(row, location);
  }
  codex(o, location, lineNo) {
    const p = o.payload || {}, ord = Number.isFinite(o.ordinal) ? o.ordinal : lineNo;
    if (o.type === "event_msg" && p.type === "task_started") {
      this.mirrors.clear();
      this.ensureTurn(p.turn_id || `ord:${ord}`);
      this.turn.ended = false;
      this.states.set(this.turn.key, "running");
      return;
    }
    if (o.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p.type)) {
      if (p.turn_id && this.turn && p.turn_id !== this.turn.key) return;
      this.state(p.type === "task_complete" ? "complete" : "interrupted");
      if (this.turn) this.turn.ended = true;
      return;
    }
    const structured = o.type === "response_item" && p.type === "message";
    const event = o.type === "event_msg" && ["user_message", "agent_message"].includes(p.type);
    if (!structured && !event) return;
    if (p.channel === "analysis" || p.phase === "analysis") return;
    const role = structured ? p.role : p.type === "user_message" ? "user" : "assistant";
    if (!["user", "assistant"].includes(role)) return;
    const text = (structured ? textBlocks(p.content, ["input_text", "output_text"]) : typeof p.message === "string" ? p.message : "").trim();
    if (!text) return;
    if (!this.turn || (p.turn_id && p.turn_id !== this.turn.key) || (role === "user" && this.turn.ended)) this.ensureTurn(p.turn_id || `ord:${ord}`);
    if (role === "user") {
      if (isHumanText(text, "codex")) this.turn.prompt = promptPreview(text);
      return;
    }
    // Pair only opposite representations of the same text within this turn.
    // Repeating the same sentence in two real messages remains two messages.
    const key = `${this.turn.key}\0${createHash("sha256").update(text).digest("hex")}`, source = structured ? "structured" : "event";
    const pairs = this.mirrors.get(key) || { structured: [], event: [], structuredHead: 0, eventHead: 0 };
    this.mirrors.set(key, pairs);
    const opposite = structured ? "event" : "structured", head = `${opposite}Head`;
    let id = p.id || `record:${location}`;
    if (pairs[head] < pairs[opposite].length) {
      id = pairs[opposite][pairs[head]++];
      if (!structured) return;
    } else pairs[source].push(id);
    this.put(id, text, { turnRef: this.turn.key, prompt: this.turn.prompt,
      timestamp: o.timestamp || null, kind: kindOf(p), ordinal: ord,
      record: this.record, state: this.states.get(this.turn.key) || "unknown" });
  }
  ancestor(id) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const node = this.nodes.get(id);
      if (!node) return null;
      if (node.prompt) return node;
      if (node.userKey) return this.nodes.get(node.userKey) || null;
      id = node.parent;
    }
    return null;
  }
  claude(o, location) {
    if (!o.uuid) return;
    const parent = o.type === "system" && o.subtype === "compact_boundary" && o.logicalParentUuid
      ? o.logicalParentUuid : o.parentUuid;
    const text = textBlocks(o.message?.content).trim();
    const human = o.type === "user" && !o.isSidechain && !o.isMeta && !o.isCompactSummary && isHumanText(text, "claude");
    const prior = this.ancestor(parent);
    const old = this.nodes.get(o.uuid);
    const branchSwitch = old?.branchSwitch || !!(human && this.turn && this.turn.key !== o.uuid && prior?.key !== this.turn.key);
    this.nodes.set(o.uuid, { key: o.uuid, parent, prompt: human ? promptPreview(text) : "", branchSwitch,
      userKey: human ? o.uuid : prior?.key });
    if (human) { this.ensureTurn(o.uuid, promptPreview(text)); return; }
    if (o.type !== "assistant" || o.isSidechain || o.isMeta || o.isCompactSummary || !text) return;
    // Assistant records without a resolvable user remain readable, unattached.
    this.put(o.uuid || `record:${location}`, text, { turnRef: prior?.key || null,
      prompt: prior?.prompt || "", timestamp: o.timestamp || null, kind: kindOf(o.message || {}),
      record: this.record, branchSwitch: prior?.branchSwitch || false, state: "unknown" });
  }
  dst(o, location) {
    const data = o.data || {};
    if (o.type === "user/message") {
      const text = textBlocks(data.content).trim();
      if (data.source?.kind === "user" && isHumanText(text, "dst")) this.ensureTurn(String(o.seq), promptPreview(text));
    } else if (o.type === "assistant/message") {
      const text = textBlocks(data.message?.content);
      this.put(Number.isFinite(o.seq) ? `seq:${o.seq}` : `record:${location}`, text, {
        turnRef: this.turn?.key || null, prompt: this.turn?.prompt || "",
        timestamp: epochTime(o.time), ordinal: o.seq, kind: kindOf(data.message || {}), record: this.record, state: "unknown",
      });
    }
  }
  window({ before, after, around, first = false, turnRef, ordinal, limit = 200 } = {}) {
    limit = Math.max(1, Math.min(400, limit));
    if (after) {
      const at = this.order.indexOf(after), start = at < 0 ? this.order.length : at + 1;
      const end = Math.min(this.order.length, start + limit);
      return { messages: this.order.slice(start, end).map(id => this.messages.get(id)),
        hasEarlier: start > 0, hasLater: end < this.order.length, total: this.order.length };
    }
    if (around) {
      const at = this.order.indexOf(around);
      if (at >= 0) {
        const start = Math.max(0, at - 20), end = Math.min(this.order.length, start + limit);
        return { messages: this.order.slice(start, end).map(id => this.messages.get(id)),
          hasEarlier: start > 0, hasLater: end < this.order.length, total: this.order.length };
      }
    }
    if (turnRef || Number.isFinite(ordinal)) {
      const at = this.order.findIndex(id => {
        const m = this.messages.get(id);
        return turnRef ? m.turnRef === turnRef : Number.isFinite(ordinal) && m.ordinal >= ordinal;
      });
      if (at >= 0) return { messages: this.order.slice(at, at + limit).map(id => this.messages.get(id)),
        hasEarlier: at > 0, hasLater: at + limit < this.order.length, total: this.order.length };
      return { messages: [], hasEarlier: false, hasLater: false, total: this.order.length, turnMissing: true };
    }
    const end = first ? Math.min(limit, this.order.length) : before ? this.order.indexOf(before) : this.order.length;
    const stop = end < 0 ? this.order.length : end;
    const start = first ? 0 : Math.max(0, stop - limit);
    return { messages: this.order.slice(start, stop).map(id => this.messages.get(id)),
      hasEarlier: start > 0, hasLater: stop < this.order.length, total: this.order.length, anchorMissing: !!around };
  }
  drain() { const values = [...this.updates.values()]; this.updates.clear(); return values; }
  compact() {
    // Keep old message identities/parents/locations, not old answer bodies.
    for (let i = this.compacted || 0; i < this.order.length - 400; i++) {
      const id = this.order[i], message = this.messages.get(id);
      if (message.record) this.messages.set(id, { ...message, text: undefined });
      const update = this.updates.get(id);
      if (update?.record) this.updates.set(id, { ...update, text: undefined, reload: true });
    }
    this.compacted = Math.max(0, this.order.length - 400);
  }
}

module.exports = { ProgressLog, textBlocks, kindOf };
