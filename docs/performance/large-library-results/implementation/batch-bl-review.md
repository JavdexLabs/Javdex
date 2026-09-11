# BL 两路静态复核

Standards/Spec未发现剩余阻断。原核心资料提取不丢字段，旧metadata仍有完整gallery；新profile外层读事务覆盖核心字段、物理/有效计数和全局首图。默认背景显式poster优先及关闭fallback不变。10,001照片测试只允许照片LIMIT读取一行，WAL插入横图验证当前与下一次首图及双计数。

39定向通过，全量2317通过、1跳过、0失败，build成功。独立探针通过，完整metadata与完整profile返回体分别计量：50k记录25.741ms/17,705,474B→23.987ms/924B。3热样本、固定顺序、oracle驻留，不能证明稳定加速或通用字节上限；旧metadata/新profile共享字段helper，静态核对原字段提取。

当前UI未接入profile；首图字符串、名字/别名/链接/简介尚无限额，SQLcount/order仍随图库增长。完整15/42目标保持。
