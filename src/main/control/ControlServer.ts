/**
 * ControlServer — 主进程内的本机控制端点。
 *
 * 目的：让 V2 runtime（纯 Node 子进程，拿不到 Electron API）
 * 能把"屏幕类"等只能由主进程执行的动作委托回来。
 *
 * 安全设计：
 * - 只监听 127.0.0.1，随机端口；
 * - 每次启动生成一次性随机令牌，写在控制文件里，请求必须带 `x-control-token`；
 * - 不接受任意方法名：只允许注册表里声明过的动作；
 * - 控制文件写在状态目录，权限交给操作系统（同用户可读）。
 *
 * 使用方式：
 *   const server = await startControlServer({ stateRoot, handlers });
 *   // 之后 runtime 读 <stateRoot>/control.json 拿 { url, token }
 *   await server.stop();
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

export type ControlHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface ControlServerOptions {
  stateRoot: string;
  handlers: Record<string, ControlHandler>;
}

export interface ControlServerHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export function controlFilePath(stateRoot: string): string {
  return path.join(stateRoot, "control.json");
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServerHandle> {
  const token = randomBytes(32).toString("base64url");
  const allowed = new Set(Object.keys(opts.handlers));

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
    };

    if (req.method !== "POST" || req.url !== "/call") {
      send(404, { error: "not_found" });
      return;
    }
    if (req.headers["x-control-token"] !== token) {
      send(403, { error: "forbidden" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 256 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(b);
    });
    req.on("end", () => {
      void (async () => {
        let tool = "";
        let params: Record<string, unknown> = {};
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            tool?: unknown;
            params?: unknown;
          };
          tool = typeof body.tool === "string" ? body.tool : "";
          params = (body.params ?? {}) as Record<string, unknown>;
        } catch {
          send(400, { error: "bad_json" });
          return;
        }
        if (!allowed.has(tool)) {
          send(400, { error: "unknown_tool" });
          return;
        }
        try {
          const result = await opts.handlers[tool]!(params);
          send(200, { ok: true, result });
        } catch (e) {
          send(200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/call`;

  try {
    await fs.mkdir(opts.stateRoot, { recursive: true });
    const file = controlFilePath(opts.stateRoot);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ url, token, tools: [...allowed] }, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch {
    /* 写不进去也不影响进程内使用，只是 runtime 调不到 */
  }

  return {
    url,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
