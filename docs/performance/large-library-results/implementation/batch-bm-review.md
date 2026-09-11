# BM 复核

Standards/Spec无当前范围阻断。通用hook保留导航generation/ABA、同页刷新与clamp；wrappers稳定且页长固定60。localOnly与原展示来源再过滤Boolean(local_path)一致，count/page前处理；默认false不改变图库。初始tab等待两个来源，用户tab/文件按钮优先。候选320缩略图，裁剪仍原始URL；actorID纳入编辑器key。

52定向通过，原52中新增照片分页/标签/重试/文件意图，891组合localOnly完整字段oracle及IPCflag校验；首次错误label测试红例已修。最终全量2320通过、1跳过、0失败，build成功。

两尺寸浏览器封面/照片60/60/5、activeSource与zoom1.01往返保持、照片pager几何、无横向/pageerror通过。请求证据记录size320与原图无size两条路径；本地SVG代替media，不代表真实文件、解码或IPC性能。未模拟系统文件对话框，只验证点击意图不被迟到页覆盖。主写真列表、profile/跨页lightbox与parent全集仍未迁移；未关闭完整15/42目标。
