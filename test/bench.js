"use strict";
// Read local transcripts; keep benchmark caches separate from the plugin.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const codex = require("../src/adapters/codex");
const claude = require("../src/adapters/claude");
const adapters = require("../src/adapters");
const { makeStore } = require("../src/store");

function pick(adapter) {
  return adapter.listSessionFiles()
    .flatMap(f => {
      try { return [{ f, s: fs.statSync(f).size }]; }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
}

const base = fs.realpathSync(os.tmpdir());
const state = fs.mkdtempSync(path.join(base, "session-graph-bench-"));
const previousState = process.env.HERDR_PLUGIN_STATE_DIR;
process.env.HERDR_PLUGIN_STATE_DIR = state;
try {
  const cases = [["codex", codex, pick(codex)], ["claude", claude, pick(claude)]];
  for (const pass of ["cold", "warm"]) {
    for (const [name, adapter, files] of cases) {
      console.log(`\n=== ${name} (${pass}) ===`);
      if (!files.length) console.log("  No local sessions found.");
      files.forEach((x, i) => {
        const store = makeStore(), t0 = performance.now();
        const graph = adapters.buildGraph({ adapter, file: x.f, scope: "session", store });
        const ms = (performance.now() - t0).toFixed(1);
        const { hits, misses } = store.stats();
        store.flush();
        console.log(`  [${i}] ${(x.s / 1048576).toFixed(1).padStart(7)}MB  ${ms.padStart(8)}ms  ${graph.nodes.length} nodes  cache ${hits} hit / ${misses} miss`);
      });
    }
  }
} finally {
  if (previousState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = previousState;
  // Only remove the exact temporary directory created for this run.
  if (path.dirname(state) === base && path.basename(state).startsWith("session-graph-bench-")) {
    fs.rmSync(state, { recursive: true, force: true });
  }
}
