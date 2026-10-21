"use strict";

// Native titles and saved forks. No model turns, shell commands or Herdr patches.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { sessionEnv } = require("./paths");

function packageFile(name, env = process.env) {
  for (const dir of [__dirname, ...(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)]) {
    for (const base of [dir, path.dirname(dir)]) {
      try { return createRequire(path.join(base, "session-graph-resolver.cjs")).resolve(`${name}/package.json`); }
      catch {}
      for (const modules of [path.join(base, "node_modules"), path.join(base, "lib", "node_modules")]) {
        const candidate = path.join(modules, name, "package.json");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error(`${name} is not installed on PATH.`);
}

function codexBinary(env = process.env) {
  if (env.CODEX_BIN_PATH) return env.CODEX_BIN_PATH;
  try {
    const pkg = packageFile("@openai/codex", env);
    const suffix = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
    const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-` +
      ({ win32: "pc-windows-msvc", darwin: "apple-darwin", linux: "unknown-linux-musl" })[process.platform];
    const require = createRequire(pkg);
    let vendor;
    try { vendor = path.join(path.dirname(require.resolve(`@openai/codex-${suffix}/package.json`)), "vendor"); }
    catch { vendor = path.join(path.dirname(pkg), "vendor"); }
    const binary = path.join(vendor, triple, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    if (fs.existsSync(binary)) return binary;
  } catch {}
  const command = process.platform === "win32" ? "codex.exe" : "codex";
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return command;
}

function codexRequest(method, params, { env = process.env, binary = codexBinary(env), timeout = 60000, spawnChild = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(binary, ["app-server", "--listen", "stdio://"], {
      env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = "", stderr = "", stage = "initialize", done = false, result, failure;
    // Cold startup and local metadata operations can exceed 20 seconds.
    // Keep a single deadline; never retry a possibly persisted fork.
    const timer = setTimeout(() => finish(new Error(`Codex App Server timed out during ${stage}.`)), timeout);
    const send = message => child.stdin.write(JSON.stringify(message) + "\n");
    function finish(error) {
      if (done) return;
      done = true;
      failure = error;
      if (failure && stderr.trim()) failure = new Error(`${error.message}\n${stderr.trim()}`);
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
    }
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.on("exit", code => {
      if (!done) finish(new Error(`Codex App Server exited before replying (${code}).`));
    });
    child.on("close", () => {
      if (failure) reject(failure); else resolve(result);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      pending += chunk;
      let end;
      while (!done && (end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let body;
        try { body = JSON.parse(line); } catch { continue; }
        if (body.method || (body.id !== 1 && body.id !== 2)) continue;
        if (body.error) { finish(new Error(body.error.message || "Codex request failed.")); break; }
        if (body.id === 1) {
          stage = method;
          send({ method: "initialized", params: {} });
          send({ id: 2, method, params });
        } else { result = body.result; finish(); }
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "session_graph", title: "Session Graph", version: "0.1.0" },
    } });
  });
}

function validateTitle(title) {
  const normalized = String(title).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Session name cannot be empty.");
  if ([...normalized].length > 200) throw new Error("Session name must be at most 200 characters.");
  return normalized;
}

async function renameClaude(session, title) {
  // Same custom-title record and sidecar written by Claude Code's saveCustomTitle.
  const file = session.file;
  if (!file || path.basename(file, ".jsonl") !== session.sessionId) throw new Error("Claude session identity mismatch.");
  const fd = fs.openSync(file, "r+");
  let eol = "";
  try {
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    if (size) { fs.readSync(fd, last, 0, 1, size - 1); if (last[0] !== 10) eol = "\n"; }
  } finally { fs.closeSync(fd); }
  const target = path.join(path.dirname(file), session.sessionId, "custom-title.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ customTitle: title }) + "\n", { flag: "wx", mode: 0o600 });
    fs.appendFileSync(file, eol + JSON.stringify({ type: "custom-title", customTitle: title, sessionId: session.sessionId }) + "\n");
    fs.renameSync(temp, target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

async function dshBackend(root, compression, env = process.env) {
  const require = createRequire(packageFile("@deepseek-ai/dsh", env));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { default: Backend }] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-session-persistence-jsonl"),
  ]);
  const context = new Context();
  const backend = new Backend(context, { root, compression });
  return { context, backend };
}

async function renameDst(session, title, env) {
  if (!/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(path.basename(session.file))) {
    throw new Error("DST rename requires the per-session generation layout; update DST first.");
  }
  const root = path.dirname(path.dirname(path.dirname(session.file)));
  const { context, backend } = await dshBackend(root, session.file.endsWith(".zstd") ? "zstd" : "none", env);
  let handle;
  try {
    handle = await backend.open(session.sessionId, "write");
    const { events } = await handle.read();
    await handle.append([{ seq: (events[events.length - 1]?.seq ?? -1) + 1, time: Date.now(),
      type: "session/title", data: { title, messageSeqs: [], source: { kind: "user" } } }]);
    await handle.flush();
  } finally {
    try { if (handle) await handle.close(); } finally { await context.fiber.dispose(); }
  }
}

async function renameSession(session, raw, { env = process.env, request = codexRequest } = {}) {
  const title = validateTitle(raw);
  env = sessionEnv(env);
  if (session.agent === "codex") {
    await request("thread/name/set", { threadId: session.sessionId, name: title }, { env });
  } else if (session.agent === "claude") await renameClaude(session, title);
  else if (session.agent === "dst") await renameDst(session, title, env);
  else throw new Error(`Native rename is not supported for ${session.agent}.`);
  return title;
}

async function forkSession(session, { env = process.env, request = codexRequest } = {}) {
  if (session.agent !== "codex") throw new Error(`Saved-session fork is not supported for ${session.agent}.`);
  const result = await request("thread/fork", { threadId: session.sessionId, excludeTurns: true }, { env: sessionEnv(env) });
  const id = result?.thread?.id;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || "")) throw new Error("Codex did not return a saved fork ID.");
  return id;
}

module.exports = { renameSession, forkSession, codexRequest, codexBinary, dshBackend, validateTitle };
