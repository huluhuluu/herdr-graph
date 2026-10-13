"use strict";

// Parse cache. Parsing the biggest session on this machine (446 MB) takes
// seconds, so results are cached under HERDR_PLUGIN_STATE_DIR keyed by the
// file's mtime+size. A cache miss simply re-parses.

const fs = require("node:fs");
const path = require("node:path");
const { pluginStateDir } = require("./herdr");

const VERSION = 4;

function cacheFile() {
  return path.join(pluginStateDir(), `parse-cache-v${VERSION}.json`);
}

function load() {
  try {
    const raw = fs.readFileSync(cacheFile(), "utf8");
    const data = JSON.parse(raw);
    return data?.entries && typeof data.entries === "object" && !Array.isArray(data.entries)
      ? data : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function save(data) {
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch {
    // A cache write failure must never break the UI.
  }
}

// Cache key: adapter id + file path. Validity: mtime + size.
function keyFor(adapterId, file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  return `${adapterId}|${file}|${st.mtimeMs}|${st.size}`;
}

function makeStore() {
  let data;
  const ensure = () => (data ||= load());
  let dirty = false;
  let hits = 0;
  let misses = 0;

  function get(adapterId, file) {
    const key = keyFor(adapterId, file);
    if (!key) return null;
    const hit = ensure().entries[key];
    if (Array.isArray(hit)) { hits++; return hit; }
    misses++;
    return null;
  }

  function put(adapterId, file, value) {
    const key = keyFor(adapterId, file);
    if (!key) return;
    ensure().entries[key] = value;
    dirty = true;
  }

  // Drop entries whose file changed or disappeared, so the cache cannot grow
  // without bound.
  function prune(maxEntries = 400) {
    const keys = Object.keys(data.entries);
    for (const k of keys) {
      const [adapterId, ...parts] = k.split("|");
      const file = parts.slice(0, -2).join("|");
      if (keyFor(adapterId, file) !== k) delete data.entries[k];
    }
    const rest = Object.keys(data.entries);
    if (rest.length > maxEntries) {
      for (const k of rest.slice(0, rest.length - maxEntries)) delete data.entries[k];
    }
    dirty = true;
  }

  function flush() {
    if (!dirty) return;
    prune();
    save(data);
    dirty = false;
  }

  return { get, put, flush, stats: () => ({ hits, misses }) };
}

// Wrap an adapter's parseTurns with caching.
function cachedParse(adapter, file, store) {
  const hit = store.get(adapter.id, file);
  if (hit) return hit;
  const before = keyFor(adapter.id, file);
  const turns = adapter.parseTurns(file);
  if (before && before === keyFor(adapter.id, file)) store.put(adapter.id, file, turns);
  return turns;
}

module.exports = { makeStore, cachedParse, cacheFile, VERSION };
