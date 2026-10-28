import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, isBuiltin } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return args[index + 1];
};
const packageId = value("--version", "v2026.10.28-portable.1");
if (!/^[a-zA-Z0-9._-]+$/.test(packageId)) throw new Error("Invalid portable version");
const outputParent = path.resolve(value("--out", path.join(root, "outputs", "portable")));
const output = path.join(outputParent, `주주명부렌즈_${packageId}_Windows_x64`);
const nodeExe = path.resolve(value("--node", process.execPath));
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build on Windows x64.");
const nodeVersion = execFileSync(nodeExe, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
if (Number(nodeVersion.slice(1).split(".")[0]) < 22) throw new Error("Node.js 22.13+ is required.");
await fs.mkdir(outputParent, { recursive: true });
// Never replace or recursively delete an existing release.
await fs.mkdir(output);
const env = { ...process.env, PATH: `${path.dirname(nodeExe)};${path.join(root, "node_modules", ".bin")};${process.env.PATH || ""}` };
if (!args.includes("--skip-build")) {
  execFileSync(nodeExe, [path.join(path.dirname(fileURLToPath(import.meta.resolve("vinext"))), "cli.js"), "build"], { cwd: root, env, stdio: "inherit", windowsHide: true });
}
const pageSource = await fs.readFile(path.join(root, "app", "page.tsx"), "utf8");
const appVersion = pageSource.match(/v\d{4}\.\d{2}\.\d{2}\.\d+/)?.[0];
if (!appVersion) throw new Error("App version could not be determined.");
const appDir = path.join(output, "app");
const licenseDir = path.join(output, "licenses");
await fs.mkdir(appDir);
await fs.mkdir(licenseDir);
await fs.mkdir(path.join(output, "runtime"));
for (const name of ["client", "server"]) {
  await fs.cp(path.join(root, "dist", name), path.join(output, "dist", name), {
    recursive: true, dereference: true,
    filter: (source) => !/\.(map|pdf|csv|xlsx?)$/i.test(source),
  });
}
for (const name of ["kor", "eng"]) {
  await fs.access(path.join(output, "dist", "client", "_next", "static", "ocr", "lang", `${name}.traineddata`));
}
await fs.copyFile(nodeExe, path.join(output, "runtime", "node.exe"));
await fs.copyFile(path.join(root, "portable", "launcher.mjs"), path.join(appDir, "launcher.mjs"));
await fs.copyFile(path.join(root, "portable", "사용방법.txt"), path.join(output, "사용방법.txt"));

// Use the installed production adapter, bundled down to Node built-ins only.
// Unlike copying the vinext CLI this does not carry Vite/compilers/node_modules.
const viteRequire = createRequire(require.resolve("vite"));
const { rolldown } = await import(pathToFileURL(viteRequire.resolve("rolldown")).href);
const bundle = await rolldown({
  input: fileURLToPath(import.meta.resolve("vinext/server/prod-server")),
  platform: "node",
  external: (id) => isBuiltin(id),
});
const bundled = await bundle.write({ file: path.join(appDir, "vinext-runtime.mjs"), format: "esm", codeSplitting: false, sourcemap: false });
for (const chunk of bundled.output) {
  if (chunk.type === "chunk" && chunk.imports.some((id) => !isBuiltin(id))) {
    throw new Error(`Portable runtime still has external imports: ${chunk.imports.join(", ")}`);
  }
}
await bundle.close();

const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
for (const stop of [false, true]) {
  const outputExe = path.join(output, stop ? "주주명부렌즈_종료.exe" : "주주명부렌즈.exe");
  execFileSync(csc, ["/nologo", "/target:winexe", "/optimize+", "/reference:System.Windows.Forms.dll", ...(stop ? ["/define:STOP"] : []), `/out:${outputExe}`, path.join(root, "portable", "Launcher.cs")], { cwd: root, stdio: "inherit", windowsHide: true });
}

const localLicense = value("--node-license", "");
const nodeLicense = localLicense ? await fs.readFile(localLicense, "utf8") : await (async () => {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);
  if (!response.ok) throw new Error(`Cannot obtain Node ${nodeVersion} LICENSE: ${response.status}`);
  return await response.text();
})();
if (!nodeLicense.includes("Node.js") || !nodeLicense.includes("Copyright")) throw new Error("Invalid Node license file.");
await fs.writeFile(path.join(licenseDir, "Node.js-LICENSE.txt"), nodeLicense);

function resolvePackage(name, resolver) {
  try { return resolver.resolve(`${name}/package.json`); } catch { /* Package exports may hide it. */ }
  for (const base of resolver.resolve.paths(name) || []) {
    const candidate = path.join(base, name, "package.json");
    try { if (require(candidate).name === name) return candidate; } catch { /* Not installed at this lookup path. */ }
  }
  return null;
}
const queue = ["vinext", "react", "react-dom", "react-server-dom-webpack", "pdfjs-dist", "tesseract.js", "tailwindcss"].map((name) => ({ name, resolver: require }));
const notices = [];
const seen = new Set();
while (queue.length) {
  const { name, resolver } = queue.shift();
  const manifestPath = resolvePackage(name, resolver);
  if (!manifestPath) continue;
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const key = `${manifest.name}@${manifest.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const packageRoot = path.dirname(manifestPath);
  const prefix = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  const files = await fs.readdir(packageRoot, { withFileTypes: true });
  const copies = [];
  for (const entry of files) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice|authors|copyright)(\.|$)/i.test(entry.name)) {
      const destination = `${prefix}-${entry.name}`;
      await fs.copyFile(path.join(packageRoot, entry.name), path.join(licenseDir, destination));
      copies.push(destination);
    }
  }
  notices.push(`${key} | ${typeof manifest.license === "string" ? manifest.license : "See license"} | ${copies.join(", ") || "See package source"}`);
  const childRequire = createRequire(manifestPath);
  for (const dependency of Object.keys(manifest.dependencies || {})) queue.push({ name: dependency, resolver: childRequire });
}
await fs.writeFile(path.join(licenseDir, "THIRD-PARTY-NOTICES.txt"), `Included libraries and their runtime dependencies (some build-only dependencies may also be listed):\n\n${notices.sort().join("\n")}\n\nTesseract language data: https://github.com/tesseract-ocr/tessdata_fast (Apache-2.0).\n`);
const metadata = { packageId, appVersion, nodeVersion, platform: "win32-x64", builtAt: new Date().toISOString() };
await fs.writeFile(path.join(output, "VERSION.json"), `${JSON.stringify(metadata, null, 2)}\n`);
async function hashTree(directory) {
  const hashes = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Portable package must not contain symlinks: ${file}`);
    if (entry.isDirectory()) hashes.push(...await hashTree(file));
    else hashes.push(`${createHash("sha256").update(await fs.readFile(file)).digest("hex")}  ${path.relative(output, file).replaceAll("\\", "/")}`);
  }
  return hashes;
}
await fs.writeFile(path.join(output, "SHA256SUMS.txt"), `${(await hashTree(output)).sort().join("\n")}\n`);
console.log(JSON.stringify({ output, ...metadata }, null, 2));
