"use strict";

// File scans, transcript parsing and cache writes never run on the TUI thread.
const { Worker } = require("node:worker_threads");
const path = require("node:path");

class Loader {
  constructor(env, onMessage) {
    this.worker = new Worker(path.join(__dirname, "loader-worker.js"), { env: { ...process.env, ...env } });
    this.worker.on("message", onMessage);
    this.worker.on("error", error => onMessage({ type: "error", error: error.message }));
    this.worker.on("exit", code => {
      if (!this.closed && code) onMessage({ type: "error", error: `History loader exited (${code})` });
    });
  }
  send(message) { if (!this.closed) this.worker.postMessage(message); }
  close() {
    this.closed = true;
    return this.worker.terminate();
  }
}

module.exports = { Loader };
