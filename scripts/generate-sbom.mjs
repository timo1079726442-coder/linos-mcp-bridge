#!/usr/bin/env node
/**
 * 生成 SBOM（CycloneDX 1.5 JSON 子集）+ 第三方许可证清单。
 *
 * 用途：发布前证明"包里到底有哪些第三方组件、什么版本、什么许可证"，
 * 不依赖外部工具链，纯 Node 读取 package-lock.json 与已安装的 LICENSE 文件。
 *
 * 用法：
 *   node scripts/generate-sbom.mjs            # 写 dist-release/sbom.json 与 LICENSES-THIRD-PARTY.md
 *   node scripts/generate-sbom.mjs --check    # 只校验，不写文件（CI 用）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHECK_ONLY = process.argv.includes("--check");
const OUT_DIR = path.join(ROOT, "dist-release");

/** 真正进入发行包的依赖树（与 electron-builder.yml 的 files 一致）。 */
const TREES = [
  { name: "runtime", lockFile: path.join(ROOT, "runtime", "package-lock.json"), shipped: true },
  { name: "app", lockFile: path.join(ROOT, "package-lock.json"), shipped: false },
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function licenseOf(pkgDir) {
  if (!existsSync(pkgDir)) return "UNKNOWN";
  const pkgFile = path.join(pkgDir, "package.json");
  if (existsSync(pkgFile)) {
    const pkg = readJson(pkgFile);
    if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
    if (pkg.license && typeof pkg.license === "object" && pkg.license.type) return String(pkg.license.type);
    if (Array.isArray(pkg.licenses)) {
      const types = pkg.licenses.map((entry) => entry?.type).filter(Boolean);
      if (types.length) return types.join(" OR ");
    }
  }
  for (const candidate of readdirSync(pkgDir)) {
    if (/^licen[cs]e/i.test(candidate) || /^copying/i.test(candidate)) return `SEE FILE (${candidate})`;
  }
  return "UNKNOWN";
}

/** lockfile v3：packages 键为相对路径，"" 表示根。 */
function collect(lockFile, treeName) {
  if (!existsSync(lockFile)) return [];
  const lock = readJson(lockFile);
  const packages = lock.packages ?? {};
  const entries = [];
  for (const [key, meta] of Object.entries(packages)) {
    if (!key) continue;
    const name = meta.name ?? key.split("node_modules/").pop();
    if (!name || !meta.version) continue;
    const pkgDir = path.join(path.dirname(lockFile), key);
    entries.push({
      name,
      version: meta.version,
      dev: meta.dev === true,
      optional: meta.optional === true,
      license: meta.license && typeof meta.license === "string" ? meta.license : licenseOf(pkgDir),
      tree: treeName,
      resolved: typeof meta.resolved === "string" ? meta.resolved : undefined,
      integrity: typeof meta.integrity === "string" ? meta.integrity : undefined,
    });
  }
  return entries;
}

function purl(component) {
  const name = component.name.startsWith("@") ? `%40${component.name.slice(1).replace("/", "%2F")}` : component.name;
  return `pkg:npm/${name}@${component.version}`;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const components = [];
for (const tree of TREES) {
  for (const entry of collect(tree.lockFile, tree.name)) {
    components.push({ ...entry, shipped: tree.shipped && entry.dev !== true });
  }
}

components.sort((a, b) => `${a.tree}/${a.name}@${a.version}`.localeCompare(`${b.tree}/${b.name}@${b.version}`));

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: "linos", name: "generate-sbom", version: "1.0.0" }],
    component: {
      type: "application",
      name: "linos-mcp-bridge",
      version: readJson(path.join(ROOT, "package.json")).version,
    },
  },
  components: components.map((component) => ({
    type: "library",
    "bom-ref": `${component.tree}:${purl(component)}`,
    name: component.name,
    version: component.version,
    purl: purl(component),
    scope: component.shipped ? "required" : "optional",
    ...(component.integrity ? { hashes: [{ alg: "SHA-512", content: component.integrity.replace(/^sha512-/, "") }] } : {}),
    licenses: [{ license: { id: component.license } }],
    properties: [
      { name: "linos:tree", value: component.tree },
      { name: "linos:shipped", value: String(component.shipped) },
      { name: "linos:dev", value: String(component.dev === true) },
    ],
  })),
};

const shipped = components.filter((component) => component.shipped);
const licenseCounts = new Map();
for (const component of shipped) {
  const key = component.license || "UNKNOWN";
  licenseCounts.set(key, (licenseCounts.get(key) ?? 0) + 1);
}

const notesFile = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
const notesHash = existsSync(notesFile) ? sha256File(notesFile) : null;

const summary = {
  totalComponents: components.length,
  shippedComponents: shipped.length,
  unknownLicenseShipped: shipped.filter((component) => !component.license || component.license === "UNKNOWN").map((component) => `${component.name}@${component.version}`),
  licenseHistogram: Object.fromEntries([...licenseCounts.entries()].sort((a, b) => b[1] - a[1])),
  thirdPartyNoticesSha256: notesHash,
  sbomSha256: null,
};

if (CHECK_ONLY) {
  console.log(JSON.stringify({ ok: summary.unknownLicenseShipped.length === 0, ...summary }, null, 2));
  process.exitCode = summary.unknownLicenseShipped.length === 0 ? 0 : 1;
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  const bomFile = path.join(OUT_DIR, "sbom.json");
  writeFileSync(bomFile, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
  summary.sbomSha256 = sha256File(bomFile);
  const summaryFile = path.join(OUT_DIR, "sbom-summary.json");
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ bomFile, summaryFile, ...summary }, null, 2));
}
