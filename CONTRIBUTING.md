# 参与贡献

感谢你愿意改进 LinOS MCP Bridge。

## 开发环境

- Windows 10/11（主要目标平台）
- Node.js ≥ 20
- 建议 `npm ci` 而不是 `npm install`，保持依赖锁一致

```powershell
npm ci
npm run build:runtime
npm run build
npm start            # 启动桌面控制中心
```

## 提交前自检

```powershell
npm run typecheck
npm test
cd runtime; npm test
```

请确保：

- 新增/修改的工具都走工作区边界校验（`security-boundary`）；
- 涉及写入的功能保持“两阶段”（prepare → commit），不要新增直接落盘路径；
- 涉及命令执行的功能必须更新白名单与测试；
- 安全相关改动请在 PR 描述里写清威胁模型变化。

## 代码风格

- TypeScript，严格模式；不要用 `any` 绕过类型（确有需要请注释原因）；
- 用户可见文案用中文，标识符用英文；
- 不提交构建产物、日志、密钥、本机绝对路径。

## 提交信息

采用 Conventional Commits：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`。

## 安全问题

见 [SECURITY.md](SECURITY.md)，不要用公开 Issue 报漏洞。
