# 架构 / Architecture

## 进程与层次

```
main process (Electron)
├─ 装配层  app/main/{main,windows,preload,tray,protocol,autolaunch,external}.js
│          —— 唯一允许 require('electron') 的层（lint-danger 强制）
└─ 核心层（零 Electron 依赖，node --test 全覆盖）
   ├─ security/  sanitize（唯一文件名清洗+容纳断言）· urlguard（https? 白名单）· tokens
   ├─ store/     taskstore（合并通知≤4Hz+防抖持久化）· settings（白名单patch）·
   │             secrets（双令牌）· atomic（tmp+fsync+rename+.bak）· paths
   ├─ engine/    probe → plan → segment（分段并发/续传/重试/429）→ writer → engine（调度）
   ├─ capture/   routes（鉴权/配对/限流）· server（127.0.0.1+Host 校验+64KiB 上限）
   └─ util/      log（脱敏轮转）· bytes
renderer (sandbox + contextIsolation + strict CSP)
└─ 仅经 preload 暴露的 window.dm ⇄ 主进程；声明式 IPC 校验（ipc/validate）
extension (MV3)
└─ sw（无状态）· lib/{detect,client,queue,storage} · popup · options
```

## 关键契约

- **IPC**：`ipc/register.js` 是唯一通道表；`preload.js` 的通道名与表双向一致（契约测试强制）；
  所有载荷经 `validate()` 类型/范围/枚举/CRLF 校验，未知字段一律拒绝。
- **任务存储**：`userData/tasks.json`（原子写 + `.bak` 恢复）；变更通知在主进程合并为
  ≤4 Hz 的批次事件。
- **断点续传**：`<file>.dmpart`（数据）+ `<file>.dmpart.json`（段进度 + 校验器）；
  仅在 fresh probe 与 sidecar 一致（大小/ETag/Last-Modified）时续传，否则整段重下。
- **捕获 API**：仅 127.0.0.1；`Host` 必须精确为 `127.0.0.1:<port>`；Origin 允许"无"
  （本机进程）或配对钉死的 `chrome-extension://<id>`；`X-DM-Token` 恒定时间比较；
  每令牌 30 次/10s + 全局 200 次/分；**永不发送任何 CORS 头**。
- **协议**：`downloadmgr://add?url=<enc>&token=<protocolToken>`；token 错误静默忽略，
  `file:` 等非 http(s) 目标拒绝。

## 安全不变量（由 tools/lint 双脚本 + 测试强制）

1. 文件名只能经 `sanitize.js` 落到磁盘，且最终路径必须容纳断言通过
2. 全库无 `rejectUnauthorized` / `NODE_TLS_REJECT_UNAUTHORIZED`；TLS 校验恒开
3. 渲染层无 `innerHTML/insertAdjacentHTML/document.write/eval/new Function`
4. `shell.openExternal` 仅存在于 `app/main/external.js`（且只放行 https?）
5. app/ 内无任何 `Access-Control-Allow-Origin`
6. 核心层零 `require('electron')`

## 数据流（一次下载）

添加（UI/扩展/协议）→ validate → TaskStore.add → Engine.kick → probe（尺寸/range/校验器）
→ 文件名候选链 → sanitize + 容纳断言 + 唯一化 → 预分配 .dmpart → 分段并发
（连接信号量 × 全局令牌桶限速）→ 每段重试/429 退避 → 完整性校验（尺寸）→ fsync →
rename 成品 → 删 sidecar → done（状态经 4Hz 合并推给界面与托盘）。
