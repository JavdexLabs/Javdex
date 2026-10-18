---
title: 版本升级与 Schema 兼容性
description: Javdex 0.8.0 至 0.9.0 升级注意事项、SQLite Schema 21 自动迁移、Docker /program 程序卷配置与安全回滚策略。
---

Javdex 在迭代过程中严格实施数据库版本门禁与客户端/服务端同版本约束。从 `0.8.0` 升级至 `0.9.0` 引入了多可信设备授权、容器内托管更新网关（`/opt/javdex-manager` + `/program`）及本地 AI 模型管理 Schema v4。

在执行升级前，请仔细阅读本页的兼容性边界与操作步骤。

---

## 核心兼容性铁律

1. **数据库 Schema 19 → 21 单向自动迁移（不可逆）**：
   - `0.9.0` 核心资料库的 SQLite 结构版本为 **`CURRENT_SCHEMA_VERSION = 21`**（`packages/library/src/db/migrations.ts`）。
   - 首次使用 `0.9.0` 打开 `0.8.0`（schema 19）的数据库时，系统会自动将数据库从 schema 19 逐步升级到 21（其中 Migration 20 重构了演员待办冲突表，Migration 21 新增了 `catalog_writer_credentials` 多可信设备凭证表）。
   - :::danger[严禁用旧版打开已升级的数据库]
     数据库迁移是**单向不可逆**的。一旦数据库被 `0.9.0` 升级到 Schema 21，旧版 `0.8.0` 程序将无法识别并拒绝打开该数据库。如需回退版本，必须恢复升级前创建的完整备份。
     :::
2. **模型管理配置 Schema 3 → 4 自动迁移**：
   - 桌面端的 AI 模型配置文件（`ai-configuration.json`）在 `0.9.0` 中为 **`MODEL_MANAGEMENT_SCHEMA_VERSION = 4`**，首次启动时会自动从 v3 迁移至 v4。
3. **桌面客户端与独立服务端必须同版本**：
   - 连接远程服务端时，桌面端与服务端业务版本必须严格一致（均为 `0.9.0`）。

---

## 桌面端从 `0.8.0` 升级至 `0.9.0` 指南

1. **第一步：完整退出旧版并备份数据**：
   - 先在 `0.8.0` 的“设置 -> 存储 -> 备份与恢复”中创建一份备份，或手动完整复制一份应用数据目录（`<userData>`）及独立配置的图片存储目录。
   - 完全退出正在运行的 Javdex 桌面应用（若开启了“关闭窗口后保留在系统托盘”，请右键托盘图标选择“退出”）。
2. **第二步：安装 `0.9.0` 客户端**：
   - **Windows**：运行 `Javdex-Setup-0.9.0-x64.exe` 覆盖安装，或解压新的 `.zip` 免安装版。
   - **macOS**：挂载对应芯片架构（`arm64` 或 `x64`）的 `.dmg`，将 `Javdex.app` 拖入 `/Applications` 替换旧版，并执行 `xattr -dr com.apple.quarantine /Applications/Javdex.app`。
   - **Linux**：替换新的 `.AppImage` 或使用 `sudo dpkg -i Javdex-0.9.0-amd64.deb` 升级（如需内置播放，请带 `--javdex-x11` 启动）。
3. **第三步：启动并验证自动迁移**：
   - 启动 `0.9.0`，系统会自动将本机 `library.db` 从 schema 19 升级到 21，并将 `ai-configuration.json` 升级到格式 4。

---

## Docker 服务端从 `0.8.0` 升级至 `0.9.0` 专项步骤

由于 `0.8.0` 容器尚不包含容器内托管更新管理器（`/opt/javdex-manager`），**首次从 `0.8.0` 升级到 `0.9.0` 必须由管理员通过更换 Docker 镜像并新增 `/program` 程序卷完成**：

### 1. 停止 `0.8.0` 容器并备份数据
```bash
# 正常停止旧容器（切勿附带 -v 参数！）
docker compose stop
```
停止后，在宿主机上将 `/data` 目录（及独立挂载的图片目录）完整复制备份一份。

:::danger[严禁执行 `docker compose down -v`]
升级或重建容器时，**绝对不要执行 `docker compose down -v`**！`-v` 参数会销毁 Docker 命名数据卷，导致数据库与图片被彻底删除。
:::

### 2. 修改 `docker-compose.yml` 新增 `/program` 卷
在 `0.9.0` 中，容器必须挂载独立的持久化 `/program` 程序卷（用于保存业务版本闭包、更新状态以及自動生成的 3072 位 TLS 自签名证书）：

```yaml
services:
  javdex:
    image: ghcr.io/javdexlabs/javdex-server:0.9.0
    container_name: javdex-server
    restart: unless-stopped
    stop_grace_period: 150s
    ports:
      - "8096:8096"
    volumes:
      - ./data:/data
      - ./program:/program        # 0.9.0 必须新增的独立程序持久卷
      - ./config:/config:ro
      - /volume1/video:/media/movies:rw
```

### 3. 启动 `0.9.0` 容器与桌面端协议自动迁移
1. 启动新容器：
   ```bash
   docker compose up -d
   ```
   容器启动时会将内置 `/app` 种子同步至 `/program`，自动生成 TLS 自签名证书，并将 `/data/library.db` 从 schema 19 升级到 21。
2. **桌面端 `http://` 旧连接自动升级为 `https://`**：
   - 在 `0.8.0` 中，桌面端使用的是明文 `http://` 连接与单写者凭证。
   - 当你启动升级后的 `0.9.0` 桌面端时，客户端（`legacyServerConnection.ts`）会自动把已保存的 `http://<host>:<port>` 规范化升级为 `https://<host>:<port>`，自动完成首次 TLS 证书指纹固定（TOFU），并将旧版凭证平滑迁移至 Schema 21 的 `catalog_writer_credentials` 多可信设备表中。
   - 若旧凭证已失效，只需在宿主机执行 `docker exec javdex-server node /opt/javdex-manager/index.js token --config /config/server.json` 签发新的一次性配对码重新连接即可。

---

## 如何安全回退至旧版本？

如果在升级到 `0.9.0` 后，因操作系统环境限制（例如旧版 Linux 发行版的 glibc 或 X11 限制）需要退回 `0.8.0`：

1. **完全停止 `0.9.0` 桌面端或服务端容器**。
2. **还原升级前的备份数据**：
   - 将升级前备份的 `0.8.0`（schema 19）`<userData>` 或 `/data` 目录还原覆盖回原位置（不要保留已被升级为 schema 21 的 `library.db`）。
3. **重新安装或启动 `0.8.0` 程序**：
   - 桌面端重新安装 `0.8.0` 安装包；服务端将镜像标签改回 `0.8.0` 并启动。
