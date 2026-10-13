"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  BEGIN, END, mergeConfig, removeBlock, setupKeys, removeKeys,
  install, update, clean, uninstall,
} = require("../src/install");
const { pluginStateDir } = require("../src/herdr");

const ID = "huluhlu.session-graph";

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "session-graph-test-"));
  t.after(() => {
    // Only remove the exact temporary directory created by this test.
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith("session-graph-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeHerdr({ root, failCheck = false, failReload = false, plugins = [] } = {}) {
  const calls = [];
  const execute = (args, env = {}) => {
    calls.push({ args, env });
    if (args[0] === "--version") return "herdr 0.9.1";
    if (args[0] === "plugin" && args[1] === "list") {
      return JSON.stringify({ result: { plugins } });
    }
    if (args[0] === "config") {
      assert.ok(fs.existsSync(env.HERDR_CONFIG_PATH));
      if (failCheck) throw new Error("invalid TOML");
      return "{}";
    }
    if (args[0] === "server") {
      if (failReload) throw new Error("reload rejected");
      return JSON.stringify({ result: { status: "applied" } });
    }
    if (args[0] === "plugin" && args[1] === "link") {
      assert.equal(args[2], root);
      return "{}";
    }
    if (args[0] === "plugin" && args[1] === "unlink") {
      assert.equal(args[2], ID);
      return "{}";
    }
    throw new Error(`Unexpected Herdr operation: ${args.join(" ")}`);
  };
  return { execute, calls };
}

test("key edits preserve unrelated whitespace and CRLF; removal rejects broken markers", () => {
  const prefix = '# user settings\r\n\r\n\r\n[theme]\r\nname = "dark"\r\n\r\n';
  const suffix = '\r\n\r\n[terminal]\r\nfont_size = 14\r\n';
  const managed = `${BEGIN}\r\nkey = "prefix+g"\r\n${END}\r\n`;
  const current = prefix + managed + suffix;
  assert.equal(removeBlock(current).text, prefix + suffix);
  assert.ok(mergeConfig(prefix, 'key = "prefix+g"').startsWith(prefix));
  assert.ok(mergeConfig(current, 'key = "prefix+x"').endsWith(suffix));
  for (const broken of [`${END}\n`, `${END}\n${BEGIN}\n`, `${BEGIN}\n`, `${BEGIN}\n${BEGIN}\n${END}\n`]) {
    assert.throws(() => removeBlock(broken), /markers/);
  }
});

test("config validation failure leaves the file intact and removes staged files", t => {
  const root = fixture(t);
  const target = path.join(root, "config.toml");
  const original = '# untouched\n[theme]\nname = "dark"\n';
  fs.writeFileSync(target, original);
  const { execute } = fakeHerdr({ failCheck: true });
  assert.throws(() => setupKeys({ target, execute }), /invalid TOML/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.deepEqual(fs.readdirSync(root), ["config.toml"]);
});

test("key conflicts include TOML literal strings and quoted key names", () => {
  for (const binding of ["key = 'prefix+g'", "'key' = 'prefix+g'", '"key" = "prefix+g"']) {
    assert.throws(() => mergeConfig(`[[keys.command]]\n${binding}\n`, 'key = "prefix+g"'), /already bound/);
  }
});

test("invalid UTF-8 is refused without changing the config; UTF-8 BOM is preserved", t => {
  const root = fixture(t), target = path.join(root, "config.toml");
  const original = Buffer.concat([Buffer.from(`${BEGIN}\n# `), Buffer.from([0xff]), Buffer.from(`\n${END}\n`)]);
  fs.writeFileSync(target, original);
  const { execute } = fakeHerdr();
  for (const operation of [setupKeys, removeKeys]) {
    assert.throws(() => operation({ target, execute }), /UTF-8/);
    assert.deepEqual(fs.readFileSync(target), original);
  }
  const bom = '\ufeff# user config\r\n';
  fs.writeFileSync(target, bom);
  setupKeys({ target, execute });
  assert.ok(fs.readFileSync(target, "utf8").startsWith(bom));
});

test("key writes preserve concurrent edits during validation or failed reload", t => {
  const root = fixture(t), target = path.join(root, "config.toml");
  const { execute } = fakeHerdr();
  for (const phase of ["config", "server"]) {
    for (const original of [null, "# original\n"]) {
      if (original === null) fs.rmSync(target, { force: true });
      else fs.writeFileSync(target, original);
      const concurrent = `# concurrent ${phase}\n`;
      const racing = (args, env) => {
        if (args[0] === phase) {
          fs.writeFileSync(target, concurrent);
          if (phase === "server") throw new Error("reload rejected");
        }
        return execute(args, env);
      };
      assert.throws(() => setupKeys({ target, execute: racing }), /concurrent/);
      assert.equal(fs.readFileSync(target, "utf8"), concurrent);
      assert.ok(!fs.readdirSync(root).some(name => /-\d+\.toml$/.test(name)));
    }
  }
});

test("failed reload restores both install and removal, including an empty original file", t => {
  const root = fixture(t);
  const target = path.join(root, "config.toml");
  const { execute, calls } = fakeHerdr({ failReload: true });
  for (const original of ["", `# own config\n${BEGIN}\nkey = "prefix+x"\n${END}\n`]) {
    fs.writeFileSync(target, original);
    const operation = original ? removeKeys : setupKeys;
    assert.throws(() => operation({ target, execute }), /previous config restored/);
    assert.equal(fs.readFileSync(target, "utf8"), original);
    const backups = fs.readdirSync(root).filter(name => name.includes("-backup-"));
    assert.ok(backups.some(name => fs.readFileSync(path.join(root, name), "utf8") === original));
    assert.ok(!fs.readdirSync(root).some(name => /-\d+\.toml$/.test(name)));
  }
  assert.ok(calls.filter(c => c.args[0] === "server").every(c => c.env.HERDR_CONFIG_PATH === target));
});

test("first-install reload failure removes the newly created config", t => {
  const root = fixture(t);
  const target = path.join(root, "config.toml");
  assert.throws(() => setupKeys({ target, execute: fakeHerdr({ failReload: true }).execute }), /restored/);
  assert.ok(!fs.existsSync(target));
});

test("install preserves customized managed keys; --no-keys never edits config", t => {
  const root = fixture(t);
  const target = path.join(root, "config.toml");
  const custom = `# custom\n${BEGIN}\nkey = "prefix+x"\n${END}\n`;
  fs.writeFileSync(target, custom);
  const { execute, calls } = fakeHerdr({ root });
  const installed = install({ root, target, execute });
  assert.equal(installed.keys.changed, false);
  assert.equal(fs.readFileSync(target, "utf8"), custom);
  fs.writeFileSync(target, "invalid user config");
  install({ root, target, execute, noKeys: true });
  assert.equal(fs.readFileSync(target, "utf8"), "invalid user config");
  assert.ok(!calls.some(c => c.args[0] === "config" || c.args[0] === "server"));
});

test("fresh install registers the checkout and adds backed-up keys without changing user settings", t => {
  const root = fixture(t);
  const target = path.join(root, "config.toml");
  const original = '# keep user settings\n\n\n[theme]\nname = "dark"\n';
  fs.writeFileSync(target, original);
  const { execute, calls } = fakeHerdr({ root });
  const result = install({ root, target, execute });
  assert.equal(result.keys.changed, true);
  assert.equal(fs.readFileSync(result.keys.backup, "utf8"), original);
  const configured = fs.readFileSync(target, "utf8");
  assert.ok(configured.startsWith(original));
  assert.ok(configured.includes(`command = "${ID}.open"`));
  assert.ok(calls.some(c => c.args[1] === "link" && c.args.includes("--enabled")));
  assert.ok(calls.some(c => c.args[1] === "reload-config"));
});

test("install and uninstall refuse another checkout before changing files or registration", t => {
  const root = fixture(t);
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  const target = path.join(root, "config.toml");
  fs.writeFileSync(target, "# untouched\n");
  const { execute, calls } = fakeHerdr({ root, plugins: [
    { plugin_id: ID, plugin_root: other, source: { kind: "local" } },
  ] });
  assert.throws(() => install({ root, target, execute }), /another location/);
  assert.throws(() => uninstall({ root, target, execute }), /another location/);
  assert.equal(fs.readFileSync(target, "utf8"), "# untouched\n");
  assert.ok(calls.every(c => c.args[0] === "--version" || c.args[1] === "list"));
});

test("clean removes only parse caches in this plugin's current and legacy state paths", t => {
  const root = fixture(t);
  const env = { HOME: root, HERDR_PLUGIN_STATE_DIR: path.join(root, "state") };
  const legacy = path.join(root, "herdr", "plugins", "state", ID);
  for (const dir of [env.HERDR_PLUGIN_STATE_DIR, legacy]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "parse-cache-v1.json"), "cache");
    fs.writeFileSync(path.join(dir, "parse-cache-v2.json.123.tmp"), "temp");
    fs.writeFileSync(path.join(dir, "parse-cache-v1.json.bench-backup"), "backup");
    fs.writeFileSync(path.join(dir, "other.json"), "keep");
    fs.mkdirSync(path.join(dir, "parse-cache-v3.json"));
  }
  const unrelated = path.join(root, "another-plugin");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, "parse-cache-v1.json"), "keep");
  assert.equal(clean({ env }).length, 4);
  assert.equal(clean({ env }).length, 0);
  assert.equal(fs.readFileSync(path.join(unrelated, "parse-cache-v1.json"), "utf8"), "keep");
  assert.ok(fs.existsSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "other.json")));
  assert.ok(fs.existsSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "parse-cache-v1.json.bench-backup")));
  assert.ok(fs.statSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "parse-cache-v3.json")).isDirectory());
});

test("state paths follow Herdr on Windows, Linux and macOS with environment overrides", () => {
  assert.equal(pluginStateDir({ LOCALAPPDATA: "D:/Local", APPDATA: "D:/Roaming" }, "win32"),
    path.resolve("D:/Local/herdr/plugins", ID));
  for (const platform of ["linux", "darwin"]) {
    assert.equal(pluginStateDir({ HOME: "/users/demo" }, platform),
      path.resolve("/users/demo/.local/state/herdr/plugins", ID));
    assert.equal(pluginStateDir({ HOME: "/users/demo", XDG_STATE_HOME: "/state" }, platform),
      path.resolve("/state/herdr/plugins", ID));
  }
  assert.equal(pluginStateDir({ HERDR_PLUGIN_STATE_DIR: "/custom/plugin" }), path.resolve("/custom/plugin"));
});

test("uninstall removes only its own keys, registration and cache; checkout remains", t => {
  const root = fixture(t);
  const target = path.join(root, "config.toml");
  const env = { HOME: root, HERDR_PLUGIN_STATE_DIR: path.join(root, "state") };
  fs.mkdirSync(env.HERDR_PLUGIN_STATE_DIR);
  fs.writeFileSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "parse-cache-v1.json"), "cache");
  const outside = '# own keys\n[[keys.command]]\nkey = "prefix+x"\n';
  fs.writeFileSync(target, `${outside}${BEGIN}\nkey = "prefix+g"\n${END}\n`);
  const { execute, calls } = fakeHerdr({ root, plugins: [
    { plugin_id: ID, plugin_root: root, enabled: true, source: { kind: "local" } },
    { plugin_id: "other.plugin", plugin_root: root, source: { kind: "local" } },
  ] });
  const result = uninstall({ root, target, execute, env });
  assert.equal(fs.readFileSync(target, "utf8"), outside);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(calls.filter(c => c.args[1] === "unlink").map(c => c.args), [["plugin", "unlink", ID]]);
  assert.ok(fs.existsSync(root));
  assert.ok(result.keys.backup && fs.existsSync(result.keys.backup));
});

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

test("update fast-forwards a real checkout, preserves disabled status and refuses dirty or diverged branches", t => {
  const root = fixture(t);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  const env = { HOME: root, HERDR_PLUGIN_STATE_DIR: path.join(root, "state") };
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(seed, "source.txt"), "v1");
  git(seed, "add", ".");
  git(seed, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", remote, checkout);
  const { execute, calls } = fakeHerdr({ root: checkout, plugins: [
    { plugin_id: ID, plugin_root: checkout, enabled: false, source: { kind: "local" } },
  ] });
  fs.writeFileSync(path.join(seed, "source.txt"), "v2");
  git(seed, "add", ".");
  git(seed, "-c", "commit.gpgsign=false", "commit", "-m", "update");
  git(seed, "push");
  fs.mkdirSync(env.HERDR_PLUGIN_STATE_DIR);
  fs.writeFileSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "parse-cache-v1.json"), "old cache");
  update({ root: checkout, execute, env });
  assert.equal(fs.readFileSync(path.join(checkout, "source.txt"), "utf8"), "v2");
  assert.deepEqual(calls.find(c => c.args[1] === "link").args, ["plugin", "link", checkout, "--disabled"]);
  assert.ok(!calls.some(c => c.args[0] === "config" || c.args[0] === "server"));
  assert.ok(!fs.existsSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "parse-cache-v1.json")));

  fs.writeFileSync(path.join(checkout, "source.txt"), "local edit");
  assert.throws(() => update({ root: checkout, execute, env }), /local changes/);
  assert.equal(fs.readFileSync(path.join(checkout, "source.txt"), "utf8"), "local edit");
  git(checkout, "checkout", "--", "source.txt");
  git(checkout, "checkout", "--detach");
  assert.throws(() => update({ root: checkout, execute, env }), /Detached HEAD/);
  git(checkout, "checkout", "main");

  fs.writeFileSync(path.join(checkout, "source.txt"), "local commit");
  git(checkout, "add", ".");
  git(checkout, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-m", "local change");
  const before = git(checkout, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(seed, "source.txt"), "remote commit");
  git(seed, "add", ".");
  git(seed, "-c", "commit.gpgsign=false", "commit", "-m", "remote change");
  git(seed, "push");
  assert.throws(() => update({ root: checkout, execute, env }), /git pull --ff-only/);
  assert.equal(git(checkout, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(checkout, "source.txt"), "utf8"), "local commit");
  assert.equal(calls.filter(c => c.args[1] === "link").length, 1);
});

test("update refuses a non-Git directory without contacting Herdr", t => {
  const root = fixture(t);
  assert.throws(() => update({ root, execute: () => assert.fail("must not call Herdr") }), /Git checkout/);
});

test("CLI help and invalid arguments have useful exit codes without requiring Herdr", () => {
  const script = path.resolve(__dirname, "../src/install.js");
  for (const args of [["--help"], ["update", "--help"], ["help"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0);
    for (const command of ["install", "update", "clean", "uninstall", "--no-keys"]) {
      assert.ok(result.stdout.includes(command));
    }
  }
  for (const args of [["unknown"], ["update", "--no-keys"], ["install", "--force"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--help/);
  }
});
