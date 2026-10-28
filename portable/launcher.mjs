import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const statePath = path.join(dataDir, "running.json");
const logPath = path.join(dataDir, "startup.log");
const lockPath = path.join(dataDir, "launch.lock");
const metadata = JSON.parse(await fs.readFile(path.join(root, "VERSION.json"), "utf8"));
const canonicalRoot = await fs.realpath(root);
const rootId = createHash("sha256").update(canonicalRoot.toLowerCase()).digest("hex");
const controlPath = "/__lens_portable/control";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readState() {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (Number.isInteger(state.port) && state.port > 0 && state.port < 65536 &&
        typeof state.token === "string" && /^[a-f0-9]{64}$/.test(state.token) &&
        state.packageId === metadata.packageId && state.rootId === rootId) return state;
  } catch { /* Not running, or an incomplete old state file. */ }
  return null;
}

async function contact(state, method = "GET") {
  if (!state) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}${controlPath}`, {
      method,
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.packageId === metadata.packageId && body.rootId === rootId && body.token === state.token ? body : null;
  } catch { return null; }
}

function openBrowser(url) {
  if (process.argv.includes("--no-browser")) return;
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    cwd: root, detached: true, windowsHide: true, stdio: "ignore",
  });
  child.on("error", (error) => {
    void fs.appendFile(logPath, `Browser could not open: ${error.message}\n`);
  });
  child.unref();
}

async function showRunning(state) {
  const url = `http://127.0.0.1:${state.port}/`;
  await fs.writeFile(path.join(root, "OPEN.url"), `[InternetShortcut]\r\nURL=${url}\r\n`, "utf8");
  openBrowser(url);
  console.log(JSON.stringify({ ...metadata, url, pid: state.pid }));
}

async function acquireLaunchLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const lock = await fs.open(lockPath, "wx");
      await lock.writeFile(JSON.stringify({ pid: process.pid, created: Date.now() }));
      return lock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const info = JSON.parse(await fs.readFile(lockPath, "utf8"));
        let alive = true;
        try { process.kill(info.pid, 0); } catch (probeError) {
          if (probeError.code === "ESRCH") alive = false;
        }
        if (!alive || Date.now() - info.created > 60000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // Recover a launcher that crashed between creating and writing its lock.
        // A just-created empty lock may still belong to a concurrent launcher.
        try {
          if (Date.now() - (await fs.stat(lockPath)).mtimeMs > 5000) await fs.unlink(lockPath);
        } catch { /* Another launcher released it first. */ }
      }
      await sleep(200);
    }
  }
  throw new Error("Another launch is still in progress. Try again shortly.");
}

async function start() {
  const lock = await acquireLaunchLock();
  try {
    let state = await readState();
    if (await contact(state)) return await showRunning(state);
    await fs.writeFile(logPath, `${new Date().toISOString()} ${metadata.packageId}\n`, "utf8");
    const log = await fs.open(logPath, "a");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--serve"], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "", NODE_PATH: "" },
    });
    let launchError;
    child.on("error", (error) => { launchError = error; });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError;
      state = await readState();
      if (state?.pid === child.pid && await contact(state)) return await showRunning(state);
      await sleep(200);
    }
    throw new Error(`Startup timed out. See ${logPath}`);
  } finally {
    await lock.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function stop() {
  const state = await readState();
  if (!await contact(state)) {
    console.log("This portable copy is not running. No other process was stopped.");
    return;
  }
  if (!await contact(state, "POST")) throw new Error("The running copy did not accept shutdown.");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!await contact(state)) {
      console.log("Stopped this portable copy.");
      return;
    }
    await sleep(100);
  }
  throw new Error("Shutdown is still pending. No unrelated process was stopped.");
}

async function serve() {
  const { startProdServer } = await import("./vinext-runtime.mjs");
  // vinext beta serves unknown extensions as octet-stream. Give WebAssembly
  // its proper MIME so browsers can compile OCR cores using streaming.
  const coreDir = path.join(root, "dist", "client", "_next", "static", "ocr", "core");
  const wasmAssets = new Map();
  for (const name of await fs.readdir(coreDir)) {
    if (name.endsWith(".wasm")) wasmAssets.set(`/_next/static/ocr/core/${name}`, await fs.readFile(path.join(coreDir, name)));
  }
  const { server, port } = await startProdServer({
    port: 0, host: "127.0.0.1", outDir: path.join(root, "dist"), silent: true,
  });
  const token = randomBytes(32).toString("hex");
  const state = { packageId: metadata.packageId, rootId, pid: process.pid, port, token };
  let stopping = false;
  const handlers = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403); response.end("Local host only"); return;
    }
    if (request.url?.split("?")[0] === controlPath) {
      const expected = Buffer.from(`Bearer ${token}`);
      const provided = Buffer.from(request.headers.authorization || "");
      const authorized = expected.length === provided.length && timingSafeEqual(expected, provided);
      const origin = request.headers.origin;
      if (!authorized || (origin && origin !== `http://127.0.0.1:${port}`)) {
        response.writeHead(403); response.end("Forbidden"); return;
      }
      if (request.method !== "GET" && request.method !== "POST") {
        response.writeHead(405); response.end(); return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ...state, appVersion: metadata.appVersion }));
      if (request.method === "POST") void shutdown();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405); response.end("PDF processing happens in your browser"); return;
    }
    const wasm = wasmAssets.get(request.url?.split("?")[0]);
    if (wasm) {
      response.writeHead(200, { "Content-Type": "application/wasm", "Content-Length": wasm.length });
      response.end(request.method === "HEAD" ? undefined : wasm);
      return;
    }
    for (const handler of handlers) handler.call(server, request, response);
  });
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    if ((await readState())?.token === token) await fs.unlink(statePath).catch(() => {});
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  // Do not advertise readiness until SSR also works, not just the TCP listener.
  try {
    const html = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(15000) });
    if (!html.ok || !(await html.text()).includes(metadata.appVersion)) {
      throw new Error("The packaged application failed its startup version check.");
    }
    await fs.writeFile(statePath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    console.log(`${metadata.packageId} ready on http://127.0.0.1:${port}/`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

try {
  await fs.mkdir(dataDir, { recursive: true });
  if (process.argv.includes("--serve")) await serve();
  else if (process.argv.includes("--stop")) await stop();
  else if (process.argv.includes("--status")) {
    const state = await readState();
    if (!await contact(state)) process.exitCode = 1;
    else console.log(JSON.stringify({ packageId: metadata.packageId, url: `http://127.0.0.1:${state.port}/`, pid: state.pid }));
  } else await start();
} catch (error) {
  await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
  await fs.appendFile(logPath, `${new Date().toISOString()} ${error.stack || error}\n`).catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
}
