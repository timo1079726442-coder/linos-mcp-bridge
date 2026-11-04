/**
 * 网页内浮层面板：把「工具名 + 参数」发给后台，结果可一键复制回对话。
 * 站点差异只影响挂载点，面板本身用 Shadow DOM 隔离，避免被页面样式污染。
 */
(() => {
  if (window.__linosC2CPanelLoaded) return;
  window.__linosC2CPanelLoaded = true;

  const host = document.createElement("div");
  host.id = "linos-c2c-host";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; right: 16px; bottom: 88px; z-index: 2147483647; font: 13px/1.5 system-ui, "Segoe UI", sans-serif; }
      .toggle { width: 44px; height: 44px; border-radius: 22px; border: 0; cursor: pointer;
        background: #0f766e; color: #fff; font-weight: 700; box-shadow: 0 6px 18px rgba(0,0,0,.25); }
      .panel { display: none; width: 380px; max-height: 70vh; overflow: auto; background: #111318; color: #e6e6e6;
        border: 1px solid #2a2f3a; border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.45); padding: 12px; }
      .panel.open { display: block; }
      .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
      .grow { flex: 1; }
      h3 { margin: 0; font-size: 13px; font-weight: 600; }
      input, textarea, select { width: 100%; box-sizing: border-box; background: #1a1e26; color: #e6e6e6;
        border: 1px solid #2c323d; border-radius: 8px; padding: 6px 8px; font: inherit; }
      textarea { min-height: 62px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
      button.btn { background: #2563eb; color: #fff; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; font: inherit; }
      button.ghost { background: #232833; color: #cfd6e4; }
      button:disabled { opacity: .55; cursor: default; }
      pre { white-space: pre-wrap; word-break: break-all; background: #0b0d11; border: 1px solid #222834;
        border-radius: 8px; padding: 8px; max-height: 240px; overflow: auto; margin: 8px 0 0; }
      .hint { color: #8b93a5; font-size: 11px; margin: 4px 0 8px; }
      .err { color: #f87171; }
      .ok { color: #34d399; }
      .gear { background: transparent; border: 0; color: #8b93a5; cursor: pointer; font-size: 15px; }
      .cfg { display: none; border-top: 1px dashed #2c323d; margin-top: 8px; padding-top: 8px; }
      .cfg.open { display: block; }
    </style>
    <div class="wrap">
      <button class="toggle" id="toggle" title="LinOS C2C 工具箱">C2C</button>
      <div class="panel" id="panel">
        <div class="row">
          <h3 class="grow">LinOS C2C 工具箱</h3>
          <button class="gear" id="gear" title="设置">⚙</button>
        </div>
        <div class="hint">先点「列出工具」，选工具、填参数，执行后把结果复制回对话。</div>
        <div class="row">
          <select id="tool" class="grow"><option value="">（先点列出工具）</option></select>
          <button class="btn ghost" id="list">列出工具</button>
        </div>
        <textarea id="args" placeholder='参数 JSON，例如：{"path":"C:\\\\workspace\\\\README.md"}'></textarea>
        <div class="row" style="margin-top:8px">
          <button class="btn" id="run">执行</button>
          <button class="btn ghost" id="copy" disabled>复制结果</button>
          <span id="status" class="grow"></span>
        </div>
        <pre id="out" style="display:none"></pre>
        <div class="cfg" id="cfg">
          <div class="row"><span style="width:52px">地址</span><input id="url" placeholder="http://127.0.0.1:48766/mcp"></div>
          <div class="row"><span style="width:52px">令牌</span><input id="token" type="password" placeholder="c2c_api_..."></div>
          <div class="row"><button class="btn" id="save">保存</button><span id="cfgStatus" class="grow"></span></div>
        </div>
      </div>
    </div>
  `;

  const $ = (id) => shadow.getElementById(id);
  const setStatus = (text, kind) => {
    const el = $("status");
    el.textContent = text || "";
    el.className = kind === "err" ? "err" : kind === "ok" ? "ok" : "";
  };

  $("toggle").addEventListener("click", () => $("panel").classList.toggle("open"));
  $("gear").addEventListener("click", () => $("cfg").classList.toggle("open"));

  $("save").addEventListener("click", async () => {
    const url = $("url").value.trim();
    const token = $("token").value.trim();
    const res = await chrome.runtime.sendMessage({ type: "config:set", url, token });
    $("cfgStatus").textContent = res?.ok ? "已保存" : "保存失败";
  });

  $("list").addEventListener("click", async () => {
    setStatus("读取工具清单…");
    $("list").disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: "mcp", method: "tools/list", params: {} });
      if (!res?.ok) throw new Error(res?.error || "unknown");
      const tools = res.data?.tools ?? [];
      const select = $("tool");
      select.innerHTML = "";
      for (const tool of tools) {
        const option = document.createElement("option");
        option.value = tool.name;
        option.textContent = tool.name + (tool.description ? ` — ${String(tool.description).slice(0, 34)}` : "");
        select.appendChild(option);
      }
      setStatus(`共 ${tools.length} 个工具`, "ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "err");
    } finally {
      $("list").disabled = false;
    }
  });

  $("run").addEventListener("click", async () => {
    const name = $("tool").value;
    if (!name) return setStatus("先选一个工具", "err");
    let args = {};
    const raw = $("args").value.trim();
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        return setStatus("参数不是合法 JSON", "err");
      }
    }
    setStatus("执行中…");
    $("run").disabled = true;
    const out = $("out");
    out.style.display = "block";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "mcp",
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (!res?.ok) throw new Error(res?.error || "unknown");
      const result = res.data;
      const text = Array.isArray(result?.content)
        ? result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n")
        : JSON.stringify(result, null, 2);
      out.textContent = result?.isError ? `[工具报错]\n${text}` : text;
      out.className = result?.isError ? "err" : "";
      $("copy").disabled = false;
      setStatus(result?.isError ? "工具返回错误" : "完成", result?.isError ? "err" : "ok");
    } catch (error) {
      out.textContent = error instanceof Error ? error.message : String(error);
      out.className = "err";
      setStatus("失败", "err");
    } finally {
      $("run").disabled = false;
    }
  });

  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("out").textContent || "");
      setStatus("已复制，粘回对话即可", "ok");
    } catch {
      setStatus("复制失败，请手动选中", "err");
    }
  });

  void (async () => {
    const res = await chrome.runtime.sendMessage({ type: "config:get" });
    if (res?.ok) {
      $("url").value = res.data.url || "";
      $("token").value = res.data.token || "";
    }
  })();
})();
