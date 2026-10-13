"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pluginConfigDir } = require("./herdr");
const VARIABLES = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "DSH_HOME"];

function sessionEnv(env = process.env) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(pluginConfigDir(env), "session-roots.json"), "utf8")); } catch {}
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  const resolved = { ...env };
  for (const key of VARIABLES) if (!resolved[key] && typeof saved[key] === "string") resolved[key] = saved[key];
  return resolved;
}

function rememberSessionRoots(env = process.env) {
  const target = path.join(pluginConfigDir(env), "session-roots.json");
  const resolved = sessionEnv(env), roots = {};
  for (const key of VARIABLES) if (resolved[key]) roots[key] = path.resolve(resolved[key]);
  if (!Object.keys(roots).length) return null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(roots, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(temp, target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return target;
}

module.exports = { sessionEnv, rememberSessionRoots, VARIABLES };
