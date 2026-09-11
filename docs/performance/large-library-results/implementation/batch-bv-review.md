# BV只读审查

Reviewer `01a0895e-3dbd-78e3-abef-f3ab66f8ffd6` 两次复核，均未发现当前增量阻断；未改文件或运行测试。

- sources之外独立disabled key，隐藏刷新只失效；旧数据失去观察者后回收，signal阻止迟到结果采用。
- 加载、失败重试与空记录分开；真实QueryClient覆盖缓存删除、ABA、换库、重试。
- 补充旧refresh闭包守卫后，隐藏旧刷新不触发读取，切库不会误刷当前库；同库且当前可见才refetch，回归直接保存旧函数再hide调用。
- 不取消底层IPC，不减少sources打开时的完整审计读取；后续后端分页仍需实现。

验证过程另外修复测试工程问题：同名.test.ts/.tsx改为.interaction.test.tsx；断言null对可变hook状态产生跨await静态收窄，改通过getter读取当前状态，保留原断言语义。未放宽lint/typecheck。
