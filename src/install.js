"use strict";

// Local plugin lifecycle and marker-fenced keybindings. No Herdr source edits.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { bin, pluginStateDir } = require("./herdr");

const ROOT = path.resolve(__dirname, "..");
const ID = "huluhlu.session-graph";
const BEGIN = "# session-graph begin";
const END = "# session-graph end";

function configPath(env = process.env, platform = process.platform) {
  const base = env.XDG_CONFIG_HOME || (platform === "win32"
    ? env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming")
    : path.join(env.HOME || os.homedir(), ".config"));
  return path.resolve(env.HERDR_CONFIG_PATH || path.join(base, "herdr", "config.toml"));
}

function exampleBlock() {
  const raw = fs.readFileSync(path.join(ROOT, "config.example.toml"), "utf8");
  // Drop the leading comment banner; keep only the [[keys.command]] tables.
  return raw.split("\n").filter(l => !l.startsWith("#")).join("\n").trim();
}

function mergeConfig(current, block) {
  if (current.includes("\0")) throw new Error("Config must be UTF-8 TOML.");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const text = current.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (l.trim() === BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === END ? [i] : []));
  if (starts.length > 1 || ends.length !== starts.length || ends[0] < starts[0]) {
    throw new Error(`Invalid session-graph config markers; fix the ${BEGIN} / ${END} block first.`);
  }
  const outside = starts.length
    ? [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)].join("\n")
    : text;

  // Refuse to steal a key the user already bound elsewhere.
  const keys = text => [...text.matchAll(/^\s*(?:key|"key"|'key')\s*=\s*(?:"([^"]+)"|'([^']+)')/gm)]
    .map(m => m[1] || m[2]);
  const mine = new Set(keys(block));
  for (const key of keys(outside)) {
    if (mine.has(key)) {
      throw new Error(
        `Key "${key}" is already bound outside the managed block. ` +
        `Edit config.example.toml to choose another key, or move that binding. Nothing was changed.`
      );
    }
  }

  const fenced = [BEGIN, block, END].join("\n");
  if (starts.length) {
    lines.splice(starts[0], ends[0] - starts[0] + 1, fenced);
    return lines.join("\n").replace(/\n/g, eol);
  }
  return (text + (text && !text.endsWith("\n") ? "\n" : "") +
    (text ? "\n" : "") + fenced + "\n").replace(/\n/g, eol);
}

function removeBlock(current) {
  if (current.includes("\0")) throw new Error("Config must be UTF-8 TOML.");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const starts = lines.flatMap((l, i) => (l.trim() === BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === END ? [i] : []));
  if (starts.length > 1 || ends.length !== starts.length || ends[0] < starts[0]) {
    throw new Error(`Invalid session-graph config markers; fix the ${BEGIN} / ${END} block first.`);
  }
  if (!starts.length) return { text: current, removed: false };
  lines.splice(starts[0], ends[0] - starts[0] + 1);
  return { text: lines.join("\n").replace(/\n/g, eol), removed: true };
}

function run(args, env = {}) {
  const res = spawnSync(bin(), args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`${args.join(" ")}: ${res.error?.message || res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function checkVersion(execute = run) {
  const out = execute(["--version"]);
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Cannot parse herdr version from: ${out.trim()}`);
  const [maj, min] = [Number(m[1]), Number(m[2])];
  if (maj === 0 && (min < 9)) {
    throw new Error(`Herdr 0.9.0+ is required (found ${m[1]}.${m[2]}.${m[3]}).`);
  }
}

function reload(execute, target) {
  const res = JSON.parse(execute(["server", "reload-config"], { HERDR_CONFIG_PATH: target }));
  if (res.result?.status !== "applied") throw new Error(`Config reload: ${JSON.stringify(res)}`);
}

function readConfig(target) {
  let bytes;
  try { bytes = fs.readFileSync(target); } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`Config must be UTF-8 TOML: ${target}`); }
}

function configMatches(target, text) {
  try {
    const bytes = fs.readFileSync(target);
    return text !== null && bytes.equals(Buffer.from(text));
  }
  catch (err) { if (err.code === "ENOENT") return text === null; throw err; }
}

function writeConfig(target, original, text, execute) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.session-graph-${process.pid}.toml`;
  fs.writeFileSync(staged, text, { flag: "wx", mode: original === null ? 0o600 : fs.statSync(target).mode });
  let backup = null;
  try {
    execute(["config", "check"], { HERDR_CONFIG_PATH: staged });
    if (!configMatches(target, original)) {
      throw new Error("Config changed during validation; concurrent edits were preserved. Retry the command.");
    }
    if (original !== null) {
      backup = `${target}.session-graph-backup-${Date.now()}-${randomUUID()}`;
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(staged, target);
    try {
      reload(execute, target);
    } catch (err) {
      if (!configMatches(target, text)) {
        throw new Error(`Reload failed; config changed concurrently and was left untouched.${backup ? ` Previous config backup: ${backup}.` : ""} ${err.message}`);
      }
      if (original !== null) fs.writeFileSync(target, original);
      else fs.unlinkSync(target);
      try { reload(execute, target); } catch {}
      throw new Error(`Reload failed; previous config restored. ${err.message}`);
    }
    return { target, backup };
  } finally {
    if (fs.existsSync(staged)) fs.unlinkSync(staged);
  }
}

function setupKeys({ target = configPath(), preserve = false, execute = run } = {}) {
  checkVersion(execute);
  target = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
  const original = readConfig(target);
  // Validate markers even when preserving a user's customized block.
  if (preserve && removeBlock(original || "").removed) return { target, changed: false };
  const merged = mergeConfig(original || "", exampleBlock());
  if (merged === original) return { target, changed: false };
  return { ...writeConfig(target, original, merged, execute), changed: true };
}

function removeKeys({ target = configPath(), execute = run } = {}) {
  target = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
  if (!fs.existsSync(target)) return { target, removed: false };
  const original = readConfig(target);
  if (original === null) return { target, removed: false };
  const { text, removed } = removeBlock(original);
  if (!removed) return { target, removed: false };

  return { ...writeConfig(target, original, text, execute), removed: true };
}

function sameDirectory(a, b) {
  const normalize = p => {
    const resolved = fs.realpathSync(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function registration(root, execute) {
  const body = JSON.parse(execute(["plugin", "list", "--json"]));
  if (body.error) throw new Error(body.error.message);
  const plugin = body.result?.plugins?.find(p => p.plugin_id === ID);
  if (plugin && (plugin.source?.kind !== "local" || !sameDirectory(plugin.plugin_root, root))) {
    throw new Error(`${ID} is already registered from another location. Unlink that installation first.`);
  }
  return plugin;
}

function install({ root = ROOT, noKeys = false, target = configPath(), execute = run } = {}) {
  checkVersion(execute);
  registration(root, execute);
  execute(["plugin", "link", root, "--enabled"]);
  try {
    const keys = noKeys ? null : setupKeys({ target, preserve: true, execute });
    return { root, keys };
  } catch (err) {
    throw new Error(`Plugin linked, but key setup failed: ${err.message}`);
  }
}

function git(args, root) {
  const res = spawnSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${res.error?.message || res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function clean({ env = process.env, platform = process.platform } = {}) {
  const dirs = new Set([
    pluginStateDir({ ...env, HERDR_PLUGIN_ID: ID }, platform),
    // Direct CLI invocations of older versions used this fallback directory.
    path.resolve(env.APPDATA || env.HOME || os.homedir(), "herdr", "plugins", "state", ID),
  ]);
  const removed = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^parse-cache-v\d+\.json(?:\.\d+\.tmp)?$/.test(name)) continue;
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile()) continue;
      fs.unlinkSync(file);
      removed.push(file);
    }
  }
  return removed;
}

function update({ root = ROOT, execute = run, env = process.env } = {}) {
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw new Error("Update requires a Git checkout. Use git clone to install this project first.");
  }
  if (!sameDirectory(git(["rev-parse", "--show-toplevel"], root), root)) {
    throw new Error("The plugin directory must be the Git repository root.");
  }
  if (git(["status", "--porcelain"], root)) {
    throw new Error("Working tree has local changes. Commit or stash them before update; nothing was changed.");
  }
  if (git(["rev-parse", "--abbrev-ref", "HEAD"], root) === "HEAD") {
    throw new Error("Detached HEAD: switch to a branch with an upstream before update.");
  }
  git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root);
  checkVersion(execute);
  const previous = registration(root, execute);
  git(["pull", "--ff-only"], root);
  execute(["plugin", "link", root, previous?.enabled === false ? "--disabled" : "--enabled"]);
  return { root, removed: clean({ env }) };
}

function uninstall({ root = ROOT, target = configPath(), execute = run, env = process.env } = {}) {
  checkVersion(execute);
  const previous = registration(root, execute);
  const keys = removeKeys({ target, execute });
  if (previous) execute(["plugin", "unlink", ID]);
  return { keys, removed: clean({ env }) };
}

const HELP = `Session Graph — local plugin manager

Usage:
  sh ./install.sh [command] [options]                 Linux / macOS
  powershell -ExecutionPolicy Bypass -File .\\install.ps1 [command] [options]
  node src/install.js [command] [options]            Any platform

Commands:
  install       Link this checkout and add keys; preserve existing managed keys (default)
  update        Git pull --ff-only, refresh registration, clear parse caches; preserve keys
  clean         Remove this plugin's parse caches and cache temp files only
  uninstall     Remove managed keys, unlink this plugin, and clear parse caches
  setup-keys    Replace the managed key block using config.example.toml
  remove-keys   Remove the managed key block only

Options:
  --no-keys     Install without editing Herdr config (install only)
  -h, --help    Show this help

Requires Node.js 18+; install/update/uninstall also require Herdr 0.9.0+.
Install remembers CODEX_HOME, CLAUDE_CONFIG_DIR and DSH_HOME in plugin config
so custom session storage remains discoverable if Herdr lacks those variables.
Key changes require a running Herdr server; config is validated and backed up,
and restored if reload fails unless another process changed it meanwhile.
HERDR_CONFIG_PATH selects a custom UTF-8 config file.
Update requires Git, a clean checkout and a branch with an upstream.
Close graph panes before update or clean; reopen after update.
No Herdr source, agent transcripts, repository files or config backups are deleted.
`;

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const cmd = argv[0]?.startsWith("--") ? "install" : argv[0] || "install";
  const options = argv[0] === cmd ? argv.slice(1) : argv;
  const commands = ["install", "update", "clean", "uninstall", "setup-keys", "remove-keys"];
  if (!commands.includes(cmd) || options.some(o => o !== "--no-keys") ||
      (options.length && cmd !== "install")) {
    process.stderr.write("Invalid command or option. Run with --help for usage.\n");
    return 2;
  }
  try {
    if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("Node.js 18+ is required.");
    if (cmd === "install") {
      const r = install({ noKeys: options.includes("--no-keys") });
      process.stdout.write(`Plugin linked: ${r.root}\n`);
      if (r.keys) reportKeys(r.keys);
      const roots = require("./paths").rememberSessionRoots();
      if (roots) process.stdout.write(`Agent storage paths saved: ${roots}\n`);
    } else if (cmd === "update") {
      const r = update();
      process.stdout.write(`Plugin updated: ${r.root}\nRemoved ${r.removed.length} cache file(s). Reopen graph panes.\n`);
    } else if (cmd === "clean") {
      process.stdout.write(`Removed ${clean().length} cache file(s).\n`);
    } else if (cmd === "uninstall") {
      const r = uninstall();
      reportKeys(r.keys);
      process.stdout.write(`Plugin unlinked. Removed ${r.removed.length} cache file(s). Checkout retained: ${ROOT}\n`);
    } else {
      reportKeys(cmd === "setup-keys" ? setupKeys() : removeKeys());
    }
    return 0;
  } catch (err) {
    process.stderr.write(`session-graph: ${err.message}\n`);
    return 1;
  }
}

function reportKeys(r) {
  process.stdout.write(r.removed ? `Keys removed: ${r.target}\n` :
    r.changed ? `Keys installed: ${r.target}\n` : `Keys unchanged: ${r.target}\n`);
  if (r.backup) process.stdout.write(`Config backup: ${r.backup}\n`);
}

if (require.main === module) process.exitCode = main();

module.exports = {
  BEGIN, END, configPath, mergeConfig, removeBlock, setupKeys, removeKeys, exampleBlock,
  install, update, clean, uninstall, main,
};
