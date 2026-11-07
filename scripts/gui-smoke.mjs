// GUI 冒烟：用 playwright-core 驱动真实 Electron 应用，逐页检查渲染是否正常。
// 目的：替代"人工过界面"，把 E5 变成可重复执行的自动化证据。
// 用法：node scripts/gui-smoke.mjs [--exe <path>] [--out <dir>] [--keep]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright-core");

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const ROOT = path.resolve(import.meta.dirname, "..");
const EXE = argValue("--exe", path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"));
const OUT = argValue("--out", path.join(ROOT, "dist-release", "gui-smoke"));
mkdirSync(OUT, { recursive: true });

const report = { exe: EXE, startedAt: new Date().toISOString(), pages: [], consoleErrors: [], ok: false };

const app = await electron.launch({
  executablePath: EXE,
  args: [ROOT],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
  timeout: 60_000,
});

try {
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded", { timeout: 60_000 });

  window.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 300));
  });

  // 记录窗口基本信息
  report.title = await window.title();
  report.url = window.url();
  report.viewport = window.viewportSize();

  // 等待首屏渲染稳定（Electron 应用通常先跑 preload + 引导页）
  await window.waitForTimeout(3000);
  await window.screenshot({ path: path.join(OUT, "00-initial.png"), fullPage: false });

  // 侧栏导航：抓取所有可见路由入口并逐页截图
  const navItems = await window.evaluate(() => {
    const anchors = [...document.querySelectorAll("a[href], [role='menuitem'], nav button, aside button")];
    return anchors
      .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 40), href: el.getAttribute?.("href") ?? null }))
      .filter((item) => item.text.length > 0)
      .slice(0, 40);
  });
  report.navItems = navItems;

  let index = 1;
  for (const item of navItems) {
    try {
      const target = item.href
        ? await window.$(`a[href="${item.href}"]`)
        : await window.$(`text=${item.text}`);
      if (!target) continue;
      await target.click({ timeout: 8000 });
      await window.waitForTimeout(1200);
      const name = `${String(index).padStart(2, "0")}-${item.text.replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 24) || "page"}.png`;
      await window.screenshot({ path: path.join(OUT, name), fullPage: false });
      const bodyText = (await window.evaluate(() => document.body.innerText ?? "")).slice(0, 2000);
      report.pages.push({
        label: item.text,
        href: item.href,
        screenshot: name,
        textLength: bodyText.length,
        bodyPreview: bodyText.slice(0, 200),
      });
      index += 1;
    } catch (error) {
      report.pages.push({ label: item.text, href: item.href, error: String(error).slice(0, 200) });
    }
  }

  // 空白白屏检测：首屏可见文本过少视为渲染失败
  const initialText = (await window.evaluate(() => document.body?.innerText ?? "")).length;
  report.initialTextLength = initialText;
  report.ok = report.consoleErrors.length === 0 && initialText > 50;
} catch (error) {
  report.fatal = String(error).slice(0, 500);
} finally {
  if (!process.argv.includes("--keep")) await app.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    fatal: report.fatal ?? null,
    title: report.title ?? null,
    pages: report.pages.length,
    pageErrors: report.pages.filter((page) => page.error).length,
    consoleErrors: report.consoleErrors.length,
    initialTextLength: report.initialTextLength ?? 0,
    out: OUT,
  }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
