# 版本与发布规范

本文规定 Javdex 的应用版本、Git 标签和 GitHub Release 发布流程。目标是让应用内版本提醒、安装包文件名和发布记录始终指向同一个版本。

## 1. 版本格式

Javdex 使用 [Semantic Versioning 2.0.0](https://semver.org/)：

```text
MAJOR.MINOR.PATCH
```

- `MAJOR`：存在不兼容的数据、插件或用户操作变更。
- `MINOR`：向后兼容的新功能。
- `PATCH`：向后兼容的问题修复。

正式版本只使用三个非负整数，例如 `0.4.0`。Git 标签必须增加 `v` 前缀，例如 `v0.4.0`。

预发布使用 SemVer 后缀，例如首个 0.8.0 Beta 可用 `0.8.0-beta.1`，对应标签 `v0.8.0-beta.1`；后续递增编号，不覆盖已有标签。发布时必须标记为 Prerelease，不能仅在标题写 Beta。预发布编号在实际发布时统一写入版本与锁文件，文档预告不代表已经发布。

服务端与桌面必须由同一源码版本构建。Release 工作流先完成四个原生桌面目标的源码构建、打包验证和播放源码汇总，再分别在 Linux amd64 / arm64 原生 runner 构建服务端并运行容器烟测，将经过检查的镜像上传 GHCR，合成 `ghcr.io/javdexlabs/javdex-server:<版本>`。两个架构成功后生成签名单文件升级包并发布 GitHub Release，交付第 6 节规定的 10 个附件。Beta 后缀自动标记 Prerelease，不更新 `latest` 或其他滚动镜像标签。

首次发布后，维护者必须在 GitHub Packages 将 `javdex-server` 的可见性设为 **Public**，并在未登录 GHCR 的环境测试拉取。GHCR 新包默认私有，仓库公开不等于镜像公开，见 [GitHub Container registry 说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。工作流用 `GITHUB_TOKEN` 的 `packages: write` 发布，无需配置 Docker Hub 密码。镜像尚未公开时不要宣称普通用户已可直接拉取。

在 `1.0.0` 之前，可能破坏现有行为的变化通常提升 `MINOR`；稳定后的破坏性变化提升 `MAJOR`。

## 2. 单一版本来源

`package.json` 的 `version` 是构建时的单一版本来源。每次发布必须保证：

```text
package.json version = 0.4.0
Git tag             = v0.4.0
GitHub Release      = v0.4.0
安装包文件名中的版本 = 0.4.0
```

禁止手动修改打包产物中的版本号，也禁止给同一个 Git 标签重新上传不同代码生成的正式产物。

## 3. 版本提醒兼容范围

应用内版本提醒读取公开接口：

```text
GET https://api.github.com/repos/JavdexLabs/Javdex/releases/latest
```

客户端只接受：

- 非 Draft Release；
- 非 Prerelease Release；
- `vMAJOR.MINOR.PATCH` 或 `MAJOR.MINOR.PATCH` 标签；
- 属于 `JavdexLabs/Javdex` 的 HTTPS Release 页面。

因此，预发布版本不会触发稳定版客户端提醒。改变标签格式前必须同步修改并测试 `appReleaseService.ts`。

当前运行的桌面可以是 Beta：比较版本时，同系列正式版优先于 Beta，较旧正式版不会提示降级；候选 Release 和缓存仍只接受正式标签。这不增加 Beta 更新通道。

## 4. 发布前准备

1. 确认工作区没有意外改动。
2. 将根与全部 workspace 的 `package.json` 更新为目标版本，同时更新内部 `@javdex/*` 依赖的精确版本以及 `package-lock.json` 中的对应条目。运行 `npm run check:workspaces` 检查版本和内部依赖锁定，随后以 `npm ci` 验证干净安装；不能只修改各包自身的 `version`。
3. 将用户可见变化写入 `CHANGELOG.md`，使用目标版本和发布日期作为标题。
4. 新建 `.github/release-notes/vX.Y.Z.md`，供 Release workflow 读取。沿用上一版本的正文风格，以用户可见功能、体验改进和升级影响为主；同步受影响的使用指南，新增产品能力可补充到 README。
5. 执行：

```powershell
npm ci
npm run setup:desktop
npm test
npm run build
npm run packaging:list
```

6. 确认 `build/packaging.targets.json` 中 Windows x64、macOS x64、macOS arm64、Linux x64 四个目标已启用，产出第 6 节规定的六个桌面包。各原生 runner 从固定源码构建播放运行库，打包后运行 `packaging:verify-playback-runtime`、`packaging:verify-agent-runtime`，macOS 另核对应用签名。四份平台源码包及对应 `.runtime.json` 留作 CI 汇总输入；总源码包校验成功后才允许发布服务端镜像。`verify_only` 也执行桌面验证与源码汇总，但不发布镜像或 Release。
7. 检查数据库迁移、设置兼容和插件格式变化是否有升级说明。
8. 核对发布正文提供与本次源码提交对应的 Compose 示例、JSON 配置和部署说明链接；不将示例或公钥作为附件。Beta 和正式版都需通过 Ed25519 签名配置检查，私钥和 key ID 缺失时不得上传镜像；镜像内置公钥必须与生成升级包的签名配置一致。

0.9.0 Beta 的发布准备清单见 [Beta 发布检查](reviews/v0.9.0-beta.1-readiness.md)，用户说明见 [发布说明](../.github/release-notes/v0.9.0-beta.1.md)。准备完成不等于已经打标签、推送或发布；实际发布前将 Changelog 的“发布准备”改为真实发布日期，并同步文档中的待发布状态。

发布提交建议使用：

```text
release: v0.4.0
```

## 5. 正式发布流程

推荐通过 Git 标签触发 `.github/workflows/release.yml`：

```powershell
git tag -a v0.4.0 -m "Javdex v0.4.0"
git push origin v0.4.0
```

工作流依次执行：

1. Windows 环境运行类型检查和完整测试。
2. Windows x64、macOS x64、macOS arm64、Linux x64 四个原生 runner 从固定源码构建播放运行库，生成六个桌面包；完成包内播放运行库与 Agent 运行时验证，macOS 另核对应用签名。
3. 汇总四份平台播放源码包及其分发投影，核对来源、构建材料、运行库与安装包绑定，按 SHA-256 去重并逐文件往返验证，生成一个 `Javdex-Playback-Sources-<版本>.tar.gz`。四份平台源码包保留为 CI 产物。
4. 仅在桌面打包和总源码包校验成功后，Linux amd64 / arm64 原生 runner 分别验证签名配置、构建服务端、运行容器烟测并上传 GHCR，合成固定版本的多架构镜像。
5. 从已验证镜像取得各架构的完整程序闭包，封装签名清单和程序归档为两个 `.javdex-update`，读回验证内层字节；生成覆盖六个桌面包、总源码包和两个升级文件的 `SHA256SUMS.txt`。
6. 创建 GitHub Release，上传第 6 节规定的 10 个附件；正文提供与本次源码提交对应的 Compose 示例、JSON 配置和部署说明链接。

正式版进入 GitHub 最新正式 Release，供应用更新提醒与官网读取；服务镜像仍使用固定版本标签，当前工作流不创建 `latest` 滚动镜像标签。发布后核验默认分支包含发布代码，并检查 Pages 工作流生成的下载信息。

也可以手动运行 Release workflow，但输入的 `release_tag` 必须与 `package.json` 一致。

## 6. Release 内容要求

正式 Release 必须：

- 不是 Draft；
- 不是 Prerelease；
- 标题使用 `Javdex vX.Y.Z`；
- 包含主要变化、修复和必要的升级说明；
- 上传本次 workflow 生成的安装包，不混用旧构建产物。

从 0.9.0-beta.3 起，Beta 和正式 Release 均交付以下 10 个附件：

- 六个桌面包：Windows x64 EXE／ZIP、macOS x64／arm64 DMG、Linux x64 AppImage／DEB。
- 一个总播放源码包：`Javdex-Playback-Sources-<版本>.tar.gz`，包含四个平台的来源、构建材料、对应清单和恢复工具；四份单平台源码包及 `.runtime.json` 仅保留为 CI 产物。
- 两个签名完整升级文件：`Javdex-server-<版本>-linux-amd64.javdex-update` 与 `Javdex-server-<版本>-linux-arm64.javdex-update`。
- 一个 `SHA256SUMS.txt`，覆盖上述九个下载文件的完整字节。

Compose 示例、JSON 配置示例与部署说明使用本次源码提交的版本对应链接，不再作为附件；可信升级公钥内置镜像，不发布公钥附件或分离的签名 JSON／程序 `.tar.gz`。历史已公开 Release 的附件保持原样。

推荐正文结构：

```markdown
## 主要变化

- 新增……
- 改进……

## 修复

- 修复……

## 升级说明

直接安装新版本即可；媒体库数据库和本地资源不会被删除。
```

## 7. 发布后验证

以下应用内更新提醒步骤针对正式版本。Beta 应核验 Release 标记为 Prerelease、稳定版更新接口未切换到 Beta、版本镜像可拉取且 `latest` 未被 Beta 覆盖；不得要求稳定客户端提示预发布。

1. 确认 GitHub Release 页面及 10 个附件可访问，`SHA256SUMS.txt` 验证其余九个文件；部署链接指向本次源码提交。核对四个原生桌面目标的包内运行库验证、macOS 签名、总源码包往返校验和两种服务端架构的容器烟测均通过，升级文件中的签名与内层归档摘要一致。构建或合成测试通过不能代替这些 CI 门禁，也不代表 GUI、硬解或干净机器安装验收。
2. 在上一正式版中打开“设置 → 关于”。
3. 点击“检查更新”，确认显示目标版本、Release 标题和说明摘要。
4. 点击“前往下载”，确认打开正确的 Release 页面。
5. 在当前版本检查更新，确认显示“当前已是最新版本”。
6. 检查 `CHANGELOG.md`、Git 标签和 Release 版本一致。

## 8. 修复与撤回

已公开的版本不得覆盖或复用标签。若 `0.4.0` 存在问题，应发布更高的 `0.4.1`。

严重问题可以暂时删除对应 Release，避免新客户端继续收到提醒；修复后仍必须使用新版本号和新标签发布。数据库迁移已经在用户设备执行时，不能仅靠删除 Release 回滚，应提供向前修复迁移。

## 9. 预发布版本

需要测试版本时使用完整 SemVer 预发布标识，例如：

```text
0.5.0-beta.1
v0.5.0-beta.1
```

GitHub Release 必须标记为 Prerelease。当前稳定客户端不会检测或提示预发布版本；如未来新增更新通道，需要另行定义通道选择、版本比较和降级规则。

从 0.9.0-beta.3 起，Beta 和正式 Release 均使用第 6 节的 10 个附件及单文件服务端升级格式。每个 `.javdex-update` 内含签名 JSON 和完整程序 `.tar.gz`，只选择一个文件；签名中的大小与 SHA-256 绑定内层程序归档，Release 校验和绑定整个运输文件。在线检查读取有界文件前缀，准备时重新验证内嵌签名与所选目标一致；离线上传与续传按内层归档偏移计数。签名信任根、期限、版本、架构、schema、运行环境、解压闭包及原生依赖校验保持有效，运输格式见 [服务端更新](SERVER_UPDATE.md)。

新读取器只接受单文件格式，不兼容历史 Beta 的 JSON＋归档入口。采用此格式需要新版桌面客户端和容器管理入口；旧管理器由管理员正常替换为新版基础镜像，保留 `/program` 及业务资料，业务升级包不能自更新镜像内的管理器。Beta.1／Beta.2 的已公开标签、镜像和附件不覆盖。

两类发布都必须先通过签名配置检查，缺少 Ed25519 私钥或 key ID 时不得上传镜像；可信公钥内置镜像，不从上传包或下载附件建立信任。服务端 Beta 包只由用户在对应 Release 手动下载并离线上传；服务端与桌面的默认在线检查继续只读取正式 Release，稳定版下载入口保持当前正式版，不增加自动 Beta 通道。显式安装遵循 SemVer 升级方向，不能从正式版降回同系列 Beta。

## 10. 桌面、服务与网页同版本

同一 Git 提交的根与 workspace `package.json` version 同时约束：

- 桌面安装包
- `npm run server:build` 写入的 `out/server` 生产闭包
- 网页包（桌面附带与服务闭包内的 `web/`）

发布时三者必须来自同一源码版本。握手发现应用版本不一致时，桌面进入版本不符状态，不得写入远程资料库，也不得自动改连其他地址。Linux 服务镜像由同一提交的根目录 `Dockerfile` 构建，复制 `out/server` 业务闭包与 `out/updater` 管理入口；管理器不进入桌面安装包。禁止把不同提交的桌面包与服务闭包搭配使用。
