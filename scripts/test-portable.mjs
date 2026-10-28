import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

// Run against an extracted ZIP, preferably in a different drive/Unicode path.
const root = path.resolve(process.argv[2] || "");
const metadata = JSON.parse(await fs.readFile(path.join(root, "VERSION.json"), "utf8"));
const exec = promisify(execFile);
const env = { ...process.env, PATH: path.join(process.env.WINDIR || "C:\\Windows", "System32"), NODE_OPTIONS: "--require=Z:\\missing-portable-test.js", NODE_PATH: "Z:\\missing-modules" };
const startExe = path.join(root, "주주명부렌즈.exe");
const stopExe = path.join(root, "주주명부렌즈_종료.exe");
const statePath = path.join(root, "data", "running.json");
const state = async () => JSON.parse(await fs.readFile(statePath, "utf8"));
const run = async (file) => await exec(file, ["--no-browser"], { cwd: os.tmpdir(), env, windowsHide: true, timeout: 45000 });
const control = (info, method = "GET", token = info.token, origin) => fetch(`http://127.0.0.1:${info.port}/__lens_portable/control`, {
  method, headers: { Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) }, signal: AbortSignal.timeout(3000),
});

assert.equal(await fs.stat(path.join(root, "node_modules")).then(() => true, () => false), false);
assert.equal(await fs.stat(path.join(root, "data")).then(() => true, () => false), false, "Test the clean extracted ZIP.");
const manifest = (await fs.readFile(path.join(root, "SHA256SUMS.txt"), "utf8")).trim().split("\n");
for (const line of manifest) {
  const [expected, name] = line.split("  ");
  assert(!/\.(pdf|csv|xlsx?)$/i.test(name), `Unexpected private document: ${name}`);
  assert.equal(createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex"), expected, name);
}
console.log(`PASS ${manifest.length} package file hashes; no node_modules or user documents`);

let running;
try {
  await run(startExe);
  running = await state();
  let response = await fetch(`http://127.0.0.1:${running.port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert(html.includes(metadata.appVersion));
  assert(!/C:\\Users\\|C:\/Users\/|D:\\Codex\\|D:\/Codex\/|fonts\.googleapis\.com/.test(html));
  console.log("PASS native EXE starts from unrelated cwd with no Node on PATH and hostile NODE_OPTIONS");

  await Promise.all([run(startExe), run(startExe), run(startExe)]);
  assert.equal((await state()).pid, running.pid);
  console.log("PASS concurrent launches reuse only this copy");
  assert.equal((await control(running, "POST", "bad-token")).status, 403);
  assert.equal((await control(running, "POST", running.token, "http://untrusted.example")).status, 403);
  assert.equal((await control(running)).status, 200);
  console.log("PASS unauthenticated/cross-origin shutdown rejected");

  for (const [asset, mime] of [
    ["/_next/static/ocr/worker.min.js", /javascript/],
    ["/_next/static/ocr/core/tesseract-core-lstm.wasm", /wasm/],
    ["/_next/static/ocr/lang/kor.traineddata", /octet-stream/],
    ["/_next/static/ocr/lang/eng.traineddata", /octet-stream/],
  ]) {
    response = await fetch(`http://127.0.0.1:${running.port}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("content-type"), mime, asset);
    assert((await response.arrayBuffer()).byteLength > 1000);
  }
  assert.equal((await fetch(`http://127.0.0.1:${running.port}/app/launcher.mjs`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${running.port}/VERSION.json`)).status, 404);
  console.log("PASS offline OCR assets and MIME types; private runtime files not served");

  const copied = await fs.mkdtemp(path.join(os.tmpdir(), "lens-copied-state-"));
  await fs.mkdir(path.join(copied, "app"));
  await fs.mkdir(path.join(copied, "data"));
  await fs.copyFile(path.join(root, "app", "launcher.mjs"), path.join(copied, "app", "launcher.mjs"));
  await fs.copyFile(path.join(root, "VERSION.json"), path.join(copied, "VERSION.json"));
  await fs.copyFile(statePath, path.join(copied, "data", "running.json"));
  await exec(path.join(root, "runtime", "node.exe"), [path.join(copied, "app", "launcher.mjs"), "--stop"], {
    cwd: copied, windowsHide: true, env: { ...env, NODE_OPTIONS: "", NODE_PATH: "" }, timeout: 10000,
  });
  assert.equal((await control(running)).status, 200);
  console.log("PASS copied stale state cannot stop another folder's server");

  await run(stopExe);
  assert.equal(await fs.stat(statePath).then(() => true, () => false), false);
  await assert.rejects(fetch(`http://127.0.0.1:${running.port}/`, { signal: AbortSignal.timeout(1000) }));
  console.log("PASS native shutdown closes only its authenticated server");
  running = null;

  const lockPath = path.join(root, "data", "launch.lock");
  await fs.writeFile(lockPath, "");
  const old = new Date(Date.now() - 60000);
  await fs.utimes(lockPath, old, old);
  await run(startExe);
  running = await state();
  console.log("PASS crash-left empty launch lock automatically recovered");
  console.log(JSON.stringify({ root, url: `http://127.0.0.1:${running.port}/`, result: "passed" }));
} finally {
  if (running && !process.env.KEEP_PORTABLE_RUNNING) await run(stopExe);
}
