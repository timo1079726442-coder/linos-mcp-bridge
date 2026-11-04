/**
 * 扩展后台：只在本地/隧道 MCP 上发 JSON-RPC。
 * 令牌存在 chrome.storage.local，绝不上传到第三方。
 */
const DEFAULTS = {
  url: "http://127.0.0.1:48766/mcp",
  token: "",
};

async function getConfig() {
  const saved = await chrome.storage.local.get(["url", "token"]);
  return {
    url: saved.url || DEFAULTS.url,
    token: saved.token || DEFAULTS.token,
  };
}

async function rpc(method, params) {
  const { url, token } = await getConfig();
  if (!token) throw new Error("还没填令牌：点面板右上角齿轮，粘贴控制中心生成的令牌。");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  if (body.error) throw new Error(`${body.error.code ?? "error"}：${body.error.message ?? ""}`);
  return body.result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message?.type === "config:get") {
        sendResponse({ ok: true, data: await getConfig() });
        return;
      }
      if (message?.type === "config:set") {
        const url = String(message.url ?? "").trim();
        const token = String(message.token ?? "").trim();
        await chrome.storage.local.set({ url, token });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === "mcp") {
        const result = await rpc(String(message.method), message.params);
        sendResponse({ ok: true, data: result });
        return;
      }
      sendResponse({ ok: false, error: "unknown_message" });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true; // 保持异步通道
});
