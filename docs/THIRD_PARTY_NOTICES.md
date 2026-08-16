# 第三方说明

本文记录 Javdex 功能直接对接或随应用分发、且需要单独披露的第三方项目。各项目名称和商标归其权利人所有；列出项目不表示存在从属、合作或背书关系。

## MetaTube

- 上游项目：[`metatube-community/metatube-sdk-go`](https://github.com/metatube-community/metatube-sdk-go)
- 许可：Apache License 2.0
- Javdex 集成：内置影片插件仅作为用户自建 `metatube-server` 的 REST 客户端。Javdex 不嵌入、下载、启动或分发 MetaTube Go 服务端、Provider 模块或数据库。
- 数据边界：用户配置服务端后，Javdex 才会向该地址发送影片番号并读取影片元数据。Token 保存在 Javdex 主进程的独立凭证文件中；MetaTube 原生 `/v1/images` 路由为公开路由，因此生成的封面和样张 URL 不携带 Token。
- 字段约定：MetaTube 的 `actors` 全部按女性演员导入；`label` 近似映射为 Javdex 的发行方。该语义差异同时在插件说明与设置界面披露。

Javdex 中的 MetaTube 适配代码为本项目实现；上述说明用于标明所对接 API、上游来源和许可边界。
