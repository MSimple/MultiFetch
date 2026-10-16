# 安全设计对照表 / Security design matrix

设计目标：把下面 6 类常见缺陷在设计层面消除，每一条都有"实现文件 + 自动化测试 + 人工验证"三重确认。

| # | 风险 | 实现（唯一出口） | 自动化测试 | 人工验证 |
|---|------|------------------|------------|----------|
| 1 | 文件名路径穿越 / Windows 保留名 / ADS | `app/main/security/sanitize.js`（全应用唯一清洗器 + 容纳断言） | `test/sanitize.test.js` | M4：在添加对话框输入 `..\..\x` 被拒并显示本地化原因 |
| 2 | 本地捕获 API 无鉴权 / 任意站点可调 | `app/main/capture/*`（127.0.0.1 + Host 校验 + Origin 钉死 + token + 限速 + 无 ACAO；扩展可零交互自动配对，仅限扩展 Origin、可全局关闭、撤销即拉黑、上限 10 个） | `test/capture.test.js`（401/403/413/429/Host 伪造/过期码/单次码/去重/轮换/自动配对/撤销拉黑/上限） | `netstat` 只见 `127.0.0.1:8787`；未配对 Origin 一律 403（tools/cdp-smoke-capture.js 实测）；网页 Origin 带 auto 标志也被拒（单测） |
| 3 | 关闭 TLS 证书校验 | 全库不出现 `rejectUnauthorized:false`（lint 强制）；无关闭开关 | `tools/lint-danger.js` + `test/tls.test.js`（自签证书必须失败） | 全库 grep `rejectUnauthorized` 零命中 |
| 4 | 渲染层 DOM 注入 | 只用 `textContent`/DOM 构造；严格 CSP；sandbox+contextIsolation（lint 强制，含 JS 语法预检） | `tools/lint-dom.js` | DevTools 零 CSP 报错；`window.require === undefined`（tools/cdp-smoke.js 实测） |
| 5 | openExternal 协议走私 | `app/main/security/urlguard.js` 仅放行 `https?:`；`app/main/external.js` 是唯一调用点（lint 强制） | `test/urlguard.test.js` | `tools/lint-danger.js` 全库扫描 openExternal 仅 1 处 |
| 6 | 协议唤起无校验 | `downloadmgr://` 载荷必须携带独立 `protocolToken`；无/错 token 静默忽略 | `test/protocol.test.js`（错 token/缺 token/file: 目标/超长/未知动作） | tools/cdp-smoke-ops.js：坏 token 不动任务列表、file: 目标拒绝（实测） |

其他基线：无遥测、无外联（应用自身不向任何第三方服务器发请求）；渲染层不暴露
`ipcRenderer/require/process`；所有 IPC 载荷经声明式校验（`app/main/ipc/validate.js`，M2）。
