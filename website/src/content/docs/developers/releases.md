---
title: "发布与服务端签名验证"
description: "Javdex 0.9.0-beta.6 · 发布与服务端签名验证"
---

正式与预发布流水线都需要 GitHub Secret `JAVDEX_SERVER_UPDATE_SIGNING_KEY`（Ed25519 私钥 PEM）和 repository variable `JAVDEX_SERVER_UPDATE_KEY_ID`。上传镜像前执行 `node scripts/server-update-release.mjs validate`，缺少配置、仅提供公钥或使用其他密钥类型都会失败，两类发布执行相同的签名要求。镜像构建只写入派生公钥；私钥不进入镜像、包或源码。发布脚本核对双架构镜像的源码身份和内置公钥；服务端更新附件为两个 `.javdex-update`，整个文件的摘要追加到 `SHA256SUMS.txt`。桌面安装包和对应播放源码包另按发布工作流交付；服务端不再发布分离 JSON/归档或独立宿主机助手包。Compose/JSON 示例使用对应源码提交链接，公钥内置镜像；历史公钥附件只供核对，不自动授予上传包信任。

发布元数据要求 tag 与根版本一致；含预发布后缀的版本始终标记为 prerelease，显式 prerelease 标志也不能被版本号覆盖。在线更新不绕过正式 Release 入口。正式发布执行及其镜像、附件和 CI 结果须按 [发布准备检查](https://github.com/JavdexLabs/Javdex/blob/main/docs/reviews/v0.9.0-readiness.md) 单独核验。

未设置签名密钥的本地构建保留空信任根，拒绝所有更新包。私有部署/隔离测试可显式将受信任 Ed25519 公钥表放在只读配置文件，并设置 `JAVDEX_UPDATE_KEYS_FILE`；不能信任上传包临时携带的任意公钥。密钥生成工具要求仓库外受保护目录：

```bash
node scripts/server-update-release.mjs keygen --directory /绝对路径/受保护的签名目录
```

```bash
npm run server:build            # 业务 + 容器管理入口，不安装桌面原生依赖
npm run server:updater:test     # 合成宿主进程、发行包安全、恢复、续传、TLS
npm run server:test            # 含真实 worker 与待验证业务隔离
npm run test:ui:server-update   # 真实浏览器，两种主题/尺寸
npm run server:updater:smoke    # Linux Docker 真正单容器升级验收
```

宿主合成进程测试不等于 Linux 原生依赖或容器验收。Linux 烟测使用隔离容器/卷，从真实 0.8.0/schema 19 构造托管旧业务，再升级到临时签名的合成预发布目标，验证真实原生依赖、迁移、失败恢复、更新中断、资料库身份/清单保留、单个运行容器、非 root 业务和重启后版本保持。该脚本已配置到 amd64/arm64 PR 与 Release CI，但合成目标不等于正式 0.9.0-beta.6 附件，也不替代管理员首次更换基础镜像路径或实际线上正式 Release 流程的验证。缺少 Linux、Docker 或构建产物必须失败；最终证据按源码提交、架构及实际产物记录，不沿用历史通过数量。

选型历史见 [更新研究](https://github.com/JavdexLabs/Javdex/blob/main/docs/SERVER_UPDATE_RESEARCH.md)、[部署研究](https://github.com/JavdexLabs/Javdex/blob/main/docs/SERVER_UPDATE_DEPLOYMENT_RESEARCH.md)，现行取舍见 [ADR-0031](https://github.com/JavdexLabs/Javdex/blob/main/docs/adr/0031-manage-server-releases-inside-one-container.md)。
