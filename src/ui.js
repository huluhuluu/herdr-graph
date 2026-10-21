"use strict";

// Minimal terminal UI toolkit: an alternate-screen frame buffer, styled cells,
// and raw-key input. No dependencies -- the layout is fixed and small enough
// that a framework would only add weight and Windows risk.

const { width: strWidth, truncate, charWidth } = require("./util");

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const STYLE = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  reverse: 7,
};
const FG = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34,
  magenta: 35, cyan: 36, white: 37, gray: 90,
};
const BG = {
  black: 40, red: 41, green: 42, yellow: 43, blue: 44,
  magenta: 45, cyan: 46, white: 47,
};

function sgr(codes) {
  if (!codes || !codes.length) return "";
  return `${ESC}${codes.join(";")}m`;
}

// Build the escape sequence for a style descriptor such as
// { fg: "cyan", bold: true, reverse: true }.
function styleSeq(style) {
  if (!style) return "";
  const codes = [];
  for (const [k, v] of Object.entries(style)) {
    if (!v) continue;
    if (k === "fg" && FG[v]) codes.push(FG[v]);
    else if (k === "bg" && BG[v]) codes.push(BG[v]);
    else if (STYLE[k]) codes.push(STYLE[k]);
  }
  return sgr(codes);
}

class Screen {
  constructor(out = process.stdout, input = process.stdin) {
    this.out = out;
    this.input = input;
    this.cols = out.columns || 80;
    this.rows = out.rows || 24;
    this.buffer = [];
    this.active = false;
    this.layer = 0;
    this.onKey = null;
    this.onResize = null;
  }

  get width() { return this.cols; }
  get height() { return this.rows; }

  start() {
    if (this.active) return;
    this.active = true;
    this.out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
    if (this.input.isTTY) {
      this.input.setRawMode(true);
      this.input.resume();
      this.input.setEncoding("utf8");
    }
    this._keyHandler = (chunk) => this._handleInput(chunk);
    this.input.on("data", this._keyHandler);
    this._resizeHandler = () => {
      this.cols = this.out.columns || 80;
      this.rows = this.out.rows || 24;
      if (this.onResize) this.onResize(this.cols, this.rows);
    };
    this.out.on("resize", this._resizeHandler);
  }

  stop() {
    clearTimeout(this._escapeTimer);
    this._pendingInput = "";
    if (!this.active) return;
    this.active = false;
    if (this._keyHandler) this.input.off("data", this._keyHandler);
    if (this._resizeHandler) this.out.off("resize", this._resizeHandler);
    if (this.input.isTTY) {
      try { this.input.setRawMode(false); } catch {}
    }
    this.input.pause();
    this.out.write(`${ESC}?25h${ESC}?1049l`);
  }

  _handleInput(chunk) {
    if (!this.onKey) return;
    clearTimeout(this._escapeTimer);
    const input = (this._pendingInput || "") + chunk;
    const incomplete = input.match(/\x1b(?:\[[0-9;]*|O)?$/);
    this._pendingInput = incomplete ? incomplete[0] : "";
    const ready = incomplete ? input.slice(0, incomplete.index) : input;
    for (const key of parseKeys(ready)) this.onKey(key);
    if (this._pendingInput) {
      this._escapeTimer = setTimeout(() => {
        const pending = this._pendingInput;
        this._pendingInput = "";
        // An unfinished arrow sequence is discarded; only a lone Esc navigates.
        if (pending === "\x1b") this.onKey?.({ name: "escape", raw: pending });
      }, 50);
      this._escapeTimer.unref?.();
    }
  }

  clear() {
    this.buffer = [];
    for (let y = 0; y < this.rows; y++) this.buffer.push([]);
  }

  // Draw text at (x, y), truncating at the screen edge. `prio` orders
  // overlapping draws: higher wins. `this.layer` offsets every draw so an
  // overlay (e.g. the help box) can cover the base frame completely.
  text(x, y, str, style, prio = 1) {
    if (y < 0 || y >= this.rows || x >= this.cols || x < 0) return;
    const row = this.buffer[y];
    if (!row) return;
    const s = String(str ?? "");
    if (!s) return;
    row.push({ x, text: truncate(s, this.cols - x), style, prio: this.layer * 10 + prio });
  }

  highlightedText(x, y, text, query, style, ranges = null) {
    this.text(x, y, text, style);
    for (const [start, end] of ranges || matchRanges(text, query)) {
      const part = text.slice(start, end);
      if (part) this.text(x + strWidth(text.slice(0, start)), y, part, { fg: "black", bg: "yellow", bold: true }, 2);
    }
  }

  // Fill a rectangle with a background style (used for selection bars). Fills
  // are drawn before text so labels sit on top of the highlight.
  fill(x, y, w, h, style, ch = " ", prio = 0) {
    for (let i = 0; i < h; i++) {
      const row = this.buffer[y + i];
      if (!row) continue;
      row.push({
        x,
        text: ch.repeat(Math.max(0, Math.min(w, this.cols - x))),
        style,
        prio: this.layer * 10 + prio,
      });
    }
  }

  render() {
    // Composite every row into a cell grid (char + style) so a background fill
    // and the text drawn on top of it merge instead of overwriting each other.
    const parts = [`${ESC}?25l`];
    for (let y = 0; y < this.rows; y++) {
      const cells = Array.from({ length: this.cols }, () => ({ ch: " ", style: null }));
      const row = (this.buffer[y] || []).slice().sort((a, b) => (a.prio - b.prio) || (a.x - b.x));
      for (const item of row) {
        if (item.x < 0) continue;
        const body = item.prio === 0 ? item.text : truncate(item.text, this.cols - item.x);
        let cx = item.x;
        for (const ch of body) {
          const w = charWidth(ch.codePointAt(0));
          if (w === 0) continue;
          if (cx >= this.cols) break;
          if (w === 2 && cx + 1 >= this.cols) break;
          cells[cx] = { ch, style: item.style };
          if (w === 2) cells[cx + 1] = { ch: "", style: item.style };
          cx += w;
        }
      }

      parts.push(`${ESC}${y + 1};1H${ESC}2K`);
      let cur = null;
      let line = "";
      for (let x = 0; x < this.cols; x++) {
        const cell = cells[x];
        if (cell.ch === "") continue; // right half of a wide glyph
        if (cell.style !== cur) {
          if (cur) line += RESET;
          const seq = styleSeq(cell.style);
          if (seq) line += seq;
          cur = cell.style;
        }
        line += cell.ch;
      }
      if (cur) line += RESET;
      parts.push(line.replace(/\s+$/, ""));
    }
    this.out.write(parts.join(""));
  }
}

// Parse a raw stdin chunk into key descriptors. Handles CSI arrow keys, the
// common navigation keys, and multi-byte UTF-8 characters.
function parseKeys(chunk) {
  const keys = [];
  const s = String(chunk);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\x1b") {
      const rest = s.slice(i);
      const m = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
      if (m) {
        const code = m[1];
        const final = m[2];
        const map = {
          A: "up", B: "down", C: "right", D: "left",
          H: "home", F: "end",
        };
        if (final === "~") {
          const tilde = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown" };
          keys.push({ name: tilde[code] || `csi-${code}~`, raw: m[0] });
        } else if (final === "Z") {
          keys.push({ name: "shift-tab", raw: m[0] });
        } else {
          keys.push({ name: map[final] || `csi-${code}${final}`, raw: m[0] });
        }
        i += m[0].length;
        continue;
      }
      const m2 = rest.match(/^\x1bO([A-Za-z])/);
      if (m2) {
        const map = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
        keys.push({ name: map[m2[1]] || `ss3-${m2[1]}`, raw: m2[0] });
        i += m2[0].length;
        continue;
      }
      // A lone Escape, or an unrecognized sequence we treat as Escape.
      keys.push({ name: "escape", raw: "\x1b" });
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") { keys.push({ name: "enter", raw: ch }); i++; continue; }
    if (ch === "\t") { keys.push({ name: "tab", raw: ch }); i++; continue; }
    if (ch === "\x7f" || ch === "\b") { keys.push({ name: "backspace", raw: ch }); i++; continue; }
    if (ch === "\x03") { keys.push({ name: "ctrl-c", raw: ch }); i++; continue; }
    const code = s.codePointAt(i);
    if (code < 32) {
      const letter = String.fromCharCode(96 + code);
      keys.push({ name: `ctrl-${letter}`, raw: ch });
      i++;
      continue;
    }
    // Consume a full code point (surrogate pairs included).
    const cp = String.fromCodePoint(code);
    keys.push({ name: cp, raw: cp, printable: true });
    i += cp.length;
  }
  return keys;
}

function matchRanges(text, query) {
  if (!query) return [];
  const pattern = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return [...String(text).matchAll(pattern)].map(match => [match.index, match.index + match[0].length]);
}

// Retain match spans when a query crosses a terminal line wrap.
function wrapMatches(text, width, query) {
  const { wrap } = require("./util");
  text = String(text ?? "");
  const ranges = matchRanges(text, query);
  let offset = 0;
  return wrap(text, width).map(line => {
    const start = offset, end = start + line.length;
    offset = end + (text[end] === "\n" ? 1 : 0);
    return { text: line, matches: ranges.filter(([a, b]) => a < end && b > start)
      .map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start]) };
  });
}

module.exports = { Screen, parseKeys, styleSeq, STYLE, FG, BG, RESET, ESC, matchRanges, wrapMatches };
