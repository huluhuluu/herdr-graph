"use strict";

// Thin wrapper over the Herdr CLI. Mirrors the proven pattern used by the
// author's other plugin (herdr-remark): call HERDR_BIN_PATH, parse the JSON
// envelope, and surface `error.message` as a thrown Error.

const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const ID = process.env.HERDR_PLUGIN_ID || "huluhlu.session-graph";

function bin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function cli(args, { timeout = 15000, json = true } = {}) {
  const res = spawnSync(bin(), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = (res.stdout || "").trim();
  if (!json) return stdout;
  let body;
  try { body = JSON.parse(stdout || (res.stderr || "").trim()); } catch {}
  if (res.error || res.status !== 0 || body?.error) {
    throw new Error(
      res.error?.message ||
      body?.error?.message ||
      (res.stderr || "").trim() ||
      `herdr ${args[0]} exited with ${res.status}`
    );
  }
  return body?.result || {};
}

function envJson(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    throw new Error(`${name} is not valid JSON: ${String(raw).slice(0, 200)}`);
  }
}

// The pane the plugin was invoked from. In a pane command HERDR_PANE_ID is the
// plugin's own new pane, so prefer focused_pane_id from the context JSON.
function callerPaneId() {
  const ctx = envJson("HERDR_PLUGIN_CONTEXT_JSON");
  return ctx.focused_pane_id || process.env.HERDR_PANE_ID || null;
}

function paneList() {
  return cli(["pane", "list"]).panes || [];
}

function paneGet(paneId) {
  return cli(["pane", "get", paneId]).pane || null;
}

function currentPane() {
  return cli(["pane", "current"]).pane || null;
}

// Resolve the pane the user was looking at when they pressed the key.
function targetPane() {
  const id = callerPaneId();
  if (id) {
    const pane = paneGet(id);
    if (pane) return pane;
  }
  return currentPane();
}

// Focus a pane by id. The CLI only exposes focus-by-direction, but `agent
// focus` accepts a pane id and is verified to work.
function focusPane(paneId) {
  return cli(["agent", "focus", paneId], { timeout: 10000 });
}

function runInPane(paneId, command) {
  return cli(["pane", "run", paneId, command], { timeout: 15000 });
}

// Open a plugin pane.
//
// Note: overlay and popup placements always target the ACTIVE pane, so
// --target-pane must not be passed for them (Herdr rejects it). It is only
// valid for split/tab placements.
function openPluginPane({ entrypoint, placement, cwd, env = {}, focus = true, targetPaneId } = {}) {
  const args = ["plugin", "pane", "open", "--plugin", ID, "--entrypoint", entrypoint];
  if (placement) args.push("--placement", placement);
  if (cwd) args.push("--cwd", cwd);
  const canTarget = placement && placement !== "overlay" && placement !== "popup";
  if (targetPaneId && canTarget) args.push("--target-pane", targetPaneId);
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  if (focus) args.push("--focus");
  const res = cli(args);
  return res.plugin_pane?.pane || res.pane || {};
}

function pluginStateDir(env = process.env, platform = process.platform) {
  const base = env.XDG_STATE_HOME || (platform === "win32"
    ? env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Local")
    : path.join(env.HOME || os.homedir(), ".local", "state"));
  return path.resolve(env.HERDR_PLUGIN_STATE_DIR ||
    path.join(base, "herdr", "plugins", env.HERDR_PLUGIN_ID || ID));
}

function pluginConfigDir(env = process.env, platform = process.platform) {
  const base = env.XDG_CONFIG_HOME || (platform === "win32"
    ? env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming")
    : path.join(env.HOME || os.homedir(), ".config"));
  return path.resolve(env.HERDR_PLUGIN_CONFIG_DIR || path.join(base, "herdr", "plugins", "config", ID));
}

module.exports = {
  ID,
  bin,
  cli,
  envJson,
  callerPaneId,
  paneList,
  paneGet,
  currentPane,
  targetPane,
  focusPane,
  runInPane,
  openPluginPane,
  pluginStateDir,
  pluginConfigDir,
};
