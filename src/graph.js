"use strict";

// Session Graph -- the plugin pane.
//
// Layout:
//   +--------------------------+---------------------------+
//   | node graph (tree)        | selected node's prompt    |
//   | hjkl to move             | and reply (scrollable)    |
//   +--------------------------+---------------------------+
//
// Keys: j/k move, h/l collapse/expand, g/G first/last, Tab swap focus,
// Enter read/jump, s history, R rename, f family, d detail tree, n/F resume/fork,
// t scope, / search, Backspace/Esc back, K keybinding help, ? help, q quit.

const herdr = require("./herdr");
const path = require("node:path");
const {
  targetPane, paneList, focusPane, runInPane, paneGet,
} = herdr;
const adapters = require("./adapters");
const { makeStore, cachedParse } = require("./store");
const { recordsFor, familyRows, familyContentRows, pathTo, previewRows, edgeInfo, formatTime, shortIds, branchLabel } = require("./relations");
const { renameSession, forkSession } = require("./native");
const { directoryKey, filterSessions, catalogRows } = require("./catalog");
const { Screen, matchRanges, wrapMatches } = require("./ui");
const { Loader } = require("./loader");
const { ProgressView } = require("./progress-view");
const { sessionEnv, paneEnv, VARIABLES } = require("./paths");
const { width: strWidth, truncate, pad, oneLine, wrap } = require("./util");

const SCOPES = ["session", "lineage", "all"];
const SCOPE_LABEL = {
  session: "conversation",
  lineage: "full lineage",
  all: "all sessions",
};

const HELP = [
  ["Backspace", "previous page; keep filters / position"],
  ["Esc", "cancel / back; close at the first page"],
  ["j / k", "move nodes / scroll focused content"],
  ["h / l", "collapse / expand subtree"],
  ["g / G", "first / last node or content line"],
  ["PgUp/PgDn", "page focused tree / scroll content"],
  ["Tab", "switch focus: graph <-> content"],
  ["Enter", "open directory / read session / jump"],
  ["", "Family turn: focus content reader"],
  ["n", "resume; DST opens its native picker"],
  ["F (Shift+F)", "fork saved session / Claude branch"],
  ["t", "cycle scope: session -> lineage -> all"],
  ["s", "browse all saved sessions"],
  ["c", "read / refresh the caller's current session"],
  ["m", "switch full output / live session progress"],
  ["p / r", "progress filter / refresh selected session"],
  ["G", "content: latest; progress: resume following"],
  ["f / b", "open Family (b is a compatibility alias)"],
  ["d", "Family: structure / conversation tree"],
  ["T (Shift+T)", "hide / show timestamps"],
  ["a", "filter agent: all / Codex / Claude / DST"],
  ["v / o", "directory / time view; newest / oldest"],
  ["R", "rename selected session (native name)"],
  ["/", "search turns or session names / paths"],
  ["K", "keybinding setup instructions"],
  ["?", "this help"],
  ["q", "close"],
  ["Ctrl+C", "close from any mode"],
];

class App {
  constructor(opts = {}) {
    this.screen = new Screen();
    this.scope = opts.scope || "session";
    this.selected = 0;
    this.collapsed = new Set();
    this.focus = "graph";
    this.scroll = 0;
    this.search = null;
    this.searchInput = "";
    this.mode = "browse";
    this.message = null;
    this.messageUntil = 0;
    this.graph = null;
    this.navigationStack = [];
    this.relationView = false;
    this.familyDetail = false;
    this.showRelationTime = true;
    this.relationTurns = new Map();
    this.store = opts.store || makeStore();
    this.env = paneEnv(opts.env || process.env);
    this.renameSession = opts.renameSession || renameSession;
    this.forkSession = opts.forkSession || forkSession;
    this.historyView = opts.historyView || "directory";
    this.historyOrder = "newest";
    this.agentFilter = "all";
    this.expandedDirectories = new Set();
    this.historyInitialized = false;
    this.callerId = this.env.SESSION_GRAPH_CALLER || herdr.callerPaneId();
    this.activeSession = null;
    this.renameInput = "";
    this.panes = [];
    this.cwd = opts.cwd || this.env.SESSION_GRAPH_CWD || process.cwd();
    this.top = 0;
    this.loadId = 0;
    this.catalog = new Map();
    this.renamedTitles = new Map();
    this.detailRequests = new Set();
    this.readerMode = "full";
    this.progressView = new ProgressView(this);
    this.helpTop = 0;
    // Herdr side effects are injectable so behaviour can be tested without
    // touching a live session.
    this.herdr = { focusPane, runInPane, paneList, paneGet, ...(opts.herdr || {}) };
  }

  // --- data ---------------------------------------------------------------

  // The pane the user was looking at when the overlay opened. Inside a pane
  // command HERDR_PANE_ID is the overlay's own pane, so the caller pane is
  // passed through explicitly by `open`.
  callerPane() {
    if (!this.callerId) return null;
    try { return this.herdr.paneGet(this.callerId); } catch { return null; }
  }

  updateCaller(pane) {
    const previous = this.initialSession, previousPane = this.callerContext;
    this.callerContext = pane || null;
    const session = pane?.agent_session;
    const adapter = adapters.forAgent(session?.agent || pane?.agent);
    this.initialSession = adapter && session?.value ? { agent: adapter.id, value: session.value } : null;
    if (this.initialSession || !adapter) return;
    const cwd = directoryKey(pane.foreground_cwd || pane.cwd);
    const title = oneLine(pane.terminal_title_stripped);
    if (!cwd || !title) return;
    const suffix = ` | ${cwd.split(/[\\/]/).at(-1)}`;
    const undecorate = text => adapter.id === "codex" ? text.replace(/^\[[ .!*]+\]\s+Action Required\s+\|\s+/, "") : text;
    const titles = [title, undecorate(title)];
    for (const candidate of [...titles]) {
      if (candidate.toLowerCase().endsWith(suffix.toLowerCase())) titles.push(candidate.slice(0, -suffix.length));
    }
    // A native rename may leave the terminal title unchanged until the next turn.
    const renamedCaller = previous?.agent === adapter.id && this.renamedTitles.has(`${previous.agent}:${previous.value}`) &&
      pane.pane_id === previousPane?.pane_id && directoryKey(previousPane?.foreground_cwd || previousPane?.cwd) === cwd &&
      undecorate(oneLine(previousPane?.terminal_title_stripped)) === undecorate(title);
    const records = this.loader ? this.catalog.values() : this.graph?.sessionMeta?.values() || [];
    const matches = [...records].filter(meta => meta.agent === adapter.id &&
      directoryKey(meta.cwd) === cwd && (titles.includes(oneLine(meta.title)) || (renamedCaller && meta.sessionId === previous.value)));
    if (matches.length === 1) this.initialSession = { agent: adapter.id, value: matches[0].sessionId };
  }

  isCallerSession(node) {
    return !!this.initialSession && node?.agent === this.initialSession.agent && node.sessionId === this.initialSession.value;
  }

  load() {
    if (this.loader) { this.loadBackground(); return; }
    let pane = this.callerPane();
    this.updateCaller(pane);
    this.panes = [];
    try { this.panes = this.herdr.paneList(); } catch {}

    const session = this.activeSession || this.initialSession;
    const agentId = session?.agent || pane?.agent || null;
    const adapter = adapters.forAgent(agentId);

    if (!adapter || !session?.value) this.scope = "all";

    const found = this.activeSession?.file ? { adapter, file: this.activeSession.file }
      : this.scope === "all" ? null : adapters.findSession(session.value, [adapter], this.env);
    if (!found && this.scope !== "all") {
      this.scope = "all";
      this.notify(`Current session is not on disk. Showing saved sessions.`, 5000);
    }

    try {
      this.graph = adapters.buildGraph({
        adapter: found?.adapter || adapter,
        sessionId: session?.value,
        file: found?.file,
        scope: this.scope,
        env: this.env,
        store: this.store,
      });
      // Persist immediately: the first open of a large session is the slow one,
      // and the cache must survive even if the pane is closed abruptly.
      this.store.flush();
    } catch (err) {
      this.graph = null;
      this.emptyReason = `Could not read the session: ${err.message}`;
      return;
    }

    this.emptyReason = null;
    this.updateCaller(pane);
    this.cwd = pane?.cwd || this.graph.nodes[0]?.cwd || this.cwd;
    // Land on the last turn of the focused session -- that is where the user is.
    const mine = this.graph.nodes.filter(n => n.isFocusSession);
    const nearby = this.scope === "all" ? this.graph.nodes.find(n => n.cwd === this.cwd) : null;
    if (this.scope === "all" && !this.historyInitialized) {
      if (pane?.cwd) this.expandedDirectories.add(directoryKey(pane.cwd));
      this.historyInitialized = true;
    }
    const selectedId = mine.at(-1)?.id || nearby?.id;
    this.selected = Math.max(0, this.nodes().findIndex(n => n.id === selectedId));
    this.top = 0;
    this.clampSelection();
  }

  loadBackground() {
    this.progressView.stop();
    this.progressView.pendingFull = null;
    this.progressView.fullError = null;
    const session = this.activeSession || this.initialSession;
    this.loading = this.relationView ? "Loading family…" : this.scope === "all" ? "Loading history…" : "Loading session…";
    this.detailRequests.clear();
    this.loader.send({ type: "page", id: ++this.loadId, scope: this.scope, family: this.relationView, session });
    this.graph = null;
    this.emptyReason = this.loading;
  }

  backgroundMessage(message) {
    if (this.closed) return;
    if (this.progressView.message(message)) {
      if (this.screen.active) this.render();
      return;
    }
    if (message.type === "caller") {
      this.updateCaller(message.pane);
      this.cwd = message.pane?.cwd || this.cwd;
      this.expandedDirectories.add(directoryKey(this.cwd));
    } else if (message.type === "panes") {
      this.panes = message.panes;
      if (this.callerId) this.updateCaller(this.panes.find(pane => pane.pane_id === this.callerId));
    }
    else if (message.type === "catalog") {
      const selectedId = this.current()?.id, previousScroll = this.scroll;
      for (const meta of message.entries) {
        const key = `${meta.agent}:${meta.sessionId}`, previous = this.catalog.get(key);
        if (this.renamedTitles.has(key)) meta.title = this.renamedTitles.get(key);
        if (!previous || (meta.mtime || 0) >= (previous.mtime || 0)) this.catalog.set(key, { ...meta, key, adapter: adapters.byId(meta.agent) });
      }
      this.scanStatus = message.complete ? null : `Loading ${message.stage}…`;
      for (const graph of new Set([this.graph, ...this.navigationStack.map(page => page.graph)])) {
        if (!graph) continue;
        const metadata = new Map(graph.sessionMeta);
        for (const [key, entry] of this.catalog) {
          if (!metadata.has(key) || (entry.mtime || 0) >= (metadata.get(key).mtime || 0)) metadata.set(key, entry);
        }
        graph.sessionMeta = metadata;
        for (const [key, entry] of graph.sessions) if (!graph.sessionMeta.has(key)) graph.sessionMeta.set(key, { ...entry.meta, agent: entry.agent, sessionId: entry.sessionId, file: entry.file });
        if (graph.scope === "all") Object.assign(graph, adapters.buildGraph({ scope: "all",
          entries: [...graph.sessionMeta].map(([key, entry]) => ({ ...entry, key, adapter: adapters.byId(entry.agent) })),
          adapter: adapters.byId(graph.focusAgent), sessionId: graph.focusSessionId }));
        else if (graph.scope === "session") {
          const root = graph.sessions.get(graph.focusKey);
          if (root) graph.nodes = adapters.flatten(graph.sessions, root, "session", graph.sessionMeta);
        }
      }
      this._byIdFor = this._relationIdsFor = null;
      this.updateCaller(this.callerContext);
      if (selectedId) this.selected = Math.max(0, this.nodes().findIndex(row => row.id === selectedId));
      this.scroll = previousScroll;
    } else if (message.type === "page" && message.id === this.loadId) {
      this.graph = message.graph;
      for (const [key, entry] of this.graph.sessions) if (entry.loaded) this.progressView.dirty.delete(key);
      for (const node of this.graph.nodes) {
        const title = this.renamedTitles.get(`${node.agent}:${node.sessionId}`);
        if (title !== undefined) { node.title = title; if (node.sessionOnly) node.prompt = title; }
      }
      for (const [key, title] of this.renamedTitles) {
        const meta = this.graph.sessionMeta.get(key), entry = this.graph.sessions.get(key);
        if (meta) meta.title = title;
        if (entry?.meta) entry.meta.title = title;
      }
      this.scope = message.scope;
      this.loading = null;
      this.emptyReason = null;
      if (!message.complete) this.scanStatus = "Loading current directory…";
      const list = this.nodes();
      const target = this.relationView ? list.find(row => row.sessionId === this.activeSession?.value)
        : list.filter(row => row.isFocusSession).at(-1);
      this.selected = Math.max(0, list.findIndex(row => row.id === target?.id));
      this.top = this.scroll = 0;
    } else if (message.type === "edge" && message.id === this.loadId && this.graph) {
      this.graph.edges ||= new Map();
      this.graph.edges.set(message.key, message.info);
    } else if (message.type === "transcript" && message.id === this.loadId && this.graph) {
      const selected = this.current();
      this.graph.familyTurns ||= new Map();
      this.graph.familyTurns.set(message.key, { turns: message.turns, error: message.error });
      this._contentFor = null;
      if (selected) {
        const rows = this.nodes(), exact = rows.findIndex(row => row.id === selected.id);
        this.selected = Math.max(0, exact >= 0 ? exact : rows.findIndex(row => row.sessionId === selected.sessionId && row.sessionBoundary));
      }
    } else if (message.type === "warning") this.notify(message.error, 7000);
    else if (message.type === "error" && (message.id == null || message.id === this.loadId)) {
      this.loading = null;
      this.emptyReason = `Could not load history: ${message.error}`;
      this.notify(this.emptyReason, 7000);
    }
    if (this.searchSelectionPending && ["page", "catalog", "transcript"].includes(message.type)) this.selectSearchMatch();
    if (this.screen.active) this.render();
  }

  requestDetails(rows, includeTurns = false) {
    if (!this.loader || !this.graph) return;
    const pending = rows.filter(row => {
      const key = `${row.agent}:${row.sessionId}`;
      // Incomplete scans may reveal a previously missing parent later.
      const info = this.graph.edges?.get(key);
      const parentFound = recordsFor(this.graph).has(`${row.agent}:${row.parentSessionId}`);
      const needsTurns = includeTurns && !this.graph.familyTurns?.has(key);
      if (info && !(info.parentUnavailable && parentFound) && !needsTurns) return false;
      const requestKey = `${key}:${parentFound}:${includeTurns}`;
      if (this.detailRequests.has(requestKey) || row.missing) return false;
      this.detailRequests.add(requestKey);
      return true;
    });
    if (pending.length) this.loader.send({ type: "details", id: this.loadId, includeTurns, rows: pending.map(({ adapter, ...row }) => row) });
  }

  familyContent(meta) {
    const key = `${meta.agent}:${meta.sessionId}`;
    const saved = this.graph?.familyTurns?.get(key);
    if (saved) return saved;
    const entry = this.graph?.sessions.get(key);
    if (entry?.loaded) return { turns: entry.turns };
    if (this.loader) return null;
    const turns = this.sessionTurns(meta, true);
    return { turns: turns || [], error: this.relationTurns.get(key)?.error };
  }

  contentRows() {
    if (this._contentFor !== this.graph || this._contentMeta !== this.graph.sessionMeta) {
      this._contentRows = familyContentRows(this.graph, meta => this.familyContent(meta));
      this._contentById = new Map(this._contentRows.map(row => [row.id, row]));
      this._contentFor = this.graph;
      this._contentMeta = this.graph.sessionMeta;
    }
    return this._contentRows;
  }

  nodes() {
    if (!this.graph) return [];
    if (this.relationView) {
      if (this.familyDetail) {
        const rows = this.contentRows();
        const visible = rows.filter(row => this.isVisible(row));
        if (!this.search) return visible;
        const keep = new Set();
        for (const row of visible) {
          if (!this.matchesSearch(row)) continue;
          let cur = row;
          while (cur && !keep.has(cur.id)) { keep.add(cur.id); cur = this._contentById.get(cur.parentId); }
        }
        return visible.filter(row => keep.has(row.id));
      }
      const rows = familyRows(this.graph, this.graph.focusAgent, this.graph.focusSessionId, this.collapsed);
      if (!this.search) return rows;
      const matching = rows.filter(row => this.matchesSearch(row));
      const keep = new Set(matching.flatMap(row => [...pathTo(rows, row.sessionId)]));
      return rows.filter(row => keep.has(row.id));
    }
    if (this.scope === "all") return catalogRows(this.historySessions(), {
      view: this.historyView, order: this.historyOrder, expanded: this.expandedDirectories, collapsed: this.collapsed,
    });
    const rows = this.loader && this.scope === "lineage" ? this.contentRows() : this.graph.nodes;
    const visible = rows.filter(n => this.isVisible(n));
    if (this.search) {
      return visible.filter(n => this.matchesSearch(n));
    }
    return visible;
  }

  historySessions() {
    return filterSessions(this.graph?.nodes || [], { agent: this.agentFilter, search: this.search });
  }

  matchesSearch(node) {
    if (!this.search || node.directoryOnly) return false;
    const text = node.sessionOnly || node.sessionBoundary
      ? `${node.title || ""} ${node.agent} ${node.sessionId} ${this.relationId(node.sessionId)} ${node.cwd || ""}`
      : `${node.promptFull || node.prompt || ""}\n${node.replyFull || node.reply || ""}`;
    return matchRanges(text, this.search).length > 0;
  }

  selectSearchMatch() {
    const index = this.nodes().findIndex(node => this.matchesSearch(node));
    if (index >= 0) { this.selected = index; this.searchSelectionPending = false; }
    else this.searchSelectionPending = !!this.search;
  }

  detailSearchKey() { return `${this.current()?.id}|${this.search || ""}|${this.relationView}|${this.familyDetail}`; }

  positionDetail(lines, height) {
    const key = this.detailSearchKey();
    if (this.search && this.detailSearchLocated !== key) {
      const hit = lines.findIndex(line => line.matches?.length || matchRanges(line.text, this.search).length);
      if (hit >= 0) { this.scroll = Math.max(0, hit - 2); this.detailSearchLocated = key; }
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - height)));
  }

  scrollDetail(delta) {
    this.detailSearchLocated = this.detailSearchKey();
    this.scroll = Math.max(0, this.scroll + delta);
  }

  searchSnippet(text, width) {
    const range = matchRanges(text, this.search)[0];
    if (!range || strWidth(text.slice(0, range[1])) <= width) return truncate(text, width);
    const before = [...text.slice(0, range[0])].slice(-Math.max(0, Math.floor(width / 4))).join("");
    return truncate(`…${before}${text.slice(range[0])}`, width);
  }

  drawDetailLine(D, y, line) {
    this.screen.highlightedText(D.x + 2, y, truncate(line.text, D.w - 4), this.search, line.style, line.matches);
  }

  changeHistory(key) {
    if (this.scope !== "all") this.openHistory();
    const selected = this.current();
    if (key === "a") {
      const agents = ["all", ...adapters.ADAPTERS.map(a => a.id)];
      this.agentFilter = agents[(agents.indexOf(this.agentFilter) + 1) % agents.length];
    } else if (key === "v") this.historyView = this.historyView === "directory" ? "time" : "directory";
    else this.historyOrder = this.historyOrder === "newest" ? "oldest" : "newest";
    if (selected?.sessionOnly) this.expandedDirectories.add(directoryKey(selected.cwd));
    this.selected = Math.max(0, this.nodes().findIndex(n => n.id === selected?.id));
    this.top = 0;
    this.clampSelection();
  }

  // A node is hidden when any ancestor is collapsed.
  isVisible(node) {
    if (!this.collapsed.size) return true;
    const byId = this.byId();
    let cur = node;
    const guard = new Set();
    while (cur && cur.parentId && !guard.has(cur.id)) {
      guard.add(cur.id);
      if (this.collapsed.has(cur.parentId)) return false;
      cur = byId.get(cur.parentId);
    }
    return true;
  }

  byId() {
    if ((this.relationView && this.familyDetail) || (this.loader && this.scope === "lineage" && !this.relationView)) {
      this.contentRows(); return this._contentById;
    }
    if (!this._byId || this._byIdFor !== this.graph) {
      this._byId = new Map((this.graph?.nodes || []).map(n => [n.id, n]));
      this._byIdFor = this.graph;
    }
    return this._byId;
  }

  current() {
    const list = this.nodes();
    if (!list.length) return null;
    return list[Math.min(this.selected, list.length - 1)] || null;
  }

  clampSelection() {
    const n = this.nodes().length;
    if (this.selected >= n) this.selected = Math.max(0, n - 1);
    if (this.selected < 0) this.selected = 0;
    this.scroll = 0;
  }

  move(delta) {
    this.searchSelectionPending = false;
    const list = this.nodes();
    if (!list.length) return;
    this.selected = Math.max(0, Math.min(list.length - 1, this.selected + delta));
    this.scroll = 0;
  }

  // --- rendering ----------------------------------------------------------

  layout() {
    const w = this.screen.width;
    const h = this.screen.height;
    if (this.readerMode === "progress" && w < 96) return this.focus === "detail"
      ? { stacked: false, graph: { x: 0, y: 2, w: 0, h: 0 }, detail: { x: 0, y: 2, w, h: Math.max(0, h - 4) } }
      : { stacked: true, graph: { x: 0, y: 2, w, h: Math.max(0, h - 4) }, detail: null };
    if (this.relationView) {
      if (w < 96 && this.focus === "detail") return {
        stacked: false, graph: { x: 0, y: 2, w: 0, h: 0 }, detail: { x: 0, y: 2, w, h: Math.max(0, h - 4) },
      };
      if (w < 96) return { stacked: true, graph: { x: 0, y: 2, w, h: h >= 14 ? h - 9 : h - 4 },
        detail: h >= 14 ? { x: 0, y: h - 6, w, h: 4 } : null };
      const gw = Math.min(Math.floor(w * 0.6), w - 38);
      return { stacked: false, graph: { x: 0, y: 2, w: gw, h: h - 4 },
        detail: { x: gw + 1, y: 2, w: w - gw - 1, h: h - 4 } };
    }
    if (w < 72) return { stacked: true, graph: { x: 0, y: 2, w, h: h - 4 }, detail: null };
    const gw = Math.max(30, Math.min(Math.floor(w * 0.46), w - 32));
    return {
      stacked: false,
      graph: { x: 0, y: 2, w: gw, h: h - 4 },
      detail: { x: gw + 1, y: 2, w: w - gw - 1, h: h - 4 },
    };
  }

  render() {
    this.progressView.sync();
    const s = this.screen;
    s.clear();
    const { graph: G, detail: D, stacked } = this.layout();
    if (!D || (this.relationView && stacked)) this.focus = "graph";
    const w = s.width;

    // Header
    const agent = this.graph?.focusAgent ? adapters.byId(this.graph.focusAgent)?.label : "?";
    const sid = this.graph?.focusSessionId ? this.graph.focusSessionId.slice(0, 8) : "--------";
    s.text(1, 0, "Session Graph", { bold: true, fg: "cyan" });
    let rightX = w;
    if (this.graph) {
      const list = this.nodes();
      const n = list.length;
      const pos = n ? `${Math.min(this.selected + 1, n)}/${n}` : "0/0";
      const right = `${pos} ${this.relationView ? "visible" : this.scope === "all" ? "rows" : "nodes"}`;
      rightX = Math.max(15, w - strWidth(right) - 2);
      s.text(rightX, 0, right, { fg: "gray" });
    }
    s.text(15, 0, truncate(`${agent || ""} · ${sid} · ${this.relationView ? this.familyDetail ? "Family · detailed conversations" : "Family · session relationships" : SCOPE_LABEL[this.scope]}`, Math.max(0, rightX - 16)), { fg: "gray" });
    const headerWidth = D && !stacked ? Math.max(0, D.x - 2) : w - 2;
    if (this.relationView && this.graph) {
      const family = familyRows(this.graph, this.graph.focusAgent, this.graph.focusSessionId);
      const missing = family.filter(row => row.missing).length;
      const count = `${family.length - missing} sessions${missing ? ` · ${missing} missing parent` : ""}`;
      const root = family[0];
      if (root) s.text(1, 1, truncate(`Root: ${truncate(root.title || root.sessionId, Math.max(4, headerWidth - count.length - 31))} · ${this.relationId(root.sessionId)} · ${count}`, headerWidth), { fg: "cyan" });
    } else if (this.scope === "all" && this.graph) {
      const sessions = this.historySessions();
      const dirs = new Set(sessions.map(n => directoryKey(n.cwd))).size;
      const label = adapters.byId(this.agentFilter)?.label || "All";
      const filters = `agent: ${label} · ${this.historyView} · ${this.historyOrder}`;
      const count = `${sessions.length} sessions / ${dirs} dirs`;
      const summary = `${filters} · ${count}`;
      s.text(1, 1, truncate(strWidth(summary) <= headerWidth ? summary : `${count} · ${filters}`, headerWidth), { fg: "cyan" });
    } else if (this.graph) {
      const family = this.familyFor(this.graph.focusAgent, this.graph.focusSessionId);
      if (family.parent || family.children.length) s.text(1, 1, truncate(`${family.parent ? "1 parent · " : ""}${family.children.length} branches · f family · d details`, G.w - 2), { fg: "magenta" });
    }

    if (!this.graph) {
      this.renderEmpty();
      this.renderFooter();
      s.render();
      return;
    }

    if (this.readerMode === "progress") {
      if (this.relationView && this.familyDetail) this.requestDetails(familyRows(this.graph, this.graph.focusAgent, this.graph.focusSessionId), true);
      if (G.w) {
        if (this.relationView && !this.familyDetail) this.renderRelations(G);
        else this.renderGraph(G);
      }
      if (D) this.progressView.render(D);
    } else if (this.relationView) {
      if (this.familyDetail) {
        this.requestDetails(familyRows(this.graph, this.graph.focusAgent, this.graph.focusSessionId), true);
        this.renderGraph(G);
        if (D) {
          const node = this.current();
          if (node?.sessionBoundary || stacked) this.renderFamilyDetail(D, stacked);
          else this.renderDetail(D);
        }
      } else {
        this.renderRelations(G);
        if (D) this.renderFamilyDetail(D, stacked);
      }
    }
    else {
      if (this.scope === "lineage") this.requestDetails(familyRows(this.graph, this.graph.focusAgent, this.graph.focusSessionId), true);
      this.renderGraph(G);
      if (D) this.renderDetail(D);
    }
    if (D && !stacked) s.text(D.x + 2, 1, truncate(this.focus === "detail"
      ? `${this.readerMode === "progress" ? "Progress" : "Content"} [focused] · ↑/↓ scroll · Tab tree`
      : `${this.readerMode === "progress" ? "Progress" : "Content"} · Tab focus · ↑/↓ scroll`, D.w - 4), { fg: this.focus === "detail" ? "green" : "cyan", bold: true });
    // The help box is an overlay on top of the normal frame, drawn in the same
    // pass. Drawing it from the key handler would be wiped by the render that
    // immediately follows key handling.
    if (this.mode === "help") this.drawHelp();
    this.renderFooter();
    s.render();
  }

  renderEmpty() {
    const s = this.screen;
    const lines = String(this.emptyReason || "No session to show.").split("\n");
    lines.forEach((l, i) => s.text(2, 4 + i, l, { fg: "yellow" }));
  }

  // The tree view. Indentation follows the node's depth; connectors are drawn
  // only where a real parent/child link exists, so a linear session renders as
  // a clean flat list.
  renderGraph(G) {
    if (G.w <= 0 || G.h <= 0) return;
    const s = this.screen;
    const list = this.nodes();
    const byId = this.byId();

    if (!list.length) {
      s.text(G.x + 2, G.y + 1, this.search ? "No matches." : this.scope === "all" ? "No saved sessions found." : "This session has no turns yet.", { fg: "gray" });
      return;
    }

    const rows = G.h;
    if (this.top === undefined) this.top = 0;
    if (this.selected < this.top) this.top = Math.max(0, this.selected - 2);
    if (this.selected >= this.top + rows) this.top = this.selected - rows + 3;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, list.length - rows)));

    const INDENT = 2;
    const maxDepth = Math.floor(Math.max(0, G.w - 26) / INDENT);

    for (let i = 0; i < rows; i++) {
      const idx = this.top + i;
      const node = list[idx];
      const y = G.y + i;
      if (!node) continue;

      if (node.directoryOnly) {
        const style = idx === this.selected ? { bg: "blue", bold: true } : { fg: "cyan", bold: true };
        if (idx === this.selected) s.fill(G.x, y, G.w, 1, style);
        s.text(G.x + 1, y, node.expanded ? "▾" : "▸", style);
        const count = ` (${node.sessionCount})`;
        s.text(G.x + 3, y, truncate(node.cwd || "(unknown directory)", Math.max(1, G.w - 5 - count.length)) + count, style);
        continue;
      }

      const selected = idx === this.selected;
      const depth = Math.min(node.depth || 0, maxDepth);

      // A connector is drawn only where a real branch exists: the parent has
      // more than one child. A straight continuation gets no connector, so a
      // linear conversation reads as a clean list.
      const parent = node.parentId ? byId.get(node.parentId) : null;
      let conn = "";
      if (parent && (this.scope === "all" || parent.branchCount > 1 || node.sessionBoundary)) {
        const isLast = !list.slice(idx + 1).some(n => n.parentId === node.parentId);
        conn = isLast ? "└─" : "├─";
      }

      // Fold marker only on real branch points; a ▾ on every row is noise.
      const hasKids = node.branchCount > 1 || ((node.sessionOnly || node.sessionBoundary || node.forkedChildren?.length) && node.branchCount > 0);
      const unloadedForks = this.scope === "session" && node.forkedChildren?.length;
      const fold = hasKids || unloadedForks ? (unloadedForks || this.collapsed.has(node.id) ? "▸" : "▾") : "";

      if (selected) s.fill(G.x, y, G.w, 1, { bg: "blue", bold: true });
      const base = selected ? { bg: "blue", bold: true } : {};
      const dim = selected ? { bg: "blue", bold: true } : { fg: "gray" };

      // Prefix:  dot  indent  connector  fold  space  label
      const dotX = G.x + 1;
      const connX = dotX + 2 + depth * INDENT;
      const foldX = connX + conn.length;
      const labelX = foldX + (fold ? 2 : conn ? 1 : 0);
      const current = this.isCallerSession(node);
      const branch = node.sessionOnly && node.parentSessionId ? "[branch]" : node.forkedChildren?.length ? `[${node.forkedChildren.length} forks]` : "";
      const badges = [{ text: branch, fg: "magenta" }, { text: current ? "[current]" : "", fg: "green" }].filter(badge => badge.text);
      const badgeWidth = badges.reduce((sum, badge) => sum + badge.text.length + 1, 0);
      const room = G.w - (labelX - G.x) - 2 - badgeWidth;

      s.text(dotX, y, current ? "●" : "○", selected ? base : { fg: current ? "green" : "gray" });
      for (const guide of node.guideDepths || []) s.text(dotX + 2 + Math.min(guide, maxDepth) * INDENT, y, "│", dim);
      s.text(connX, y, conn, dim);
      s.text(foldX, y, fold, dim);

      // Prefer the human prompt; otherwise show the reply, and only fall back to
      // an explicit marker when the turn really carries nothing readable.
      const hasPrompt = !!(node.promptFull || node.prompt);
      let label = hasPrompt
        ? oneLine(node.prompt || node.promptFull)
        : oneLine(node.reply || node.replyFull || (node.contextOnly ? "(injected context only)" : "(no text)"));
      if (node.sessionOnly) label = `${node.timestamp.slice(5, 10)} ${adapters.byId(node.agent)?.label || node.agent} · ${label}`;
      if (node.sessionBoundary) label = `${node.parentSessionId ? "branch" : "session"} ${this.relationId(node.sessionId)} · ${node.title || node.agent}${node.contentState ? ` [${node.contentState}]` : ""}`;
      else if (this.relationView && this.familyDetail) label = `#${node.turnNumber}${this.showRelationTime ? ` · ${formatTime(node.timestamp)?.slice(5, 16) || "time ?"}` : ""} · ${label}`;
      const labelStyle = hasPrompt
        ? base
        : (selected ? base : { fg: "gray", italic: true });
      if (this.search && this.matchesSearch(node) && !matchRanges(label, this.search).length) {
        const source = [node.promptFull || node.prompt, node.replyFull || node.reply, node.title, node.sessionId, node.cwd, node.agent]
          .find(text => text && matchRanges(text, this.search).length);
        if (source) label = `↳ ${oneLine(source)}`;
      }
      s.highlightedText(labelX, y, this.searchSnippet(label, Math.max(1, room)), this.search, labelStyle);

      let badgeX = G.x + G.w - badgeWidth - 1;
      for (const badge of badges) {
        s.text(badgeX, y, badge.text, { ...base, fg: badge.fg, bold: true });
        badgeX += badge.text.length + 1;
      }
    }

    if (list.length > rows) {
      const frac = this.top / Math.max(1, list.length - rows);
      const barY = G.y + Math.round(frac * (rows - 1));
      s.text(G.x + G.w - 1, barY, "│", { fg: "cyan" });
    }
  }

  sessionTurns(meta, eager = false) {
    const key = `${meta.agent}:${meta.sessionId}`;
    const loaded = this.graph?.sessions?.get(key);
    if (loaded?.loaded) return loaded.turns;
    const saved = this.relationTurns.get(key);
    if (saved && saved.file === meta.file) return saved.turns;
    if (!eager || !meta.file) return null;
    const adapter = loaded?.adapter || adapters.byId(meta.agent);
    if (!adapter) return null;
    try {
      const turns = cachedParse(adapter, meta.file, this.store);
      this.relationTurns.set(key, { file: meta.file, turns });
      return turns;
    } catch (error) {
      this.relationTurns.set(key, { file: meta.file, turns: null, error: error.message });
      return null;
    }
  }

  relationInfo(row, eager = false) {
    const saved = this.graph?.edges?.get(`${row.agent}:${row.sessionId}`);
    if (this.loader) {
      if (eager) this.requestDetails([row]);
      return saved || { turn: null, number: null, pending: true, sharedTurns: null, addedTurns: null, totalTurns: null };
    }
    const records = recordsFor(this.graph);
    row = records.get(`${row.agent}:${row.sessionId}`) || row;
    if (eager) {
      this.sessionTurns(row, true);
      const parent = records.get(`${row.agent}:${row.parentSessionId}`);
      if (parent) this.sessionTurns(parent, true);
    }
    return edgeInfo(row, records, (meta, load) => this.sessionTurns(meta, load));
  }

  relationSummary(row) {
    const info = this.relationInfo(row);
    const children = this.familyFor(row.agent, row.sessionId).children.length;
    const parent = recordsFor(this.graph).get(`${row.agent}:${row.parentSessionId}`);
    const parts = [row.parentSessionId ? `from ${parent?.title || this.relationId(row.parentSessionId)}` : "root session"];
    if (info.sharedTurns !== null) parts.push(`${info.sharedTurns} shared`);
    if (info.addedTurns !== null) parts.push(`${info.addedTurns} new`);
    parts.push(`${children} children`);
    return parts.join(" · ");
  }

  relationLines(rows, sessionId, width) {
    const path = pathTo(rows, sessionId);
    const lines = [];
    const maxDepth = Math.max(1, Math.floor((width - 30) / 2));
    for (const row of rows) {
      const selected = row.sessionId === sessionId;
      const depth = Math.min(row.depth, maxDepth);
      const guide = Array.from({ length: Math.max(0, depth - 1) }, (_, i) => row.guideDepths.includes(i + 1) ? "│ " : "  ").join("");
      const color = { fg: path.has(row.id) ? "cyan" : "white", bold: path.has(row.id) };
      const prefix = row.parentId ? guide + (row.isLast ? "└─ " : "├─ ") : "";
      const fold = row.branchCount ? (row.folded ? "▸ " : "▾ ") : "";
      const current = this.isCallerSession(row);
      const marker = (selected ? "▶ " : current ? "● " : "○ ") + (current ? "[current] " : "");
      const live = !!this.livePaneFor(row.sessionId, row.agent);
      const info = row.parentSessionId && this.relationView ? this.relationInfo(row) : null;
      const point = info ? info.number ? ` [turn ${info.number}]` : info.error ? " [read error]" : info.parentUnavailable ? " [parent missing]" : info.pending ? " [loading…]" : " [turn ?]" : "";
      const suffix = ` · ${this.relationId(row.sessionId)}${point}${row.missing ? " [missing]" : live ? " [running]" : !row.parentId ? " [root]" : ""}`;
      const title = this.searchSnippet(row.title || "(unnamed)", Math.max(4, width - strWidth(prefix + marker + fold + suffix)));
      lines.push({ text: prefix + marker + fold + title + suffix, style: selected ? { bg: "blue", bold: true } : color,
        id: row.id, selected, currentAt: current ? prefix.length + 2 : null });
    }
    return lines;
  }

  drawRelationLine(x, y, line, width) {
    const text = truncate(line.text, width);
    this.screen.highlightedText(x, y, text, this.search, line.style);
    if (line.currentAt !== null) this.screen.text(x + strWidth(text.slice(0, line.currentAt)), y,
      text.slice(line.currentAt, line.currentAt + "[current]".length), { ...line.style, fg: "green", bold: true }, 3);
  }

  relationId(sessionId) {
    if (this._relationIdsFor !== this.graph) {
      this._relationIds = shortIds(recordsFor(this.graph).values());
      this._relationIdsFor = this.graph;
    }
    return this._relationIds.get(sessionId) || sessionId.slice(0, 8);
  }

  renderRelations(G) {
    const rows = this.nodes(), node = this.current();
    const family = familyRows(this.graph, this.graph.focusAgent, this.graph.focusSessionId);
    if (this.readerMode !== "progress") this.requestDetails(node ? [node, ...family.filter(row => row.id !== node.id)] : family);
    if (!node) { this.screen.text(2, G.y + 1, this.search ? "No matching sessions." : "No session relationships to show.", { fg: "gray" }); return; }
    const lines = this.relationLines(rows, node.sessionId, G.w - 4);
    const first = lines.findIndex(line => line.id === node.id);
    const last = lines.findLastIndex(line => line.id === node.id);
    if (first < this.top) this.top = first;
    if (last >= this.top + G.h) this.top = last - G.h + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, lines.length - G.h)));
    for (let i = 0; i < G.h; i++) {
      const line = lines[this.top + i];
      if (!line) break;
      if (line.selected) this.screen.fill(G.x, G.y + i, G.w, 1, line.style);
      this.drawRelationLine(G.x + 2, G.y + i, line, G.w - 4);
    }
    if (lines.length > G.h) {
      const frac = this.top / Math.max(1, lines.length - G.h);
      this.screen.text(G.x + G.w - 1, G.y + Math.round(frac * (G.h - 1)), "│", { fg: "cyan" });
    }
  }

  renderFamilyDetail(D, stacked = false) {
    const node = this.current();
    if (!node) return;
    const s = this.screen;
    if (stacked) s.text(D.x, D.y - 1, "─".repeat(D.w), { fg: "gray" });
    else for (let y = D.y; y < D.y + D.h; y++) s.text(D.x, y, "│", { fg: "gray" });
    const info = this.relationInfo(node);
    const { parent, children } = this.familyFor(node.agent, node.sessionId);
    const time = formatTime(info.turn?.timestamp) || (info.pending ? "turn time not loaded" : "turn time not recorded");
    const lines = [];
    const add = (text, style = {}) => {
      for (const line of wrapMatches(text, Math.max(1, D.w - 4), this.search)) lines.push({ ...line, style });
    };
    const heading = { fg: "magenta", bold: true };
    this.requestDetails([recordsFor(this.graph).get(`${node.agent}:${node.sessionId}`) || node], true);
    const content = this.familyContent(node);
    if (stacked) {
      lines.push({ text: `${node.title || node.sessionId} · ${this.relationId(node.sessionId)}`, style: { fg: "cyan", bold: true } });
      lines.push({ text: node.parentSessionId ? `from ${this.relationId(node.parentSessionId)} · ${branchLabel(info)}` : "Root of this family", style: {} });
      if (this.showRelationTime) lines.push({ text: node.parentSessionId ? time : `created ${formatTime(node.timestamp) || "not recorded"}`, style: { fg: "gray" } });
      lines.push({ text: this.familyDetail && !node.sessionBoundary ? `#${node.turnNumber} ${node.prompt || node.reply || "(no text)"}` : content?.turns?.[0]?.prompt || this.relationSummary(node), style: { fg: "cyan" } });
    } else {
      add("Selected session", heading);
      add(node.title || "(unnamed)", { fg: "cyan", bold: true });
      add(`${adapters.byId(node.agent)?.label || node.agent} · ${this.relationId(node.sessionId)}`, { fg: "gray" });
      add("");
      if (node.missing) add("This parent session is not on disk.", { fg: "yellow" });
      else if (node.parentSessionId) {
        add("Parent session", heading);
        add(`${parent?.title || "(not on disk)"} · ${this.relationId(node.parentSessionId)}`);
        add(branchLabel(info), { fg: "cyan" });
        if (this.showRelationTime) add(time, { fg: "gray" });
      } else {
        add("Root of this family", { fg: "cyan" });
        if (info.error) add(info.error, { fg: "yellow" });
        if (this.showRelationTime) add(`created ${formatTime(node.timestamp) || "not recorded"}`, { fg: "gray" });
      }
      add("");
      add("Conversation", heading);
      add(`${info.sharedTurns === null ? "?" : info.sharedTurns} inherited · ${info.addedTurns === null ? "?" : info.addedTurns} new · ${info.totalTurns ?? "?"} total`);
      if (!content) add("Loading conversation…", { fg: "gray" });
      else if (content.error) add(`Read failed: ${content.error}`, { fg: "yellow" });
      else if (!content.turns.length) add("No turns recorded", { fg: "gray" });
      else {
        const inherited = info.sharedTurns || 0;
        if (inherited) add(`${inherited} inherited turns · Enter full history`, { fg: "gray" });
        if (inherited === content.turns.length) add("No new turns in this branch", { fg: "gray" });
        content.turns.slice(inherited).forEach((turn, index, turns) => {
          add(`${index === turns.length - 1 ? "└─" : "├─"} #${index + inherited + 1} ${oneLine(turn.prompt || turn.promptFull || "(no prompt)")}`, { fg: "green" });
          if (this.showRelationTime) add(`   ${formatTime(turn.timestamp) || "time not recorded"}`, { fg: "gray" });
          if (turn.reply || turn.replyFull) add(`   ${oneLine(turn.reply || turn.replyFull)}`);
        });
      }
      add("d detailed tree · Enter full session", { fg: "yellow" });
      add("");
      add(`Child branches · ${children.length}`, heading);
      if (!children.length) add("No child branches", { fg: "gray" });
      for (const child of children.slice(0, 4)) {
        const point = this.relationInfo(child);
        add(`↳ ${child.title || "(unnamed)"} · ${this.relationId(child.sessionId)} · ${point.number ? `turn ${point.number}` : point.pending ? "loading…" : "turn ?"}`);
      }
      if (children.length > 4) add(`${children.length - 4} more in the family tree`, { fg: "gray" });
      add("");
      add(`cwd  ${node.cwd || "?"}`, { fg: "gray" });
      add(`id   ${node.sessionId}`, { fg: "gray" });
      add("");
      add(`Enter read · T ${this.showRelationTime ? "hide" : "show"} time`, { fg: "yellow" });
    }
    const maxScroll = Math.max(0, lines.length - D.h);
    if (!stacked) this.positionDetail(lines, D.h);
    for (let i = 0; i < D.h; i++) {
      const line = lines[(stacked ? 0 : this.scroll) + i];
      if (line) this.drawDetailLine(D, D.y + i, line);
    }
    if (maxScroll && !stacked) s.text(D.x + D.w - 1, D.y + Math.round(this.scroll / maxScroll * (D.h - 1)), "│", { fg: "cyan" });
  }

  renderRelationPreview(node, D) {
    if (D.h < 10) return 0;
    const rows = familyRows(this.graph, node.agent, node.sessionId);
    const selected = rows.find(row => row.sessionId === node.sessionId);
    if (!selected || (!selected.parentSessionId && !selected.branchCount)) return 0;
    const info = this.relationInfo(selected, true);
    const context = previewRows(rows, node.sessionId);
    const lines = this.relationLines(context, node.sessionId, D.w - 4);
    const budget = Math.max(1, Math.min(7, D.h - 10));
    const selectedLine = lines.findIndex(line => line.selected);
    const start = Math.max(0, selectedLine - budget + 3);
    const visible = lines.slice(start, start + budget);
    this.screen.text(D.x + 2, D.y, `─ relationships · T ${this.showRelationTime ? "hide" : "show"} time ─`, { fg: "magenta", bold: true });
    visible.forEach((line, i) => this.drawRelationLine(D.x + 2, D.y + 1 + i, line, D.w - 4));
    let y = D.y + 1 + visible.length;
    if (selected.parentSessionId) this.screen.text(D.x + 2, y++, truncate(branchLabel(info), D.w - 4), { fg: "cyan" });
    if (this.showRelationTime) this.screen.text(D.x + 2, y++, truncate(selected.parentSessionId
      ? formatTime(info.turn?.timestamp) || (info.pending ? "turn time not loaded" : "turn time not recorded")
      : `created ${formatTime(selected.timestamp) || "not recorded"}`, D.w - 4), { fg: "gray" });
    this.screen.text(D.x + 2, y++, truncate(this.relationSummary(selected), D.w - 4), { fg: "cyan" });
    this.screen.text(D.x + 2, y++, `f full family · d details · ${rows.length} sessions`, { fg: "yellow" });
    return y - D.y + 1;
  }

  renderDetail(D) {
    const s = this.screen;
    const node = this.current();
    if (this.scope !== "all") s.text(D.x, 1, "─".repeat(Math.max(0, D.w - 1)), { fg: "gray" });
    if (!node) {
      s.text(D.x + 2, 2, "Select a node to read it.", { fg: "gray" });
      return;
    }

    const lines = [];
    if (node.directoryOnly) {
      for (const line of wrap(node.cwd || "(unknown directory)", D.w - 4)) lines.push({ text: line, style: { bold: true, fg: "cyan" } });
      lines.push({ text: `${node.sessionCount} saved sessions`, style: { fg: "gray" } });
      lines.push({ text: `Latest activity: ${node.timestamp.slice(0, 19).replace("T", " ")} UTC`, style: { fg: "gray" } });
      lines.push({ text: "Enter: open / close directory", style: { fg: "yellow" } });
      lines.push({ text: "h / l: collapse / expand", style: { fg: "yellow" } });
      lines.forEach((line, i) => s.text(D.x + 2, D.y + i, truncate(line.text, D.w - 3), line.style));
      return;
    }
    const previewHeight = this.relationView && this.familyDetail ? 0 : this.renderRelationPreview(node, D);
    D = { ...D, y: D.y + previewHeight, h: Math.max(0, D.h - previewHeight) };
    if (node.title) for (const line of wrapMatches(node.title, D.w - 4, this.search)) lines.push({ ...line, style: { bold: true, fg: "cyan" } });
    const ts = node.timestamp ? node.timestamp.slice(0, 19).replace("T", " ") : "";
    lines.push({ text: `${node.sessionOnly || node.sessionBoundary ? "Session" : `#${node.turnNumber || node.index + 1}`}  ${this.relationView && !this.showRelationTime ? "" : ts + (ts ? " UTC" : "")}`, style: { fg: "gray" } });
    lines.push({ text: "", style: {} });

    if (node.sessionBoundary) {
      lines.push({ text: "Enter: read this session's full history", style: { fg: "yellow" } });
      if (node.parentSessionId) {
        lines.push({ text: `fork point: ${node.forkLocation === "unknown" ? "not recorded" : node.forkLocation || "not recorded"}`, style: { fg: "gray" } });
        lines.push({ text: `inherited turns: ${node.sharedTurns || 0}`, style: { fg: "gray" } });
        const point = this.byId().get(node.forkPointId);
        if (point) for (const text of wrap(`from: ${point.prompt || point.reply || point.key}`, D.w - 4)) lines.push({ text, style: { fg: "gray" } });
      }
    } else if (node.sessionOnly) {
      for (const text of ["Enter: read this session", "R: rename its native session name",
        node.agent === "dst" ? "n: open the native DST history picker" : "n: resume in the current agent pane",
        node.readError || (node.archived ? "Archived session" : "")]) {
        if (text) for (const line of wrap(text, D.w - 4)) lines.push({ text: line, style: { fg: "yellow" } });
      }
    } else {
      lines.push({ text: "❯ you", style: { bold: true, fg: "green" } });
      for (const line of wrapMatches(node.promptFull || node.prompt || "(no prompt)", D.w - 4, this.search)) {
        lines.push({ ...line, style: {} });
      }
      lines.push({ text: "", style: {} });

      lines.push({ text: "● assistant", style: { bold: true, fg: "cyan" } });
      const reply = node.replyFull || node.reply;
      if (reply) {
        for (const line of wrapMatches(reply, D.w - 4, this.search)) lines.push({ ...line, style: {} });
      } else {
        lines.push({ text: "(no reply recorded)", style: { fg: "gray", italic: true } });
      }
    }

    lines.push({ text: "", style: {} });
    lines.push({ text: "─ meta ─", style: { fg: "gray" } });
    const agent = adapters.byId(node.agent);
    const meta = [
      `agent   ${agent?.label || node.agent}`,
      `session ${node.sessionId}`,
      ...(node.parentSessionId ? [`parent  ${node.parentSessionId}`] : []),
      `cwd     ${node.cwd || "?"}`,
      `turn    ${node.key}`,
      node.sessionOnly || node.sessionBoundary ? "state   saved session" : "state   selected turn",
    ];
    if (node.forkedChildren?.length) {
      meta.push(`forks   ${node.forkedChildren.length} child session(s)`);
    }
    const live = this.livePaneFor(node.sessionId, node.agent);
    meta.push(live ? `live    ${live.pane_id} (Enter jumps here)` : "live    not running");
    for (const m of meta) lines.push({ text: m, style: { fg: "gray" } });

    const viewH = D.h;
    const maxScroll = Math.max(0, lines.length - viewH);
    this.positionDetail(lines, viewH);

    for (let i = 0; i < viewH; i++) {
      const line = lines[this.scroll + i];
      if (!line) break;
      this.drawDetailLine(D, D.y + i, line);
    }
    if (lines.length > viewH) {
      const frac = this.scroll / Math.max(1, maxScroll);
      s.text(D.x + D.w - 1, D.y + Math.round(frac * (viewH - 1)), "│", { fg: this.focus === "detail" ? "green" : "gray" });
    }
  }

  renderFooter() {
    const s = this.screen;
    const y = s.height - 1;
    const sep = s.height - 2;
    s.text(0, sep, "─".repeat(s.width), { fg: "gray" });
    if (this.loading || this.scanStatus) s.text(1, sep, truncate(` ${this.loading || this.scanStatus} · q close `, s.width - 2), { fg: "cyan" });
    if (this.message && Date.now() < this.messageUntil) {
      s.text(1, s.height - 3, truncate(this.message, s.width - 2), { bold: true, fg: "yellow" });
    }

    if (this.mode === "search" || this.mode === "rename" || this.mode === "progress-search") {
      const input = this.mode === "rename" ? this.renameInput : this.mode === "progress-search" ? this.progressView.queryInput : this.searchInput;
      const prefix = this.mode === "rename" ? "Name: " : "/ ";
      s.text(1, y, truncate(prefix + input, Math.max(1, s.width - 2)), { bold: true, fg: "yellow" });
      s.text(prefix.length + 2 + strWidth(input), y, `  (Enter to ${this.mode === "rename" ? "save" : "search"}, Esc to cancel)`, { fg: "gray" });
      return;
    }
    if (this.mode === "renaming") { s.text(1, y, "Saving native session name…", { fg: "yellow" }); return; }
    if (this.mode === "switching") { s.text(1, y, "Switching the current agent pane…", { fg: "yellow" }); return; }
    if (this.mode === "help") {
      s.text(1, y, "j/k or PgUp/PgDn scroll · Esc/? close help · q quit", { fg: "gray" });
      return;
    }

    if (this.readerMode === "progress") {
      s.text(1, y, truncate("c current · m full · p filter · r refresh · G follow · Tab tree/content · / find · Esc back · q close", s.width - 2), { fg: "green" });
      return;
    }
    if (this.progressView.pendingFull || this.progressView.fullError) s.text(1, sep,
      truncate(this.progressView.fullError ? ` Refresh failed: ${this.progressView.fullError} · r retry` : " Updating full output; showing previous snapshot…", s.width - 2), { fg: "yellow" });

    const hint = this.relationView ? this.focus === "detail" ? "j/k scroll · Tab tree · d toggle detail tree · T time"
      : `j/k ${this.familyDetail ? "turns" : "sessions"} · d ${this.familyDetail ? "structure" : "detail tree"} · h/l fold · Enter read · T time · Tab content · / find · F fork`
      : this.scope === "all" ? "j/k move · Enter open · f family · d details · T time · a agent · v view · o sort · / find · R rename · n resume" : this.focus === "graph"
      ? "j/k move · h/l fold · f family · d details · T time · Enter jump · s history · R rename · / find · n resume · F fork · Tab content"
      : "j/k scroll · PgUp/PgDn page · Tab back to graph";
    const navigation = this.navigationStack.length ? "Backspace/Esc back · q close · ? help · " : "Esc/q close · ? help · ";
    s.text(1, y, truncate("c current · m progress · " + navigation + hint, s.width - 2), { fg: this.focus === "graph" ? "white" : "green" });

  }

  // Draw the help box into the current buffer. Called from render() so it
  // composites over the normal frame. The layer is raised so the box is opaque:
  // the graph and detail panes are painted first and then fully covered.
  drawHelp() {
    const s = this.screen;
    const w = Math.min(58, s.width - 4);
    const h = Math.min(HELP.length + 4, s.height - 2);
    const x = Math.max(0, Math.floor((s.width - w) / 2));
    const y = Math.max(0, Math.floor((s.height - h) / 2));
    const box = { bg: "black" };
    s.layer = 1;
    try {
      s.fill(x, y, w, h, box);
      s.text(x, y, `┌${"─".repeat(Math.max(0, w - 2))}┐`, { fg: "cyan", bg: "black" });
      s.text(x, y + h - 1, `└${"─".repeat(Math.max(0, w - 2))}┘`, { fg: "cyan", bg: "black" });
      for (let row = y + 1; row < y + h - 1; row++) {
        s.text(x, row, "│", { fg: "cyan", bg: "black" });
        s.text(x + w - 1, row, "│", { fg: "cyan", bg: "black" });
      }
      s.text(x + 2, y, " Session Graph — keys ", { bold: true, fg: "cyan", bg: "black" });
      this.helpTop = Math.max(0, Math.min(this.helpTop, Math.max(0, HELP.length - (h - 3))));
      HELP.slice(this.helpTop, this.helpTop + h - 3).forEach(([k, d], i) => {
        s.text(x + 3, y + 2 + i, pad(k, 12), { bold: true, fg: "yellow", bg: "black" });
        s.text(x + 15, y + 2 + i, truncate(d, Math.max(0, w - 17)), box);
      });
    } finally {
      s.layer = 0;
    }
  }

  // --- actions ------------------------------------------------------------

  livePaneFor(sessionId, agent) {
    return this.panes.find(p => {
      const reportedAgent = p.agent_session?.agent || p.agent;
      return p.agent_session?.value === sessionId && (!agent || !reportedAgent || adapters.forAgent(reportedAgent)?.id === agent);
    }) || null;
  }

  familyFor(agent, sessionId) {
    const records = this.graph?.sessionMeta || new Map();
    const meta = records.get(`${agent}:${sessionId}`);
    const parent = meta?.parentSessionId ? records.get(`${agent}:${meta.parentSessionId}`) || { sessionId: meta.parentSessionId, title: "(not on disk)" } : null;
    const children = [...records.values()].filter(m => m.agent === agent && m.parentSessionId === sessionId);
    return { parent, children };
  }

  notify(text, ms = 2500) {
    this.message = text;
    this.messageUntil = Date.now() + ms;
  }

  rememberPage() {
    // Keep the loaded graph, but copy mutable sets before a new page clears them.
    this.navigationStack.push({
      graph: this.graph, scope: this.scope, activeSession: this.activeSession,
      relationView: this.relationView,
      familyDetail: this.familyDetail,
      selected: this.selected, top: this.top, scroll: this.scroll, focus: this.focus,
      selectedId: this.current()?.id,
      search: this.search, searchInput: this.searchInput,
      detailSearchLocated: this.detailSearchLocated, searchSelectionPending: this.searchSelectionPending,
      collapsed: new Set(this.collapsed), expandedDirectories: new Set(this.expandedDirectories),
      historyView: this.historyView, historyOrder: this.historyOrder, agentFilter: this.agentFilter,
      historyInitialized: this.historyInitialized, cwd: this.cwd, emptyReason: this.emptyReason,
      progressState: this.progressView.save(),
    });
  }

  goBack() {
    const saved = this.navigationStack.pop();
    if (!saved) { this.notify("Already at the first page. Press q to close."); return; }
    const { selectedId, progressState, ...previous } = saved;
    this.progressView.restore(progressState);
    if (this.loader) {
      this.loader.send({ type: "cancel", id: ++this.loadId });
      this.detailRequests.clear();
      this.loading = null;
    }
    Object.assign(this, previous);
    if (this.loader && !this.graph) this.loadBackground();
    const index = this.nodes().findIndex(row => row.id === selectedId);
    if (index >= 0) this.selected = index;
    this.selected = Math.max(0, Math.min(this.selected, this.nodes().length - 1));
    this.detailSearchLocated = this.detailSearchKey();
    this.message = null;
    this.messageUntil = 0;
  }

  openCurrentSession() {
    this.progressView.followNext = true;
    const pane = this.callerPane();
    this.updateCaller(pane);
    if (!this.initialSession) {
      this.notify("Current session ID unavailable. Open the graph from an agent pane with a reported session ID.", 6000);
      return;
    }
    if (this.graph && (this.scope !== "session" || this.relationView ||
        !this.isCallerSession({ agent: this.graph.focusAgent, sessionId: this.graph.focusSessionId }))) this.rememberPage();
    this.activeSession = { ...this.initialSession };
    this.scope = "session";
    this.relationView = this.familyDetail = false;
    this.search = this.detailSearchLocated = null;
    this.searchInput = "";
    this.searchSelectionPending = false;
    this.collapsed.clear();
    this.focus = this.readerMode === "progress" ? "detail" : "graph";
    this.load();
  }

  jump() {
    const node = this.current();
    if (!node) return;
    if (node.directoryOnly) { this.toggleFold(); return; }
    if (this.relationView && this.familyDetail && !node.sessionBoundary) {
      this.focus = "detail";
      return;
    }
    if (node.sessionOnly || node.sessionBoundary) {
      if (node.missing) { this.notify("This parent session is not on disk."); return; }
      this.rememberPage();
      this.activeSession = { agent: node.agent, value: node.sessionId, file: node.file };
      this.scope = "session";
      this.relationView = false;
      this.search = null;
      this.collapsed.clear();
      this.focus = "graph";
      this.load();
      return;
    }
    const pane = this.livePaneFor(node.sessionId, node.agent);
    if (!pane) {
      this.notify(`Session ${node.sessionId.slice(0, 8)} is not running. Press n to resume in the current agent pane.`, 4000);
      return;
    }
    try {
      this.herdr.focusPane(pane.pane_id);
      this.notify(`Jumped to ${pane.pane_id}`);
      // The overlay has served its purpose; close it so the user lands on the
      // session they picked.
      setTimeout(() => this.quit(), 150);
    } catch (err) {
      this.notify(`Focus failed: ${err.message}`, 4000);
    }
  }

  switchTarget(node) {
    if (!node || node.directoryOnly) throw new Error("Select a session inside the directory first.");
    if (node.missing) throw new Error("This parent session is not on disk.");
    const pane = this.callerPane();
    if (!pane?.pane_id) throw new Error("Open the graph from the agent pane you want to switch.");
    const agent = adapters.forAgent(pane.agent_session?.agent || pane.agent);
    if (agent?.id !== node.agent) throw new Error(`Open the graph from a ${adapters.byId(node.agent)?.label || node.agent} pane.`);
    if (pane.agent_status !== "idle") throw new Error("The current agent must be idle before switching sessions.");
    if (node.agent !== "dst" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(node.sessionId)) throw new Error("Invalid native session ID.");
    return pane;
  }

  switchInPane(pane, command) {
    this.herdr.runInPane(pane.pane_id, command);
    this.herdr.focusPane(pane.pane_id);
    setTimeout(() => this.quit(), 150);
  }

  resumeInPane() {
    const node = this.current();
    try {
      const pane = this.switchTarget(node);
      this.panes = this.herdr.paneList();
      const live = this.livePaneFor(node.sessionId, node.agent);
      if (live && live.pane_id !== pane.pane_id) throw new Error("Session is already running in another pane. Enter on a turn jumps to it.");
      // DST's /resume opens its native picker; it does not accept a session ID.
      const command = node.agent === "dst" ? "/resume" : `/resume ${node.sessionId}`;
      this.switchInPane(pane, command);
    } catch (err) { this.notify(`Resume failed: ${err.message}`, 6000); }
  }

  async forkFromNode() {
    const node = this.current();
    let childId;
    try {
      const pane = this.switchTarget(node);
      if (node.agent === "claude") {
        if (pane.agent_session?.value !== node.sessionId) throw new Error("Resume this Claude session first, then use F (Shift+F) to branch the current session.");
        this.switchInPane(pane, "/branch");
        return;
      }
      if (node.agent !== "codex") throw new Error("Use this agent's native session menu to fork.");
      this.mode = "switching";
      childId = await this.forkSession({ agent: node.agent, sessionId: node.sessionId }, { env: this.env });
      const current = this.switchTarget(node);
      if (current.pane_id !== pane.pane_id || current.agent_session?.value !== pane.agent_session?.value) throw new Error("The caller session changed while forking.");
      this.switchInPane(current, `/resume ${childId}`);
    } catch (err) {
      this.notify(`Fork failed: ${err.message}${childId ? ` Saved fork: ${childId}` : ""}`, 8000);
    } finally { this.mode = "browse"; }
  }

  toggleFold(expand) {
    const node = this.current();
    if (!node) return;
    if (node.directoryOnly) {
      const open = expand ?? !this.expandedDirectories.has(node.directoryKey);
      if (open) this.expandedDirectories.add(node.directoryKey);
      else this.expandedDirectories.delete(node.directoryKey);
      this.clampSelection();
      return;
    }
    if (expand && this.scope === "session" && node.forkedChildren?.length) { this.openLineage(); return; }
    if (!(node.branchCount > 1 || ((node.sessionOnly || node.sessionBoundary || node.forkedChildren?.length) && node.branchCount > 0))) {
      this.notify("This node has no children to fold.");
      return;
    }
    const open = expand ?? this.collapsed.has(node.id);
    if (open) this.collapsed.delete(node.id);
    else this.collapsed.add(node.id);
    this.clampSelection();
  }

  cycleScope() {
    const previousScope = this.scope;
    this.rememberPage();
    this.relationView = false;
    this.search = null;
    this.collapsed.clear();
    this.focus = "graph";
    const i = SCOPES.indexOf(this.scope);
    this.scope = SCOPES[(i + 1) % SCOPES.length];
    this.load();
    // Missing caller identity can leave us on the same history page.
    if (this.scope === previousScope) this.navigationStack.pop();
    this.notify(`Scope: ${SCOPE_LABEL[this.scope]}`);
  }

  openHistory() {
    if (this.scope === "all") return;
    this.rememberPage();
    this.relationView = false;
    this.scope = "all";
    this.search = null;
    this.collapsed.clear();
    this.focus = "graph";
    this.load();
  }

  openLineage() {
    const node = this.current();
    if (!node || node.directoryOnly) { this.notify("Select a session to view its branches."); return; }
    if (this.relationView) return;
    this.rememberPage();
    this.activeSession = { agent: node.agent, value: node.sessionId, file: node.file };
    this.scope = "lineage";
    this.relationView = true;
    this.familyDetail = false;
    this.search = null;
    this.collapsed.clear();
    this.focus = "graph";
    this.load();
    if (!this.graph || this.scope !== "lineage") return;
    this.relationView = true;
    const index = this.nodes().findIndex(n => n.sessionId === node.sessionId);
    if (index >= 0) this.selected = index;
    this.top = 0;
    this.clampSelection();
  }

  toggleFamilyDetail() {
    if (!this.relationView) { this.openLineage(); if (!this.relationView) return; }
    const node = this.current();
    this.familyDetail = !this.familyDetail;
    this.search = null;
    this.collapsed.clear();
    this.focus = "graph";
    const rows = this.nodes();
    this.selected = Math.max(0, rows.findIndex(row => row.sessionId === node?.sessionId && row.sessionBoundary));
    this.top = this.scroll = 0;
  }

  beginRename() {
    const node = this.current();
    if (!node) return;
    if (node.directoryOnly) { this.notify("Select a session inside the directory to rename."); return; }
    if (node.missing) { this.notify("This parent session is not on disk."); return; }
    this.renameTarget = { agent: node.agent, sessionId: node.sessionId, file: node.file };
    this.renameInput = node.title || "";
    this.mode = "rename";
  }

  async saveRename() {
    this.mode = "renaming";
    try {
      const title = await this.renameSession(this.renameTarget, this.renameInput, { env: this.env });
      const { agent, sessionId } = this.renameTarget;
      this.renamedTitles.set(`${agent}:${sessionId}`, title);
      this.loader?.send({ type: "rename", key: `${agent}:${sessionId}`, title });
      const graphs = new Set([this.graph, ...this.navigationStack.map(page => page.graph)]);
      this._contentFor = null;
      const catalogEntry = this.catalog.get(`${agent}:${sessionId}`);
      if (catalogEntry) catalogEntry.title = title;
      for (const graph of graphs) {
        for (const node of graph?.nodes || []) {
          if (node.agent === agent && node.sessionId === sessionId) {
            node.title = title;
            if (node.sessionOnly) node.prompt = title;
          }
          for (const child of node.forkedChildren || []) {
            if (child.agent === agent && child.sessionId === sessionId) child.title = title;
          }
        }
        const meta = graph?.sessionMeta?.get(`${agent}:${sessionId}`);
        if (meta) meta.title = title;
        const entry = graph?.sessions?.get(`${agent}:${sessionId}`);
        if (entry?.meta) entry.meta.title = title;
      }
      this.notify(`Session renamed: ${title}`, 5000);
      this.mode = "browse";
    } catch (error) {
      this.mode = "rename";
      this.notify(`Rename failed: ${error.message}`, 7000);
    }
  }

  // --- input --------------------------------------------------------------

  handleKey(key) {
    if (key.name === "ctrl-c") { this.quit(); return; }
    if (this.progressView.handleKey(key)) return;
    if (this.mode === "renaming" || this.mode === "switching") return;
    if (this.mode === "rename") {
      if (key.name === "enter") return this.saveRename();
      if (key.name === "escape") { this.mode = "browse"; this.renameInput = ""; }
      else if (key.name === "backspace") this.renameInput = [...this.renameInput].slice(0, -1).join("");
      else if (key.name === "ctrl-u") this.renameInput = "";
      else if (key.printable) this.renameInput += key.raw;
      return;
    }
    if (this.mode === "help") {
      if (["j", "down", "pagedown"].includes(key.name)) this.helpTop += key.name === "pagedown" ? 10 : 1;
      else if (["k", "up", "pageup"].includes(key.name)) this.helpTop = Math.max(0, this.helpTop - (key.name === "pageup" ? 10 : 1));
      else if (key.name === "q") this.quit();
      else this.mode = "browse";
      return;
    }
    if (this.mode === "search") {
      if (key.name === "enter") {
        this.search = this.searchInput.trim() || null;
        if (this.scope === "all" && this.search) for (const node of this.historySessions()) this.expandedDirectories.add(directoryKey(node.cwd));
        if (this.relationView && this.search) this.collapsed.clear();
        this.mode = "browse";
        this.selected = 0;
        this.clampSelection();
        this.detailSearchLocated = null;
        this.selectSearchMatch();
      } else if (key.name === "escape") {
        this.mode = "browse";
        this.searchInput = "";
      } else if (key.name === "backspace") {
        this.searchInput = [...this.searchInput].slice(0, -1).join("");
      } else if (key.name === "ctrl-u") {
        this.searchInput = "";
      } else if (key.printable) {
        this.searchInput += key.raw;
      }
      return;
    }

    switch (key.name) {
      case "q": case "ctrl-c":
        this.quit(); return;
      case "escape":
        if (this.navigationStack.length) this.goBack(); else this.quit();
        return;
      case "backspace":
        this.goBack(); return;
      case "?":
        this.mode = "help"; this.helpTop = 0; return;
      case "j": case "down":
        if (this.focus === "detail") this.scrollDetail(1); else this.move(1);
        return;
      case "k": case "up":
        if (this.focus === "detail") this.scrollDetail(-1); else this.move(-1);
        return;
      case "pagedown":
        if (this.focus === "graph") { this.move(Math.max(1, this.layout().graph.h - 1)); return; }
        this.scrollDetail(10); return;
      case "pageup":
        if (this.focus === "graph") { this.move(-Math.max(1, this.layout().graph.h - 1)); return; }
        this.scrollDetail(-10); return;
      case "h": case "left":
        if (this.focus === "graph") this.toggleFold(false);
        return;
      case "l": case "right":
        if (this.focus === "graph") this.toggleFold(true);
        return;
      case "g": case "home":
        if (this.focus === "detail") { this.scrollDetail(-this.scroll); return; }
        this.selected = 0; this.clampSelection(); return;
      case "G": case "end":
        if (this.focus === "detail") { this.scrollDetail(Number.MAX_SAFE_INTEGER); return; }
        this.selected = Math.max(0, this.nodes().length - 1); this.clampSelection(); return;
      case "tab": case "shift-tab":
        if (this.relationView && this.screen.width < 96) {
          this.focus = this.focus === "graph" ? "detail" : "graph";
          return;
        }
        if (!this.layout().detail || (this.relationView && this.layout().stacked)) return;
        this.focus = this.focus === "graph" ? "detail" : "graph";
        return;
      case "enter":
        this.jump(); return;
      case "n":
        this.resumeInPane(); return;
      case "f":
        this.openLineage(); return;
      case "F":
        return this.forkFromNode();
      case "d":
        this.toggleFamilyDetail(); return;
      case "t":
        this.cycleScope(); return;
      case "s":
        this.openHistory(); return;
      case "c":
        this.openCurrentSession(); return;
      case "b":
        this.openLineage(); return;
      case "T":
        this.showRelationTime = !this.showRelationTime; return;
      case "a": case "v": case "o":
        this.changeHistory(key.name); return;
      case "R":
        this.beginRename(); return;
      case "/":
        this.mode = "search";
        this.searchInput = this.search || "";
        return;
      case "K":
        this.notify("Run the 'Bind session-graph keys' action to rebind, or edit the managed block in config.toml.", 6000);
        return;
      default:
        return;
    }
  }

  quit() {
    this.closed = true;
    this.progressView.stop();
    clearInterval(this.timer);
    this.screen.stop();
    if (this.loader) void this.loader.close();
    process.exit(0);
  }

  run() {
    this.screen.start();

    // Without a TTY there is no way to receive keys, so render one frame and
    // exit instead of hanging. This also makes the pane scriptable for tests.
    if (!this.screen.input.isTTY) {
      this.load();
      this.render();
      this.store.flush();
      this.screen.stop();
      return;
    }

    this.screen.onResize = () => this.render();
    this.screen.onKey = (key) => {
      const action = this.handleKey(key);
      if (this.screen.active) this.render();
      if (action?.then) action.then(() => { if (this.screen.active) this.render(); });
    };
    this.loading = this.emptyReason = "Loading current session…";
    this.render();
    this.loader = new Loader(this.env, message => this.backgroundMessage(message));
    let pane;
    try { pane = JSON.parse(this.env.SESSION_GRAPH_CALLER_CONTEXT || "null"); } catch {}
    this.loader.send({ type: "start", id: ++this.loadId, callerId: this.callerId, pane, cwd: this.cwd, scope: this.scope });

    // Keep the process alive for as long as the pane is open. The interval is
    // deliberately ref'd: if stdin is a pipe that reaches EOF the app would
    // otherwise exit on its own and the pane would vanish.
    this.timer = setInterval(() => {
      this.loader.send({ type: "panes" });
    }, 5000);

    const bye = () => { try { this.quit(); } catch { process.exit(0); } };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
    this.screen.input.on("end", bye);
    this.screen.input.on("close", bye);
  }
}

// --- entry points ---------------------------------------------------------

function openOverlay() {
  // An overlay always attaches to the active pane, so the caller pane is
  // captured here and handed to the pane process through the environment.
  try {
    const pane = targetPane();
    const roots = sessionEnv();
    require("./herdr").openPluginPane({
      entrypoint: "graph",
      placement: "overlay",
      // The manifest's script path is relative to the plugin, not the caller.
      cwd: path.resolve(__dirname, ".."),
      env: {
        SESSION_GRAPH_ROOTS: JSON.stringify(Object.fromEntries(VARIABLES.filter(key => roots[key]).map(key => [key, path.resolve(roots[key])]))),
        SESSION_GRAPH_CWD: pane?.cwd || process.cwd(),
        SESSION_GRAPH_CALLER: pane?.pane_id || "",
        SESSION_GRAPH_CALLER_CONTEXT: JSON.stringify(pane || null),
      },
      focus: true,
    });
  } catch (err) {
    process.stderr.write(`session-graph: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  const cmd = process.argv[2] || "pane";
  if (cmd === "open") {
    openOverlay();
  } else {
    const app = new App({ scope: process.env.SESSION_GRAPH_SCOPE || "session" });
    try {
      app.run();
    } catch (err) {
      app.screen.stop();
      process.stderr.write(`session-graph: ${err.stack || err.message}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { App, openOverlay, SCOPES, SCOPE_LABEL, HELP };
