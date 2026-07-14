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

## 4. 发布前准备

1. 确认工作区没有意外改动。
2. 将 `package.json` 更新为目标版本。
3. 将用户可见变化写入 `CHANGELOG.md`，使用目标版本和发布日期作为标题。
4. 执行：

```powershell
npm ci
npm test
npm run build
npm run packaging:list
```

5. 确认 `build/packaging.targets.json` 中需要发布的平台与架构已启用。
6. 检查数据库迁移、设置兼容和插件格式变化是否有升级说明。

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
2. Windows、macOS、Linux 分别构建已启用目标。
3. 汇总各平台构建产物。
4. 创建对应标签的 GitHub Release 并上传产物。

也可以手动运行 Release workflow，但输入的 `release_tag` 必须与 `package.json` 一致。

## 6. Release 内容要求

正式 Release 必须：

- 不是 Draft；
- 不是 Prerelease；
- 标题使用 `Javdex vX.Y.Z`；
- 包含主要变化、修复和必要的升级说明；
- 上传本次 workflow 生成的安装包，不混用旧构建产物。

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

1. 确认 GitHub Release 页面和各平台文件可访问。
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
