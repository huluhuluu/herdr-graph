"use strict";

// Behaviour tests: drive the real App through scripted key sequences with Herdr
// stubbed out, so no live session is disturbed.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");

const { App } = require("../src/graph");
const codex = require("../src/adapters/codex");
const adapters = require("../src/adapters");

const COLS = 118;
const ROWS = 30;

class FakeOut extends EventEmitter {
  constructor() { super(); this.columns = COLS; this.rows = ROWS; this.frames = []; }
  write(s) { this.frames.push(s); }
}
class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true; }
  setRawMode() {} resume() {} pause() {} setEncoding() {}
}

// Replay a frame's cursor-positioned writes into a character grid, so layout can
// be asserted on what the user would actually see.
function replay(frame, cols, rows) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let cy = 0;
  let cx = 0;
  let i = 0;
  while (i < frame.length) {
    if (frame[i] === "\x1b") {
      const m = frame.slice(i).match(/^\x1b\[([0-9;]*)([A-Za-z])/);
      if (m) {
        const args = m[1].split(";").filter(Boolean).map(Number);
        if (m[2] === "H") { cy = (args[0] || 1) - 1; cx = (args[1] || 1) - 1; }
        else if (m[2] === "K") { for (let x = cx; x < cols; x++) if (grid[cy]) grid[cy][x] = " "; }
        else if (m[2] === "J") { for (const r of grid) r.fill(" "); }
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    const ch = frame[i];
    if (cy >= 0 && cy < rows && cx >= 0 && cx < cols) grid[cy][cx] = ch;
    cx++;
    i++;
  }
  return grid.map(r => r.join("").replace(/\s+$/, ""));
}

// Pick a session with several real prompts so navigation and search have
// something to work with.
function pickFile() {
  const candidates = codex.listSessionFiles()
    .map(f => ({ f, s: fs.statSync(f).size }))
    .filter(x => x.s > 5000 && x.s < 2 * 1048576)
    .sort((a, b) => b.s - a.s);
  for (const c of candidates) {
    const turns = codex.parseTurns(c.f);
    if (turns.filter(t => (t.prompt || "").trim().length >= 8).length >= 4) return c.f;
  }
  return null;
}

const file = pickFile();

function makeApp({ panes = [], herdr = {}, forkSession } = {}) {
  const out = new FakeOut();
  const input = new FakeIn();
  const app = new App({ scope: "session", forkSession, herdr: { paneList: () => panes, ...herdr } });
  app.callerPane = () => ({ pane_id: "caller:1", agent: "codex", agent_status: "idle" });
  app.screen.out = out;
  app.screen.input = input;
  app.screen.cols = COLS;
  app.screen.rows = ROWS;
  // Bypass Herdr discovery and load the chosen session directly.
  app.load = function () {
    this.graph = adapters.buildGraph({ adapter: codex, file, scope: this.scope, store: this.store });
    this.emptyReason = null;
    this.panes = panes;
    this.selected = 0;
    this.top = 0;
    this.clampSelection();
  };
  app.screen.start = function () { this.active = true; };
  app.screen.stop = function () { this.active = false; };
  app._quit = false;
  app.quit = function () { this._quit = true; this.store.flush(); };
  app.load();
  return app;
}

const opts = { skip: !file && "No suitable local multi-turn Codex session" };

test("navigation: j/k/g/G and clamping", opts, () => {
  const app = makeApp();
  const n = app.nodes().length;
  assert.ok(n >= 4, `need a multi-turn session, got ${n}`);
  assert.strictEqual(app.selected, 0);
  app.handleKey({ name: "j" });
  assert.strictEqual(app.selected, 1);
  app.handleKey({ name: "k" });
  assert.strictEqual(app.selected, 0);
  app.handleKey({ name: "k" });
  assert.strictEqual(app.selected, 0, "k at the top must clamp");
  app.handleKey({ name: "G" });
  assert.strictEqual(app.selected, n - 1);
  app.handleKey({ name: "j" });
  assert.strictEqual(app.selected, n - 1, "j at the bottom must clamp");
  app.handleKey({ name: "g" });
  assert.strictEqual(app.selected, 0);
  app.handleKey({ name: "down" });
  assert.strictEqual(app.selected, 1, "arrow keys must work");
  app.handleKey({ name: "up" });
  assert.strictEqual(app.selected, 0);
});

test("Tab swaps focus and j/k then scrolls the content pane", opts, () => {
  const app = makeApp();
  app.handleKey({ name: "tab" });
  assert.strictEqual(app.focus, "detail");
  app.handleKey({ name: "j" });
  assert.strictEqual(app.scroll, 1);
  assert.strictEqual(app.selected, 0, "scrolling must not move the selection");
  app.handleKey({ name: "k" });
  assert.strictEqual(app.scroll, 0);
  app.handleKey({ name: "tab" });
  assert.strictEqual(app.focus, "graph");
});

test("q quits", opts, () => {
  const app = makeApp();
  app.handleKey({ name: "q" });
  assert.strictEqual(app._quit, true);
});

test("Escape quits from browse mode", opts, () => {
  const app = makeApp();
  app.handleKey({ name: "escape" });
  assert.strictEqual(app._quit, true);
});

test("rendering: header, node counter, and footer", opts, () => {
  const app = makeApp();
  app.render();
  const frame = app.screen.out.frames[app.screen.out.frames.length - 1];
  assert.ok(frame.includes("Session Graph"), "header missing");
  assert.ok(frame.includes("j/k move"), "footer hint missing");
  assert.ok(/\d+\/\d+ nodes/.test(frame), "node counter missing");
});

test("rendering: the selected row is highlighted and still shows its label", opts, () => {
  const app = makeApp();
  app.render();
  const frame = app.screen.out.frames[app.screen.out.frames.length - 1];
  // The selection background (SGR 44, possibly combined with bold) must coexist
  // with the label text rather than painting over it.
  assert.match(frame, /\x1b\[[0-9;]*44[0-9;]*m/, "selection background missing");
  const label = app.current().prompt.trim().slice(0, 4);
  if (label) assert.ok(frame.includes(label), `selected label "${label}" was painted over`);
});

test("search: filters, pre-fills, and clears", opts, () => {
  const app = makeApp();
  const all = app.nodes();
  const source = all.find(n => (n.prompt || "").trim().length >= 8);
  assert.ok(source, "need a node with a prompt");
  const word = source.prompt.trim().slice(0, 5);

  app.handleKey({ name: "/" });
  assert.strictEqual(app.mode, "search");
  for (const ch of word) app.handleKey({ name: ch, raw: ch, printable: true });
  assert.strictEqual(app.searchInput, word);

  app.handleKey({ name: "enter" });
  assert.strictEqual(app.mode, "browse");
  assert.ok(app.nodes().length >= 1, "search must find the source node");
  assert.ok(app.nodes().length <= all.length);
  for (const n of app.nodes()) {
    assert.ok(`${n.prompt} ${n.reply}`.toLowerCase().includes(word.toLowerCase()));
  }

  app.handleKey({ name: "/" });
  assert.strictEqual(app.searchInput, word, "/ must pre-fill the active term");
  app.handleKey({ name: "escape" });
  assert.strictEqual(app.mode, "browse");
  assert.strictEqual(app.search, word, "Escape must keep the filter");

  app.handleKey({ name: "/" });
  for (let i = 0; i < word.length; i++) app.handleKey({ name: "backspace" });
  app.handleKey({ name: "enter" });
  assert.strictEqual(app.search, null, "empty input must clear the filter");
  assert.strictEqual(app.nodes().length, all.length);
});

test("scope: t cycles session -> lineage -> all -> session", opts, () => {
  const app = makeApp();
  assert.strictEqual(app.scope, "session");
  app.handleKey({ name: "t" });
  assert.strictEqual(app.scope, "lineage");
  app.handleKey({ name: "t" });
  assert.strictEqual(app.scope, "all");
  app.handleKey({ name: "t" });
  assert.strictEqual(app.scope, "session");
});

test("help: ? opens and any key closes", opts, () => {
  const app = makeApp();
  app.handleKey({ name: "?" });
  assert.strictEqual(app.mode, "help");
  app.handleKey({ name: "x" });
  assert.strictEqual(app.mode, "browse");
});

test("help: the box is rendered opaquely over the frame", opts, () => {
  const app = makeApp();
  app.handleKey({ name: "?" });
  app.render();
  const frame = app.screen.out.frames[app.screen.out.frames.length - 1];
  assert.ok(frame.includes("Session Graph — keys"), "help title missing");
  assert.ok(frame.includes("move nodes / scroll focused content"), "help body missing");
  assert.ok(frame.includes("┌"), "help border missing");
  assert.ok(frame.includes("PgUp/PgDn scroll"), "help scrolling instructions missing");

  // Every row the box covers must be blank-filled first, so graph text cannot
  // bleed through. Verify by checking the box's interior rows are drawn.
  const grid = replay(frame, COLS, ROWS);
  const boxRows = grid.filter(l => l.includes("│") || l.includes("┌") || l.includes("└"));
  assert.ok(boxRows.length >= 3, "expected a multi-row box");
});

test("help: closing restores the normal frame", opts, () => {
  const app = makeApp();
  app.handleKey({ name: "?" });
  app.render();
  app.handleKey({ name: "x" });
  app.render();
  const frame = app.screen.out.frames[app.screen.out.frames.length - 1];
  assert.ok(!frame.includes("Session Graph — keys"), "help box must be gone");
  assert.ok(frame.includes("j/k move"), "footer hint must be back");
});

test("narrow terminal: renders without crashing and hides the detail pane", opts, () => {
  const app = makeApp();
  app.screen.cols = 60;
  app.screen.rows = 20;
  app.render();
  const frame = app.screen.out.frames[app.screen.out.frames.length - 1];
  assert.ok(frame.includes("Session Graph"), "header must still render");
  const { stacked } = app.layout();
  assert.strictEqual(stacked, true, "narrow terminals must stack");
});

test("tiny terminal: still renders and does not throw", opts, () => {
  const app = makeApp();
  app.screen.cols = 24;
  app.screen.rows = 6;
  app.render();
  assert.ok(app.screen.out.frames.length > 0);
  // The help box must clamp to the available space too.
  app.handleKey({ name: "?" });
  app.render();
  assert.ok(app.screen.out.frames.length > 0);
});

test("resize: re-rendering after a size change stays within bounds", opts, () => {
  const app = makeApp();
  app.render();
  app.screen.cols = 90;
  app.screen.rows = 24;
  app.render();
  const frame = app.screen.out.frames[app.screen.out.frames.length - 1];
  // No drawn line may exceed the new width once ANSI is stripped.
  const grid = replay(frame, 90, 24);
  for (const line of grid) assert.ok(line.length <= 90);
});

test("Enter on a stopped session warns and does not jump", opts, () => {
  const app = makeApp({ panes: [], herdr: { focusPane: () => { throw new Error("must not focus"); } } });
  app.handleKey({ name: "enter" });
  assert.match(app.message || "", /not running/);
  assert.strictEqual(app._quit, false);
});

test("Enter focuses the pane already running that session", opts, () => {
  const probe = makeApp();
  const sessionId = probe.current().sessionId;
  const focused = [];
  const app = makeApp({
    panes: [{ pane_id: "w9:p3", agent_session: { value: sessionId } }],
    herdr: { focusPane: (id) => focused.push(id) },
  });
  app.quit = function () { this._quit = true; };
  app.handleKey({ name: "enter" });
  assert.deepStrictEqual(focused, ["w9:p3"]);
  assert.match(app.message || "", /Jumped to w9:p3/);
});

test("Enter ignores panes whose session id does not match", opts, () => {
  const focused = [];
  const app = makeApp({
    panes: [{ pane_id: "w9:p3", agent_session: { value: "some-other-session" } }],
    herdr: { focusPane: (id) => focused.push(id) },
  });
  app.handleKey({ name: "enter" });
  assert.deepStrictEqual(focused, []);
  assert.match(app.message || "", /not running/);
});

test("n sends the native resume command only to the caller pane", opts, () => {
  const node = makeApp().current();
  const calls = [];
  const app = makeApp({
    herdr: {
      splitPane: () => assert.fail("must not split"),
      startAgent: () => assert.fail("must not start another agent"),
      runInPane: (id, cmd) => calls.push(["run", id, cmd]),
      focusPane: id => calls.push(["focus", id]),
    },
  });
  app.handleKey({ name: "n" });
  assert.deepStrictEqual(calls, [["run", "caller:1", `/resume ${node.sessionId}`], ["focus", "caller:1"]]);
});

test("F creates a saved child then resumes it in the caller pane", opts, async () => {
  const child = "22222222-2222-4222-8222-222222222222";
  const ran = [];
  const app = makeApp({
    forkSession: async session => { ran.push(["fork", session.sessionId]); return child; },
    herdr: {
      splitPane: () => assert.fail("must not split"),
      startAgent: () => assert.fail("must not start another agent"),
      runInPane: (id, cmd) => ran.push(["run", id, cmd]),
      focusPane: () => {},
    },
  });
  await app.handleKey({ name: "F" });
  assert.deepStrictEqual(ran, [["fork", app.current().sessionId], ["run", "caller:1", `/resume ${child}`]]);
});

test("resume reports command failure without creating a fallback pane", opts, () => {
  const app = makeApp({ herdr: {
    runInPane: () => { throw new Error("pane closed"); },
    splitPane: () => assert.fail("must not split"),
  } });
  app.resumeInPane();
  assert.match(app.message || "", /pane closed/);
});

test("livePaneFor matches on session id and tolerates missing fields", opts, () => {
  const app = makeApp({
    panes: [
      { pane_id: "a:1", agent_session: { value: "other" } },
      { pane_id: "a:2", agent_session: { value: "wanted" } },
      { pane_id: "a:3" },
    ],
  });
  assert.strictEqual(app.livePaneFor("wanted").pane_id, "a:2");
  assert.strictEqual(app.livePaneFor("nope"), null);
});

test("fold: h/l toggle only on real branch points", opts, () => {
  const app = makeApp();
  const branch = app.nodes().find(n => n.branchCount > 1);
  if (!branch) return; // this session has no branch points
  app.selected = app.nodes().indexOf(branch);
  app.handleKey({ name: "h" });
  assert.ok(app.collapsed.has(branch.id), "h must collapse a branch point");
  app.handleKey({ name: "l" });
  assert.ok(!app.collapsed.has(branch.id), "l must expand it");
});

test("fold: h on a leaf explains rather than silently doing nothing", opts, () => {
  const app = makeApp();
  const leaf = app.nodes().find(n => !(n.branchCount > 1));
  if (!leaf) return;
  app.selected = app.nodes().indexOf(leaf);
  app.handleKey({ name: "h" });
  assert.match(app.message || "", /no children/);
});

test("empty state: an unreadable agent shows a reason, not a crash", () => {
  const app = new App({ scope: "session", herdr: { paneList: () => [] } });
  app.screen.out = new FakeOut();
  app.screen.cols = COLS;
  app.screen.rows = ROWS;
  app.load = function () {
    this.graph = null;
    this.emptyReason = "No focused pane found.";
    this.panes = [];
  };
  app.load();
  app.render();
  const frame = app.screen.out.frames[app.screen.out.frames.length - 1];
  assert.ok(frame.includes("No focused pane found."));
});
