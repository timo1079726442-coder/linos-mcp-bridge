import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import {
  planShadcnAdd,
  planShadcnInit,
  ShadcnCatalog,
} from "../dist/shadcn-registry.js";
import { commitOperation } from "../dist/write-operations.js";
import { dispatchMcp } from "../dist/mcp-tools.js";

const INDEX = [
  {
    name: "button",
    type: "registry:ui",
    title: "Button",
    description: "Displays a button",
    dependencies: ["@radix-ui/react-slot"],
    registryDependencies: ["utils"],
    files: [{ path: "ui/button.tsx" }, { path: "ui/button.jsx" }],
    meta: { links: { radix: { docs: "https://ui.shadcn.com/docs/components/button" } } },
  },
  {
    name: "card",
    type: "registry:ui",
    title: "Card",
    description: "Card container",
    dependencies: [],
    registryDependencies: ["button"],
    files: [{ path: "ui/card.tsx" }],
  },
  { name: "Bad Name", type: "registry:ui", title: "bad", files: [] },
  { name: "x", type: "not-a-registry-type", title: "bad", files: [] },
];

function fakeResponse(payload) {
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: "https://ui.shadcn.com/r/index.json" });
  return response;
}

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-shadcn-"));
  return root;
}

function writeContext(boundary, workspaceId = "ws1") {
  return { boundary, workspaceId, clientId: "c2c_client_SHADCN_TEST" };
}

const DETAILS = {
  button: {
    name: "button",
    type: "registry:ui",
    dependencies: ["@radix-ui/react-slot@^1.0.0"],
    registryDependencies: ["utils"],
    files: [{ path: "ui/button.tsx", content: "export function Button() { return null; }\n" }],
  },
  utils: {
    name: "utils",
    type: "registry:lib",
    dependencies: ["clsx", "tailwind-merge"],
    registryDependencies: [],
    files: [{ path: "lib/utils.ts", content: "export function cn(...inputs) { return inputs; }\n" }],
  },
};

function fakeDetailCatalog() {
  return {
    view: async () => ({ items: [] }),
    item: async (name) => {
      const item = DETAILS[name];
      if (!item) throw new Error("OFFICIAL_REGISTRY_ITEM_NOT_FOUND");
      return { item, style: "new-york" };
    },
  };
}

test("shadcn 目录只接受官方地址与白名单字段", async () => {
  const catalog = new ShadcnCatalog(async () => fakeResponse(INDEX));
  const search = await catalog.search({ query: "but", limit: 5, offset: 0 });
  assert.equal(search.registry, "@shadcn");
  assert.equal(search.total, 1);
  assert.equal(search.results[0].name, "button");
  assert.equal(search.results[0].docs_url, "https://ui.shadcn.com/docs/components/button");

  const all = await catalog.search({ limit: 10 });
  assert.equal(all.total, 2); // 两个非法条目被丢弃

  const view = await catalog.view(["button"]);
  assert.equal(view.metadata_only, true);
  assert.equal(view.includes_component_source, false);
  assert.equal(view.items[0].fileNames.length, 2);
  assert.equal(view.items[0].dependencies[0], "@radix-ui/react-slot");

  await assert.rejects(() => catalog.search({ query: "cookie=abc" }), /INVALID_SEARCH_QUERY/);
  await assert.rejects(() => catalog.search({ query: "../etc" }), /INVALID_SEARCH_QUERY/);
  await assert.rejects(() => catalog.search({ limit: 999 }), /INVALID_SEARCH_LIMIT/);
  await assert.rejects(() => catalog.view(["nope"]), /OFFICIAL_REGISTRY_ITEM_NOT_FOUND/);
  await assert.rejects(() => catalog.view([]), /INVALID_REGISTRY_ITEMS/);
});

test("shadcn Registry 不可用或响应异常时明确失败", async () => {
  const offline = new ShadcnCatalog(async () => {
    throw new Error("offline");
  });
  await assert.rejects(() => offline.search({}), /OFFICIAL_REGISTRY_UNAVAILABLE/);

  const wrongType = new ShadcnCatalog(async () => {
    const response = new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "url", { value: "https://ui.shadcn.com/r/index.json" });
    return response;
  });
  await assert.rejects(() => wrongType.search({}), /OFFICIAL_REGISTRY_UNAVAILABLE/);
});

test("shadcn_add 只做预演：不写文件、不覆盖、alias 不能越界", async () => {
  const root = await workspace();
  try {
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(path.join(root, "app", "components.json"), JSON.stringify({
      style: "new-york", tsx: true, aliases: { ui: "@/components/ui" },
    }), "utf8");
    await writeFile(path.join(root, "app", "package.json"), "{}", "utf8");
    const boundary = await McpSecurityBoundary.create(root);
    const catalog = new ShadcnCatalog(async () => fakeResponse(INDEX));

    const plan = await planShadcnAdd(writeContext(boundary), { components: ["button"], cwd: "app" }, catalog);
    assert.equal(plan.status, "DRY_RUN_ONLY");
    assert.equal(plan.installed, false);
    assert.equal(plan.files_changed, 0);
    assert.equal(plan.candidate_targets[0].relative_path, "app/components/ui/button.tsx");
    assert.equal(plan.candidate_targets[0].exact_cli_target_unverified, true);
    assert.equal(await stat(path.join(root, "app", "components")).then(() => true).catch(() => false), false);

    await assert.rejects(
      () => planShadcnAdd(writeContext(boundary), { components: ["button"], cwd: "missing" }, catalog),
      /PROJECT_PATH_NOT_ALLOWED/,
    );

    await writeFile(path.join(root, "app", "components.json"), JSON.stringify({
      style: "new-york", tsx: true, aliases: { ui: "@/../../outside" },
    }), "utf8");
    await assert.rejects(
      () => planShadcnAdd(writeContext(boundary), { components: ["button"], cwd: "app" }, catalog),
      /PROJECT_PATH_NOT_ALLOWED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shadcn_add dry_run:false 只暂存官方源码，commit 后落盘并自动建目录", async () => {
  const root = await workspace();
  try {
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(path.join(root, "app", "components.json"), JSON.stringify({
      style: "new-york", tsx: true, aliases: { ui: "@/components/ui", utils: "@/lib/utils" },
    }), "utf8");
    await writeFile(path.join(root, "app", "package.json"), JSON.stringify({ name: "webapp" }), "utf8");
    const boundary = await McpSecurityBoundary.create(root);
    const ctx = writeContext(boundary);

    const plan = await planShadcnAdd(ctx, {
      components: ["button"], cwd: "app", dry_run: false,
    }, fakeDetailCatalog());
    assert.equal(plan.install_mode, "STAGED_WRITE");
    assert.equal(plan.status, "PENDING_LOCAL_APPROVAL");
    assert.equal(plan.files_changed, 0);
    assert.deepEqual([...plan.files_to_write].sort(), [
      "app/components/ui/button.tsx",
      "app/lib/utils.ts",
    ]);
    assert.deepEqual(plan.missing_npm_dependencies, ["@radix-ui/react-slot", "clsx", "tailwind-merge"]);
    assert.equal(await stat(path.join(root, "app", "components")).then(() => true).catch(() => false), false);

    const committed = await commitOperation(ctx, plan.operation_id);
    assert.equal(committed.status, "COMMITTED");
    assert.equal(committed.files_changed, 2);
    assert.match(await readFile(path.join(root, "app", "components", "ui", "button.tsx"), "utf8"), /Button/);
    assert.match(await readFile(path.join(root, "app", "lib", "utils.ts"), "utf8"), /cn/);

    // 内容一致的文件会被跳过；全部一致时明确报 ALREADY_INSTALLED。
    await assert.rejects(
      () => planShadcnAdd(ctx, { components: ["button"], cwd: "app", dry_run: false }, fakeDetailCatalog()),
      /SHADCN_ALREADY_INSTALLED/,
    );

    // 本地改过组件后再覆盖：只暂存有变化的文件。
    await writeFile(path.join(root, "app", "components", "ui", "button.tsx"), "// local edit\n", "utf8");
    await assert.rejects(
      () => planShadcnAdd(ctx, { components: ["button"], cwd: "app", dry_run: false }, fakeDetailCatalog()),
      /SHADCN_TARGET_EXISTS/,
    );
    const overwrite = await planShadcnAdd(ctx, {
      components: ["button"], cwd: "app", dry_run: false, overwrite: true,
    }, fakeDetailCatalog());
    assert.deepEqual(overwrite.files_to_write, ["app/components/ui/button.tsx"]);
    assert.deepEqual(overwrite.overwriting, ["app/components/ui/button.tsx"]);
    assert.deepEqual(overwrite.unchanged, ["app/lib/utils.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shadcn_add 要求先有 components.json，init 只做预演", async () => {
  const root = await workspace();
  try {
    await mkdir(path.join(root, "proj"), { recursive: true });
    await writeFile(path.join(root, "proj", "package.json"), "{}", "utf8");
    const boundary = await McpSecurityBoundary.create(root);
    const catalog = new ShadcnCatalog(async () => fakeResponse(INDEX));

    await assert.rejects(
      () => planShadcnAdd(writeContext(boundary), { components: ["button"], cwd: "proj" }, catalog),
      /SHADCN_NOT_INITIALIZED/,
    );
    const init = await planShadcnInit(writeContext(boundary), { cwd: "proj", template: "vite", base: "radix" });
    assert.equal(init.status, "STAGED_WRITE");
    assert.equal(init.initialization_performed, false);
    assert.equal(init.has_components_json, false);
    assert.deepEqual(init.files_to_write, ["proj/components.json", "proj/src/lib/utils.ts"]);
    assert.equal(init.missing_npm_dependencies.includes("clsx"), true);
    assert.equal(await stat(path.join(root, "proj", "components.json")).then(() => true).catch(() => false), false);

    const committed = await commitOperation(writeContext(boundary), init.operation_id);
    assert.equal(committed.status, "COMMITTED");
    assert.match(await readFile(path.join(root, "proj", "components.json"), "utf8"), /"style": "new-york"/);
    assert.match(await readFile(path.join(root, "proj", "src", "lib", "utils.ts"), "utf8"), /twMerge/);

    await assert.rejects(
      () => planShadcnInit(writeContext(boundary), { cwd: "proj" }),
      /SHADCN_ALREADY_INITIALIZED/,
    );
    await writeFile(path.join(root, "proj", "components.json"), "{}", "utf8");
    const overwrite = await planShadcnInit(writeContext(boundary), { cwd: "proj", overwrite: true });
    assert.deepEqual(overwrite.files_to_write, ["proj/components.json"]);
    assert.equal(overwrite.overwriting.includes("proj/components.json"), true);
    assert.equal(overwrite.unchanged.includes("proj/src/lib/utils.ts"), true);
    await assert.rejects(
      () => planShadcnInit(writeContext(boundary), { cwd: "proj", template: "unknown" }),
      /UNSUPPORTED_TEMPLATE/,
    );

    const empty = await mkdtemp(path.join(tmpdir(), "c2c-shadcn-empty-"));
    try {
      await mkdir(path.join(empty, "p"), { recursive: true });
      const emptyBoundary = await McpSecurityBoundary.create(empty);
      await assert.rejects(
        () => planShadcnInit(writeContext(emptyBoundary, "ws2"), { cwd: "p" }),
        /NODE_PROJECT_PACKAGE_JSON_REQUIRED/,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP 侧 shadcn_add/init 走工作区边界，tools/list 含 4 个组件工具", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-shadcn-mcp-"));
  const root = path.join(parent, "workspace");
  const profile = path.join(parent, "profiles", "mb_pf_test");
  await mkdir(path.join(root, "proj"), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(root, "proj", "package.json"), "{}", "utf8");
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {} }), "utf8");
  const caller = { clientId: "c2c_client_SHADCN_TEST", requestId: 5 };
  const call = (name, args) => dispatchMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    "ws_shadcn",
    root,
    path.join(profile, "executions"),
    { caller, writeScopeGranted: true, toolPolicyDir: profile },
  );
  try {
    const init = await call("shadcn_init", { cwd: "proj" });
    assert.equal(init.status, "STAGED_WRITE");
    assert.deepEqual(init.files_to_write, ["proj/components.json", "proj/src/lib/utils.ts"]);
    await assert.rejects(() => call("shadcn_add", { components: ["button"], cwd: "proj" }), /SHADCN_NOT_INITIALIZED|OFFICIAL_REGISTRY_UNAVAILABLE/);
    await assert.rejects(() => call("shadcn_init", { cwd: "../outside" }), /PROJECT_PATH_NOT_ALLOWED/);

    const listed = await dispatchMcp(
      { method: "tools/list", params: {} },
      "ws_shadcn",
      root,
      path.join(profile, "executions"),
      { caller, toolPolicyDir: profile },
    );
    const names = listed.tools.map((tool) => tool.name);
    for (const name of ["shadcn_search", "shadcn_view", "shadcn_add", "shadcn_init"]) {
      assert.ok(names.includes(name), name);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
