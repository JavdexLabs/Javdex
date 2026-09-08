# 局域网 Web 访问

## 使用方式

1. 在桌面端打开 **设置 → 网络 → 局域网访问**。
2. 设置访问账号与独立的 12–128 字符密码，选择端口（默认 `8096`），开启服务并保存。
3. 让手机、平板、电脑或电视连接同一局域网，在浏览器打开桌面端显示的非 `127.0.0.1` 地址。
4. 输入访问账号和密码。可浏览、搜索、筛选和播放；资料编辑、扫描、刮削及资源管理仍在桌面端完成。

服务默认关闭，跟随 Javdex 桌面进程运行。退出应用即停止；下次启动会恢复已保存的启用配置。系统可能要求允许防火墙访问。如果端口被占用，可更换端口并保存或重试启动。

## 浏览范围与播放

- 提供活动媒体库中未隐藏的影片、包含这些影片的清单、演员与标签筛选、搜索、排序、年份过滤、分页及影片详情。
- 网页不开放编辑、删除、导入、评分修改、任务执行、磁盘路径或桌面 IPC；所有资料、图片和流媒体请求都需要有效会话。
- 已归档媒体库、隐藏成员及其独占资源不在 Web 可见范围。一个影片仍在其他活动媒体库可见时，其共享资料继续可见。
- 本地文件必须属于当前有效、启用的媒体库根目录。未关联根目录的旧资源需先在桌面端整理。
- MP4、WebM 等文件通过浏览器 `<video>` 原生播放，支持分段读取、拖动进度、浏览器原生音量和全屏控制。具体编码是否可用取决于浏览器及设备；容器扩展名不等于解码能力。
- HTTP/HTTPS 直连资源（包括 STRM 指向的直连视频）在认证后交由浏览器访问，不由服务器代理下载。目标必须无需 URL 用户名密码，播放仍取决于来源服务、浏览器和网络可达性。网页、磁力、ed2k 链接不提供播放。
- 不进行转码、HLS 打包、外部字幕转换或应用内播放进度写回。原生播放失败时可重试或换其他资源。

## 认证与网络

采用本地只读账号与服务端会话，参考 [Jellyfin 本地用户](https://jellyfin.org/docs/general/server/users/) 和 [OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)：

- 密码通过随机盐和 scrypt 保存，仅保留哈希；配置保存在应用数据目录的 `web-access.json`，不通过普通设置快照或 Web 接口返回。
- 登录生成随机 256 位令牌，服务端仅存摘要。Cookie 使用 `HttpOnly`、`SameSite=Strict`；不把令牌放进 URL 或 localStorage。
- 会话空闲 24 小时或累计 7 天过期；退出登录、应用重启或保存服务配置会撤销会话。桌面端也可一键退出所有浏览器会话并关闭当前连接。
- 登录有每来源与全局尝试额度，以及并发密码校验限制。
- 仅监听 IPv4，接收局域网/回环来源；Host 必须匹配本机地址或 localhost。拒绝跨站 Origin / Fetch Metadata，登录和退出还要求同源 Origin 与自定义请求头。不信任 `X-Forwarded-*`。
- **当前为局域网 HTTP**，因此 Cookie 不设置 `Secure`，传输内容也不加密。只在可信局域网使用独立密码，不要映射公网端口。此版本不支持反向代理或自定义域名认证入口；公网发布、TLS 与多用户权限属于后续独立范围。

## 开发与验证

独立 React/Vite 浏览器入口在 `src/web`，构建至 `out/web`，随 Electron 包一起发布；不加载桌面 renderer 或 preload。开发桌面应用前会自动构建 Web 页面。需要持续修改 Web 时，另开终端运行 `npm run web:dev`（监听并重建），刷新浏览器即可。

HTTP 模块在 `src/main/web`。`WebCatalog` 是只读目录适配层，输出显式 DTO；文件传输先按资源 ID 验证归属及真实根目录，再对打开的文件描述符复核身份，通过流式 HTTP Range 响应发送。它不接受任意文件路径或代理 URL。

```sh
npm run web:build
npm run typecheck
node scripts/run-electron-tests.mjs src/main/web/webServer.test.ts src/main/web/catalog.test.ts
npm test
npm run build
```

可选的浏览器端到端检查（需要 Chrome 和 PATH 中的 ffmpeg）：

```sh
node --import tsx scripts/web-smoke.mjs
node scripts/web-desktop-smoke.mjs
```

第一个检查启动仅限回环的临时服务，使用合成目录和生成的三秒视频，不读取用户媒体库。在手机、平板、桌面、电视视口验证无横向溢出、网格列数、登录、搜索、详情、原生播放、返回、刷新和退出；截图保存在输出的临时目录。可用 `JAVDEX_WEB_QA_OUTPUT` 指定截图目录。第二个检查使用独立临时数据目录启动真实 Electron，验证设置入口、密码持久化、重启恢复、会话撤销与停止服务。

布局采用 CSS Grid `auto-fill/minmax`、`clamp`、媒体查询、触控目标与 `focus-visible`；电视方向键按空间位置移动焦点，输入框和原生播放器保留自身按键行为。遵循 `prefers-reduced-motion`。屏幕尺寸测试不替代实体电视和各平台解码器测试。

技术依据：[MDN HTTP Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)、[MDN 媒体查询](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Media_queries)。
