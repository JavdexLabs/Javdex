# 版本与发布规范

本文规定 Javdex 的应用版本、Git 标签和 GitHub Release 发布流程。目标是让应用内版本提醒、安装包文件名和发布记录始终指向同一个版本。

默认规则禁止覆盖公开版本。维护者于 2026-10-18 明确授权的原始 0.9.0 整套替换是单次例外，范围与恢复措施见第 11 节，不适用于其他版本或后续重复覆盖。

## 1. 版本格式

Javdex 使用 [Semantic Versioning 2.0.0](https://semver.org/)：

```text
MAJOR.MINOR.PATCH
```

- `MAJOR`：存在不兼容的数据、插件或用户操作变更。
- `MINOR`：向后兼容的新功能。
- `PATCH`：向后兼容的问题修复。

正式版本只使用三个非负整数，例如 `0.9.0`。Git 标签必须增加 `v` 前缀，例如 `v0.9.0`。

带 SemVer 后缀的版本必须标记为 Prerelease，不进入正式版更新入口。正式版升级使用独立的无后缀版本与标签，不覆盖既有标签、镜像或附件；文档准备不代表已经发布。

服务端与桌面必须由同一源码版本构建。Release 工作流先完成四个原生桌面目标的源码构建、打包验证和播放源码汇总，再分别在 Linux amd64 / arm64 原生 runner 构建服务端并运行容器烟测，将经过检查的镜像上传 GHCR，合成 `ghcr.io/javdexlabs/javdex-server:<版本>`。两个架构成功后生成签名单文件升级包并发布 GitHub Release，交付第 6 节规定的 10 个附件。镜像只使用固定版本标签，不创建 `latest` 或其他滚动标签。

首次发布后，维护者必须在 GitHub Packages 将 `javdex-server` 的可见性设为 **Public**，并在未登录 GHCR 的环境测试拉取。GHCR 新包默认私有，仓库公开不等于镜像公开，见 [GitHub Container registry 说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。工作流用 `GITHUB_TOKEN` 的 `packages: write` 发布，无需配置 Docker Hub 密码。镜像尚未公开时不要宣称普通用户已可直接拉取。

在 `1.0.0` 之前，可能破坏现有行为的变化通常提升 `MINOR`；稳定后的破坏性变化提升 `MAJOR`。

## 2. 单一版本来源

`package.json` 的 `version` 是构建时的单一版本来源。每次发布必须保证：

```text
package.json version = 0.9.0
Git tag             = v0.9.0
GitHub Release      = v0.9.0
安装包文件名中的版本 = 0.9.0
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

版本比较遵循 SemVer：同系列正式版优先于带后缀版本，较旧正式版不会提示降级；候选 Release 和缓存仍只接受正式标签，不增加额外更新通道。

## 4. 发布前准备

1. 确认工作区没有意外改动。
2. 将根与全部 workspace 的 `package.json` 更新为目标版本，同时更新内部 `@javdex/*` 依赖的精确版本以及 `package-lock.json` 中的对应条目。运行 `npm run check:workspaces` 检查版本和内部依赖锁定，随后以 `npm ci` 验证干净安装；不能只修改各包自身的 `version`。
3. 将用户可见变化写入 `CHANGELOG.md`。准备阶段标注“发布准备”，实际发布时再填写真实发布日期，不能用准备日期冒充发布日期。
4. 新建 `.github/release-notes/vX.Y.Z.md`，供 Release workflow 读取。沿用上一版本的正文风格，以用户可见功能、体验改进和升级影响为主；同步受影响的使用指南，新增产品能力可补充到 README。
5. 执行：

```powershell
npm ci
npm run setup:desktop
npm test
npm run build
npm run packaging:list
```

6. 确认 `build/packaging.targets.json` 中 Windows x64、macOS x64、macOS arm64、Linux x64 四个目标已启用，产出第 6 节规定的六个桌面包。各原生 runner 从固定源码构建播放运行库；Linux 在 Ubuntu 22.04 分别构建 GPU／CPU helper 及匹配 Electron 的 ANGLE，保留三套对应源码材料。打包后运行 `packaging:verify-playback-runtime`、`packaging:verify-agent-runtime`，macOS 另核对应用签名。四份平台源码包及对应 `.runtime.json` 留作 CI 汇总输入；Linux 的同一投影同时绑定两套运行库与 ANGLE。总源码包校验成功后才允许发布服务端镜像。`verify_only` 也执行桌面验证与源码汇总，但不发布镜像或 Release。
7. 检查数据库迁移、设置兼容和插件格式变化是否有升级说明。
8. 核对发布正文提供与本次源码提交对应的 Compose 示例、JSON 配置和部署说明链接；不将示例或公钥作为附件。所有发布都需通过 Ed25519 签名配置检查，私钥和 key ID 缺失时不得上传镜像；镜像内置公钥必须与生成升级包的签名配置一致。

当前已发布正式版为 `0.9.1` / `v0.9.1`，相对正式 0.9.0 不新增资料格式迁移；从 0.8.0 升级仍遵守 0.9.0 的基础镜像与资料迁移要求，不为预发布版本新增兼容路径。本轮源码和完整 CI 见 [0.9.1 发布审计](reviews/v0.9.1-release-audit.md)，用户说明见 [0.9.1 发布说明](../.github/release-notes/v0.9.1.md)。后续候选须选择新版本并重新执行正常门禁，不能按旧准备稿再次发布或覆盖既有正式版；历史标签、镜像与附件保持不变。原始 0.9.0 的一次整套替换单独保留在第 11 节及[发布记录](reviews/README.md)。

发布提交建议使用：

```text
release: v0.9.0
```

## 5. 正式发布流程

审核并提交目标源码后，可手动运行 `.github/workflows/release.yml`，正式版输入为 `release_tag=v0.9.0`、`prerelease=false`、`verify_only=false`；先核对触发分支与 headSha。只验证桌面包和源码材料时使用 `verify_only=true`，不会发布镜像或 Release。

也支持通过匹配的 Git 标签触发：

```powershell
git tag -a v0.9.0 -m "Javdex v0.9.0"
git push origin v0.9.0
```

工作流依次执行：

发布入口先只读检查同名 Release、Git 标签指向和固定镜像标签。已存在的 Release 或固定镜像一律拒绝复用；由标签触发时，标签必须指向本次源码。不同分支的发布工作流统一串行，写入固定镜像与上传 Release 前再次检查，失败作业重跑也不能覆盖已公开版本。查询失败不能当作“版本不存在”；`verify_only` 不调用发布预检，也不进入发布作业。

1. Windows 环境运行类型检查、完整测试和真实浏览器交互回归。
2. Windows x64、macOS x64、macOS arm64、Linux x64 四个原生 runner 从固定源码构建播放运行库，生成六个桌面包；完成包内加载与 PCM 解码 EOF、Agent 运行时验证及 macOS 签名。对最终 EXE 静默安装、ZIP/DEB/AppImage 提取、DMG 只读挂载后检查嵌入运行库，生成最终文件摘要与源码绑定回执。
3. 汇总四份平台播放源码包、分发投影和安装包回执，核对来源、构建材料、原生快照/SDK、运行库与实际安装包绑定，按 SHA-256 去重并逐文件往返验证，生成一个 `Javdex-Playback-Sources-<版本>.tar.gz`。四份平台源码包保留为 CI 产物。
4. 仅在桌面打包和总源码包校验成功后，Linux amd64 / arm64 原生 runner 分别验证签名配置、构建服务端、运行容器烟测并上传 GHCR，合成固定版本的多架构镜像。
5. 从已验证镜像取得各架构的完整程序闭包，封装签名清单和程序归档为两个 `.javdex-update`，读回验证内层字节；生成覆盖六个桌面包、总源码包和两个升级文件的 `SHA256SUMS.txt`。
6. 创建 GitHub Release，上传第 6 节规定的 10 个附件；正文提供与本次源码提交对应的 Compose 示例、JSON 配置和部署说明链接。

Linux 的包内与最终安装器门禁验证两个独立 ELF 闭包、ANGLE、启动器和 AppImage 运行时前缀，并在实际包内 Electron 加载 FD addon、分别解码 GPU／CPU libmpv 的 PCM 至 EOF。总源码汇总另检查两份 helper 材料的固定依赖、Ubuntu `.dsc` 与源码摘要、原生源码及 SDK，以及 ANGLE 源码和补丁。它们不能替代真机画面、硬解、音画同步或长播验收，详细合同见 [Linux 播放](LINUX_COMPATIBLE_PLAYBACK.md#validation-and-release-boundary)。

正式版进入 GitHub 最新正式 Release，供应用更新提醒与官网读取；服务镜像仍使用固定版本标签，当前工作流不创建 `latest` 滚动镜像标签。发布后核验默认分支包含发布代码，并检查 Pages 工作流生成的下载信息。

也可以手动运行 Release workflow，但输入的 `release_tag` 必须与 `package.json` 一致；发布构建开始前须由维护者建立指向同一已检查源码的标签，缺失时预检立即失败，避免先写固定镜像后才发现不能上传。正常发布优先推送一次标签触发，不再为同一源码并行手动调度。上传入口再次读取并剥离标签、核对源码后才创建 Release，不再显式发送可能要求 workflow 编辑权限的 `target_commitish`，也不由上传动作隐式创建标签。

### 未发布候选的服务端接续

同一源码的临时失败优先使用 GitHub 的“重跑失败作业”，已成功作业和产物无需重建。若四个平台、总源码汇总及 ARM64 服务端均成功，只有 AMD64 的 `server:test` 因测试夹具环境问题失败，可用 `resume_server_run_id=<原 run ID>` 接续原候选；不能同时选择 `verify_only` 或同版本替换。

接续入口检查原仓库、源码祖先、成功作业、唯一失败步骤、未过期的不可变 artifact ID 和摘要；仅允许已列明的测试夹具／发布编排修复，任何产品源码变化都要求新候选重建。六个桌面包和总源码包复用原字节；AMD64 仍从原提交构建，修正的测试夹具仅用于验证，容器测试前恢复原源码。ARM64 镜像核对原提交与版本并固定摘要；最终签名封装仍逐架构检查完整程序闭包，不能放宽源码身份。

发布标签、镜像 build 标识及部署链接始终指向原候选提交，接续工作流的修复提交单独记入 provenance。桌面包摘要再次与总源码包的四份 manifest 对照。接续的镜像合成、签名封装与 Release 上传分为独立作业，后段临时失败可单独重跑；已公开版本仍禁止覆盖。不能把原 run 的失败标为成功，应同时保留原门禁与接续 CI 证据。

若接续作业的 AMD64 构建、服务端／升级／权限／容器检查全部成功，已上传镜像但摘要固定步骤失败，可另填 `resume_amd64_run_id=<该接续 run ID>`。入口逐项要求这些步骤成功且仅摘要固定失败，再从 registry 取得不可变摘要、读取镜像内原源码与版本；镜像不存在、身份不符或任一门禁缺失均拒绝继续，不重新构建已经通过的产品。

若固定镜像已合成、完整签名封装及源码闭包校验已通过，仅创建 Release 失败，可填 `resume_publish_run_id=<该接续 run ID>`，跳过所有产品构建和镜像写入，只接续封装与上传。入口要求原接续的镜像合成成功且唯一失败步骤为 Release 创建，仍拒绝已存在的公开 Release。

接续发布须先由维护者建立指向原源码的标签；入口和上传前均核对剥离后的提交。GitHub 的 [Release 权限规则](https://docs.github.com/en/rest/releases/releases#create-a-release)会检查显式 `target_commitish` 相对默认分支的工作流变化，普通工作流令牌即使有 `contents: write` 也可能返回 403。因此接续上传使用已核验的标签，不再传入这个对既有标签无效的参数，也不扩大令牌权限。Release API 可能将默认分支记为 `target_commitish`；实际源码身份以已核对的 Git 标签为准。

## 6. Release 内容要求

正式 Release 必须：

- 不是 Draft；
- 不是 Prerelease；
- 标题使用 `Javdex vX.Y.Z`；
- 包含主要变化、修复和必要的升级说明；
- 上传本次 workflow 生成的安装包，不混用旧构建产物。

0.9.0 及后续 Release 交付以下 10 个自定义附件（不计 GitHub 自动生成的 Source code 条目）：

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

正式发布后，GitHub releases/latest、应用更新提醒和官网应指向新正式版；服务镜像仍为固定版本，不新增滚动标签。核对发布标签与源码提交一致，不能混用旧附件或以历史 CI 代替本轮结果。

1. 确认 GitHub Release 页面及 10 个附件可访问，`SHA256SUMS.txt` 验证其余九个文件；部署链接指向本次源码提交。核对四个原生桌面目标的包内运行库验证、macOS 签名、总源码包往返校验和两种服务端架构的容器烟测均通过，升级文件中的签名与内层归档摘要一致。构建或合成测试通过不能代替这些 CI 门禁，也不代表 GUI、硬解或干净机器安装验收。
2. 在上一正式版中打开“设置 → 关于”。
3. 点击“检查更新”，确认显示目标版本、Release 标题和说明摘要。
4. 点击“前往下载”，确认打开正确的 Release 页面。
5. 在当前版本检查更新，确认显示“当前已是最新版本”。
6. 检查 `CHANGELOG.md`、Git 标签和 Release 版本一致。

## 8. 修复与撤回

已公开的版本不得覆盖或复用标签。若 `0.9.0` 存在问题，应发布更高的 `0.9.1`。

严重问题可以暂时删除对应 Release，避免新客户端继续收到提醒；修复后仍必须使用新版本号和新标签发布。数据库迁移已经在用户设备执行时，不能仅靠删除 Release 回滚，应提供向前修复迁移。

## 9. 服务端升级文件与管理器边界

每个 `.javdex-update` 内含签名 JSON 和完整程序 `.tar.gz`，用户只选择一个文件；签名中的大小与 SHA-256 绑定内层程序归档，Release 校验和绑定整个运输文件。在线检查读取有界文件前缀，准备时重新验证内嵌签名与所选目标一致；离线上传与续传按内层归档偏移计数。签名信任根、期限、版本、架构、schema、运行环境、解压闭包及原生依赖校验保持有效，运输格式见 [服务端更新](SERVER_UPDATE.md)。

读取器只接受单文件格式，不提供分离 JSON＋归档入口。0.8.0 首次采用托管更新须替换基础镜像并增加 `/program`，保留业务资料。业务升级包不能自更新镜像内管理器；后续运行环境变化也由管理员替换基础镜像维护，并保留程序卷。镜像内业务版本更高时自动停服、升级和验证，同版或更旧时保留当前业务，不自动降级；升级不创建资料快照，安装开始后失败或中断进入维护状态并要求人工恢复，提交后只继续激活。

所有发布先验证签名配置；缺少 Ed25519 私钥或 key ID 时不得上传镜像，可信公钥内置镜像，不从升级文件或下载附件建立信任。桌面软件更新提醒只读取正式 Release；服务端升级恢复入口固定读取当前客户端版本的 Release tag（含预发布），在线、离线、准备和安装均须匹配同一目标。仍须遵循 SemVer 升级方向，不允许同版本重装或降级。签名仅由 CI 使用既有 Secret，代理不得读取、输出或轮换私钥。

## 10. 桌面、服务与网页同版本

同一 Git 提交的根与 workspace `package.json` version 同时约束：

- 桌面安装包
- `npm run server:build` 写入的 `out/server` 生产闭包
- 网页包（桌面附带与服务闭包内的 `web/`）

发布时三者必须来自同一源码版本。握手发现应用版本不一致时，桌面进入版本不符状态，不得写入远程资料库，也不得自动改连其他地址。Linux 服务镜像由同一提交的根目录 `Dockerfile` 构建，复制 `out/server` 业务闭包与 `out/updater` 管理入口；管理器不进入桌面安装包。禁止把不同提交的桌面包与服务闭包搭配使用。

## 11. 原始 0.9.0 的一次性整套替换

维护者明确授权的原始 0.9.0 整套替换已于 2026-10-18 完成，交付 Windows Whisper Vulkan 按需下载。此授权只针对原 Release `416016386`、原标签提交 `bb843322112d536380ec7587c8569cc80680e733` 及 [固定原始发布身份](../build/replacement-0.9.0.json)，已经使用完毕。受控入口不得再次 dispatch；不能把这项授权用于 0.8.0、历史 Beta 或第二次 0.9.0 替换，正常发布仍禁止覆盖。

该轮保留了正常 Windows 完整测试、四目标打包、源码汇总、双架构容器及签名门禁。十个新附件、升级包与镜像来自同一固定源码；原 Release 转为归档 Draft，原附件、标签归档引用及镜像索引均保留。实际 CI、受控切换、恢复保护和新旧发行身份见[迁移审计](reviews/whisper-vulkan-runtime-migration.md)及[元数据回执](reviews/whisper-vulkan-runtime-release-evidence.json)，不再将历史切换步骤作为当前待办，也不删除原备份或改动保护规则。

同版本替换不会使已安装的 0.9.0 弹出更新提醒。桌面用户需要手动重新下载安装；有效旧运行库与模型权重继续保留。服务端仍禁止同版本业务包重装，镜像同版也不会自动替换已有程序卷；本任务不放宽这些保护，不承诺已有服务端会自动取得同版本新代码。独立公开软件产物验收按维护者要求不执行，不能记录为通过；正常 CI 与只读发布元数据、网站检查仍保留。
