# downloadmgr

原创的多线程下载管理器（Electron）+ MV3 浏览器捕获扩展。零运行时 npm
依赖、无遥测、无外联、无授权门槛。安全设计刻意规避了同类工具的常见缺陷
（本地 API 无鉴权、文件名路径穿越、关闭 TLS 校验、渲染层 DOM 注入、
openExternal 无 scheme 白名单），详见 `docs/SECURITY.md`。

An original multi-threaded download manager (Electron) with an MV3 browser
capture extension. Zero runtime npm dependencies, no telemetry, no phone-home,
no licensing. See `docs/SECURITY.md` for the security design matrix.

## 功能 / Features

- 多线程 HTTP(S) 分段下载：断点续传（.dmpart sidecar）、任务队列、并发控制、全局限速
- 任务操作：暂停 / 继续 / 取消 / 删除 / 打开文件 / 打开目录
- 系统托盘驻留（关窗隐藏）、开机自启（默认关）、`downloadmgr://` 协议唤起（带令牌门控）
- 浏览器捕获：Chrome/Edge 扩展把下载与链接发送到应用（127.0.0.1 回环 + 配对令牌 + Origin 钉死）
- 中文 / English 界面

## 使用 / Usage

**完整使用手册：[docs/USAGE.md](docs/USAGE.md)**（安装、下载、设置、托盘、扩展配对、协议、FAQ）

```bash
npm start          # 启动应用（需要先安装 electron，见下）

# 首次安装（唯一依赖；github.com 不可达时用镜像）
ELECTRON_MIRROR=https://mirrors.huaweicloud.com/electron/ \
  npm install --save-dev --save-exact electron@44.7.0
node node_modules/electron/install.js   # 若 npm 未自动拉取平台二进制（镜像同上）
```

浏览器扩展：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择
`extension/` 目录 → 在应用「设置 → 浏览器捕获」生成配对码并在扩展选项页输入。
详见 `docs/EXTENSION.md`。

## 打包 / Packaging

```bash
npm run package    # 产出 dist/downloadmgr-win32-x64/
```

免安装目录：`dist\downloadmgr-win32-x64\downloadmgr.exe`，双击即用。打包版首次启动会把
`downloadmgr://` 协议注册指向自身（覆盖开发版注册）。打包工具为 `@electron/packager`
（devDependency，仅构建时需要）。

## 开发 / Development

```bash
npm test        # node:test 全量（59 个测试，无需 Electron）
npm run lint    # DOM 安全 lint（含 JS 语法预检）+ 危险 API lint
npm run verify  # lint + test
```

工具：`tools/fixture-server.js`（回环测试服务器：range/no-range/302/416/429/慢速）、
`tools/cdp-smoke*.js`（对运行中的应用做 GUI 验收）、`tools/gen-icons.js`（原创图标生成）。

## 架构规则 / Architecture

- `app/main/{engine,store,security,capture,util}` 零 `require('electron')`——
  核心层全部可 `node --test` 无头测试；Electron API 只在装配层注入
- 渲染层只经 preload 暴露的 `window.dm` 通信；禁 `innerHTML`（lint 强制）
- 全代码库永不关闭 TLS 校验；无任何 CORS 头（扩展走 host_permissions）
- 细节见 `docs/ARCHITECTURE.md`；原创性声明见 `docs/CLEANROOM.md`
