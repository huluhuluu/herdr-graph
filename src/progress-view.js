"use strict";

const adapters = require("./adapters");
const { truncate, oneLine } = require("./util");
const { wrapMatches, matchRanges } = require("./ui");

// Reader state is independent of the graph selection and its full-text scroll.
class ProgressView {
  constructor(app) {
    this.app = app;
    this.serial = 0;
    this.refreshSerial = 0;
    this.historySerial = 0;
    this.dirty = new Map();
    this.files = new Map();
    this.bookmarks = new Map();
    this.onlyProgress = false;
    this.query = "";
    this.queryInput = "";
  }
  stop() {
    if (this.data) {
      this.restored = { key: this.data.key, nodeId: this.data.nodeId, anchor: this.bookmark(), follow: this.data.follow };
      this.bookmarks.delete(this.data.key);
      this.bookmarks.set(this.data.key, this.restored);
      if (this.bookmarks.size > 8) this.bookmarks.delete(this.bookmarks.keys().next().value);
    }
    if (this.data) this.app.loader?.send({ type: "progress-unsubscribe", subscriptionId: this.data.subscriptionId });
    this.data = null;
  }
  target() {
    const n = this.app.current();
    return n && !n.directoryOnly && !n.missing && n.agent && n.sessionId ? n : null;
  }
  sync() {
    if (this.app.readerMode !== "progress") { if (this.data) this.stop(); this.ensureFull(); return; }
    const node = this.target();
    if (!node) { this.stop(); return; }
    const key = `${node.agent}:${node.sessionId}`;
    if (this.data?.key === key && this.data.pageId === this.app.loadId) {
      if (this.data.nodeId !== node.id) {
        this.data.nodeId = node.id;
        this.data.turnAnchor = node.key;
        this.data.ordinal = node.ordStart;
        this.pause();
        this.data.positioned = false;
        this.data.anchorRequested = false;
        this.data.anchor = null;
        this.data.lines = null;
      }
      return;
    }
    this.stop();
    const saved = this.restored?.key === key ? this.restored : this.bookmarks.get(key);
    const restored = saved && (saved.nodeId === node.id || node.sessionOnly || node.sessionBoundary) ? saved : null;
    this.restored = null;
    const latest = node.sessionOnly || node.sessionBoundary || node.id === this.app.nodes().filter(n => n.sessionId === node.sessionId).at(-1)?.id;
    this.data = { key, pageId: this.app.loadId, subscriptionId: ++this.serial,
      nodeId: node.id, turnAnchor: node.key, ordinal: node.ordStart,
      messages: [], unseen: 0, scroll: 0, revision: 0,
      follow: this.followNext || restored?.follow || (!restored && latest),
      anchor: this.followNext ? null : restored?.anchor, status: "Loading progress…" };
    this.followNext = false;
    this.app.loader?.send({ type: "progress-subscribe", id: this.app.loadId,
      subscriptionId: this.data.subscriptionId, agent: node.agent, sessionId: node.sessionId, file: node.file });
  }
  toggle() {
    const app = this.app;
    if (app.readerMode === "progress") {
      this.stop(); app.readerMode = "full";
      if (this.fullBookmark?.id === app.current()?.id) { app.scroll = this.fullBookmark.scroll; app.focus = this.fullBookmark.focus; }
      else app.scroll = 0;
      this.ensureFull();
    } else {
      if (!this.target() && !(app.loading && !app.graph)) { app.notify("Select a readable session first."); return; }
      this.fullBookmark = { id: app.current()?.id, scroll: app.scroll, focus: app.focus };
      app.readerMode = "progress"; app.focus = "detail";
      this.sync();
    }
  }
  save() {
    const d = this.data;
    return { mode: this.app.readerMode, onlyProgress: this.onlyProgress, query: this.query,
      fullBookmark: this.fullBookmark,
      restored: d ? { key: d.key, nodeId: d.nodeId, anchor: this.bookmark(), follow: d.follow } : null };
  }
  restore(saved) {
    this.stop(); this.pendingFull = null;
    this.fullError = null;
    this.app.readerMode = saved?.mode || "full";
    this.onlyProgress = saved?.onlyProgress || false;
    this.query = saved?.query || "";
    this.restored = saved?.restored;
    this.fullBookmark = saved?.fullBookmark;
  }
  message(m) {
    if (m.type === "session-refreshed" || m.type === "session-refresh-error") {
      const request = this.pendingFull;
      if (!request || m.refreshId !== request.refreshId || m.id !== this.app.loadId || m.key !== request.key) return true;
      const selectedId = this.app.current()?.id;
      this.pendingFull = null;
      if (m.error) { this.fullError = m.error; return true; }
      for (const graph of new Set([this.app.graph, ...this.app.navigationStack.map(p => p.graph)])) {
        if (!graph) continue;
        const entry = graph.sessions.get(m.key);
        if (entry) Object.assign(entry, { turns: m.turns, loaded: true, file: m.file, meta: { ...entry.meta, ...m.meta } });
        if (graph.sessionMeta.has(m.key)) Object.assign(graph.sessionMeta.get(m.key), m.meta, { file: m.file });
        graph.familyTurns?.set(m.key, { turns: m.turns });
        for (const [key, meta] of graph.sessionMeta) if (key === m.key || `${meta.agent}:${meta.parentSessionId}` === m.key) graph.edges?.delete(key);
        if (graph.scope === "session" && graph.focusKey === m.key && entry) graph.nodes = adapters.flatten(graph.sessions, entry, "session", graph.sessionMeta);
      }
      this.app.relationTurns.delete(m.key);
      this.app.detailRequests.clear();
      this.app._contentFor = this.app._byIdFor = this.app._relationIdsFor = null;
      if (this.dirty.get(m.key) === request.version) this.dirty.delete(m.key);
      const index = this.app.nodes().findIndex(n => n.id === selectedId);
      if (index >= 0) this.app.selected = index;
      else {
        this.app.selected = Math.max(0, Math.min(this.app.selected, this.app.nodes().length - 1));
        this.app.notify("The saved turn changed; showing the nearest available turn.");
      }
      this.fullError = null;
      return true;
    }
    if (!m.type.startsWith("progress-")) return false;
    const d = this.data;
    if (!d || m.subscriptionId !== d.subscriptionId || (m.key && m.key !== d.key) || (m.id != null && m.id !== d.pageId)) return true;
    if (m.history && m.historyId !== d.historyId) return true;
    const anchor = this.bookmark();
    if (m.activeTurn !== undefined && JSON.stringify(d.activeTurn) !== JSON.stringify(m.activeTurn)) {
      d.activeTurn = m.activeTurn; d.lines = null; if (!d.follow) d.anchor = anchor;
    }
    if (m.type === "progress-state") {
      d.status = m.status; d.error = m.error; d.checkedAt = m.checkedAt;
      if (m.error) { d.historyPending = false; d.historyIntent = null; }
      else if (d.pendingReset) d.status = "Log replaced; waiting for public messages (previous snapshot)";
      return true;
    }
    if (m.changed && m.fullChanged !== false) this.dirty.set(d.key, `${d.subscriptionId}:${m.sourceEpoch}:${m.revision}`);
    if (m.file) this.files.set(d.key, m.file);
    if (m.type === "progress-snapshot") {
      if (d.sourceEpoch !== m.sourceEpoch) { d.seenOrder = -1; d.unseen = 0; }
      const waitForReplacement = m.changed && d.messages.length > 0 && m.messages.length === 0;
      const previousMessages = d.messages;
      const merge = (m.prepend || m.append) && d.sourceEpoch === m.sourceEpoch;
      const merged = merge ? [...new Map([...d.messages, ...m.messages].map(item => [item.id, item])).values()].sort((a, b) => a.order - b.order) : m.messages;
      d.messages = m.append ? merged.slice(-400) : merged.slice(0, 400);
      if (waitForReplacement) { d.messages = previousMessages; d.pendingReset = true; }
      else d.pendingReset = false;
      d.hasEarlier = m.hasEarlier || (m.append && d.hasEarlier);
      d.hasLater = m.hasLater || (m.prepend && d.hasLater);
      d.total = m.total; d.sourceEpoch = m.sourceEpoch; d.revision = m.revision;
      d.turnMissing = !!m.turnMissing;
      d.seenOrder = Math.max(d.seenOrder ?? -1, m.total == null ? -1 : m.total - 1,
        m.messages.reduce((highest, item) => Math.max(highest, item.order), -1));
      d.error = null; d.historyPending = false;
      d.anchor = d.follow ? null : anchor || d.anchor;
      if (d.historyIntent?.first || d.historyIntent?.turnRef || Number.isFinite(d.historyIntent?.ordinal)) {
        d.anchor = null; d.scroll = 0; d.positioned = !!d.historyIntent.first;
      }
      d.historyIntent = null;
      if (m.anchorMissing) { d.anchor = null; d.positioned = true; this.app.notify("Saved message is no longer available; showing the latest window."); }
      if ((!m.prepend && !m.append) || !d.hasLater) d.unseen = 0;
    } else if (m.type === "progress-delta") {
      if (m.sourceEpoch !== d.sourceEpoch || m.baseRevision !== d.revision) { this.history(); return true; }
      if (!m.upserts.length) { d.revision = m.revision; return true; }
      if (d.pendingReset && m.upserts.some(item => item.text !== undefined)) {
        d.messages = []; d.pendingReset = false; d.scroll = 0;
      }
      const values = new Map(d.messages.map(item => [item.id, item]));
      let reload = false;
      for (const item of m.upserts) {
        if (values.has(item.id) && item.reload) reload = true;
        if (values.has(item.id)) values.set(item.id, { ...values.get(item.id), ...item,
          text: item.text === undefined ? values.get(item.id).text : item.text });
        else if (d.follow && item.text !== undefined) values.set(item.id, item);
      }
      const newest = Math.max(d.seenOrder ?? -1, m.total == null ? -1 : m.total - 1,
        m.upserts.reduce((highest, item) => Math.max(highest, item.order), -1));
      if (!d.follow) d.unseen += newest - (d.seenOrder ?? -1);
      d.seenOrder = newest;
      const sorted = [...values.values()].sort((a, b) => a.order - b.order);
      d.messages = d.follow ? sorted.slice(-200) : sorted;
      if (sorted.length > d.messages.length) d.hasEarlier = true;
      d.revision = m.revision;
      d.anchor = d.follow ? null : anchor;
      if (reload && !d.follow) this.history({ around: d.messages[0]?.id });
    }
    if (m.file) d.file = m.file;
    d.lines = null;
    return true;
  }
  ensureFull(force = false) {
    const node = this.target(), app = this.app;
    if (!node) { this.pendingFull = null; this.fullError = null; return; }
    if (!app.loader || app.readerMode !== "full") return;
    const key = `${node.agent}:${node.sessionId}`;
    if (this.pendingFull && (this.pendingFull.key !== key || this.pendingFull.pageId !== app.loadId)) this.pendingFull = null;
    if (this.lastFullKey !== key) { this.fullError = null; this.lastFullKey = key; }
    if ((!force && !this.dirty.has(key)) || (this.pendingFull?.key === key && this.pendingFull.pageId === app.loadId)) return;
    if (this.fullError && !force) return;
    // Catalog details contain no transcript. Enter will load it normally.
    if (node.sessionOnly) { if (force) app.notify("Press Enter for complete output or m for live progress first."); return; }
    this.pendingFull = { key, pageId: app.loadId, refreshId: ++this.refreshSerial,
      version: this.dirty.get(key) };
    app.loader.send({ type: "refresh-session", id: app.loadId, refreshId: this.pendingFull.refreshId,
      agent: node.agent, sessionId: node.sessionId, file: this.files.get(key) || node.file });
  }
  history(options = {}) {
    if (!this.data || (this.data.historyPending && JSON.stringify(this.data.historyIntent) === JSON.stringify(options))) return;
    this.data.historyPending = true;
    this.data.historyIntent = options;
    this.data.historyId = ++this.historySerial;
    this.app.loader?.send({ type: "progress-history", subscriptionId: this.data.subscriptionId, historyId: this.data.historyId, ...options });
  }
  bookmark() {
    const d = this.data, line = d?.lines?.[d.scroll];
    if (d?.historyPending && d.anchor) return d.anchor;
    return line ? { id: line.id, messageId: line.messageId, offset: line.offset } : d?.anchor;
  }
  pause() {
    const d = this.data;
    if (d?.follow) {
      const anchor = this.bookmark();
      d.follow = false;
      this.history({ around: anchor?.messageId || d.messages.at(-1)?.id });
    }
    if (d) d.follow = false;
  }
  scroll(delta) {
    const d = this.data;
    if (!d) return;
    this.pause(); d.positioned = true; d.anchor = null;
    d.scroll = Math.max(0, Math.min(d.maxScroll || 0, d.scroll + delta));
    d.anchor = this.bookmark();
    if (delta < 0 && d.scroll === 0 && d.hasEarlier) {
      d.anchor = this.bookmark(); this.history({ before: d.messages[0]?.id });
    } else if (delta > 0 && d.scroll >= (d.maxScroll || 0) && d.hasLater) {
      this.history({ after: d.messages.at(-1)?.id });
    }
  }
  handleKey(key) {
    const app = this.app, d = this.data;
    if (app.mode === "progress-search") {
      if (key.name === "escape") app.mode = "browse";
      else if (key.name === "enter") {
        this.query = this.queryInput; app.mode = "browse";
        if (d) { this.pause(); d.locateSearch = true; d.lines = null; }
      } else if (key.name === "backspace") this.queryInput = [...this.queryInput].slice(0, -1).join("");
      else if (key.name === "ctrl-u") this.queryInput = "";
      else if (key.printable) this.queryInput += key.raw;
      return true;
    }
    if (app.mode !== "browse") return false;
    if (key.name === "m") { this.toggle(); return true; }
    if (key.name === "r") {
      if (app.readerMode === "progress" && d) app.loader?.send({ type: "progress-check", subscriptionId: d.subscriptionId, revalidate: true });
      else { this.fullError = null; this.ensureFull(true); }
      return true;
    }
    if (app.readerMode !== "progress") return false;
    if (key.name === "p") { this.onlyProgress = !this.onlyProgress; if (d) { d.anchor = this.bookmark(); d.lines = null; } return true; }
    if (key.name === "tab" || key.name === "shift-tab") { app.focus = app.focus === "detail" ? "graph" : "detail"; return true; }
    if (app.focus !== "detail" || !d) return false;
    if (["j", "down", "k", "up", "pagedown", "pageup"].includes(key.name)) {
      this.scroll((["k", "up", "pageup"].includes(key.name) ? -1 : 1) * (key.name.startsWith("page") ? 10 : 1)); return true;
    }
    if (key.name === "G" || key.name === "end") {
      d.follow = true; d.anchor = null; d.unseen = 0; this.history(); return true;
    }
    if (key.name === "g" || key.name === "home") {
      d.follow = false; d.anchor = null; d.turnAnchor = null; d.scroll = 0; this.history({ first: true }); return true;
    }
    if (key.name === "/") { app.mode = "progress-search"; this.queryInput = this.query; return true; }
    if (key.name === "enter") { this.toggle(); return true; }
    return false;
  }
  render(D) {
    const app = this.app, s = app.screen, d = this.data;
    const text = (y, value, fg = "gray") => s.text(D.x + 2, y, truncate(value, Math.max(1, D.w - 4)), { fg });
    if (!d) { text(D.y, "Select a saved session to read its progress."); return; }
    text(D.y, this.target()?.title || d.key, "cyan");
    text(D.y + 1, `${this.onlyProgress ? "Progress only" : "All assistant text"} · ${d.follow ? "Following latest" : "Paused"}${d.unseen ? ` · ${d.unseen} new` : ""}`, "green");
    text(D.y + 2, `${d.error || d.status || "Loading…"}${d.checkedAt && !d.error ? ` · checked ${new Date(d.checkedAt).toISOString().slice(11, 19)} UTC` : ""}`, d.error ? "yellow" : "gray");
    const width = Math.max(1, D.w - 4), height = Math.max(0, D.h - 5);
    const cacheKey = `${width}|${this.query}|${this.onlyProgress}`;
    if (!d.lines || d.linesKey !== cacheKey) {
      const bookmark = d.anchor || this.bookmark();
      const lines = [], add = (m, value, fg, field) => {
        let offset = 0;
        for (const line of wrapMatches(value, width, this.query)) {
          lines.push({ ...line, id: `${m.id}/${field}`, messageId: m.id, offset, fg });
          offset += line.text.length + (value[offset + line.text.length] === "\n" ? 1 : 0);
        }
      };
      let priorTurn;
      for (const m of d.messages) {
        if (this.onlyProgress && m.kind !== "progress") continue;
        if (m.turnRef !== priorTurn) {
          if (m.branchSwitch) add(m, "─ branch changed ─", "magenta", "branch");
          add(m, `❯ ${oneLine(m.prompt || "(user context not recorded)")}`, "green", "prompt"); priorTurn = m.turnRef;
        }
        const time = typeof m.timestamp === "string" ? m.timestamp.slice(11, 19) : "time unknown";
        add(m, `${time}  ${m.kind === "progress" ? "● Progress" : m.kind === "final" ? "◆ Answer" : "● Assistant"}${m.state !== "unknown" ? ` · ${m.state}` : ""}`, "cyan", "label");
        add(m, m.text, "white", "body"); add(m, "", "gray", "space");
      }
      if (!d.turnMissing && d.activeTurn?.prompt && !d.messages.some(m => m.turnRef === d.activeTurn.key) && !d.hasLater) {
        const pending = { id: `pending:${d.activeTurn.key}` };
        add(pending, `❯ ${d.activeTurn.prompt}`, "green", "prompt");
        add(pending, "No public assistant progress for this turn yet.", "gray", "body");
      }
      d.lines = lines; d.linesKey = cacheKey;
      let waitingForAnchor = false;
      if (bookmark) {
        const at = lines.findLastIndex(l => l.id === bookmark.id && l.offset <= bookmark.offset);
        if (at >= 0) d.scroll = at;
        else if (bookmark.messageId && !d.messages.some(m => m.id === bookmark.messageId)) {
          d.anchor = bookmark; waitingForAnchor = true; this.history({ around: bookmark.messageId });
        }
      } else if (!d.positioned && !d.follow) {
        const m = d.messages.find(m => d.turnAnchor ? m.turnRef === d.turnAnchor : Number.isFinite(d.ordinal) && m.ordinal >= d.ordinal);
        if (m) d.scroll = Math.max(0, lines.findIndex(l => l.messageId === m.id));
        else if (d.hasEarlier && !d.anchorRequested) {
          d.anchorRequested = true; d.positioned = false;
          this.history({ turnRef: d.turnAnchor, ordinal: d.ordinal });
        }
      }
      if (!waitingForAnchor) d.anchor = null;
      d.positioned = !d.historyPending;
    }
    d.maxScroll = Math.max(0, d.lines.length - height);
    if (d.locateSearch) {
      const at = d.lines.findIndex(line => matchRanges(line.text, this.query).length);
      if (at >= 0) d.scroll = at;
      d.locateSearch = false;
    }
    d.scroll = d.follow ? d.maxScroll : Math.max(0, Math.min(d.scroll, d.maxScroll));
    if (!d.lines.length) text(D.y + 4, d.turnMissing ? "No public assistant message recorded for the selected turn. G: latest."
      : this.onlyProgress ? "No classified progress in this window. Press p for all assistant text." : "No public assistant progress recorded yet.");
    d.lines.slice(d.scroll, d.scroll + height).forEach((line, i) => s.highlightedText(D.x + 2, D.y + 4 + i,
      line.text, this.query, { fg: line.fg }, line.matches));
    if (d.hasEarlier || d.hasLater || this.query) text(D.y + D.h - 1,
      `${d.hasEarlier ? "PgUp: earlier · " : ""}${d.hasLater ? "G: latest · " : ""}${this.query ? "Search: loaded window · " : ""}m full · r refresh`);
  }
}

module.exports = { ProgressView };
