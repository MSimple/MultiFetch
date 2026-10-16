# 原创性声明 / Clean-room statement

本项目的全部代码、文案、图标与设计均为独立原创实现（independent, original work）。

- 未复制任何第三方应用的源代码、注释、界面文案、素材或品牌标识。
- 功能需求来源于"下载管理器"这一类软件的通用能力（多线程分段下载、断点续传、
  浏览器捕获、托盘驻留），这些属业界通行做法，存在大量公开实现可供对照。
- 本项目在安全设计上主动规避了若干常见实现缺陷（本地 API 无鉴权、文件名路径穿越、
  关闭 TLS 校验、渲染层 DOM 注入、openExternal 无 scheme 白名单），相关设计取舍见
  `docs/SECURITY.md`。

All code, copy, icons and design in this project are original, independent work.
No source code, comments, UI strings, assets or branding were copied from any
third-party application. Feature requirements derive from the well-known,
generally-implemented capabilities of download-manager software.
