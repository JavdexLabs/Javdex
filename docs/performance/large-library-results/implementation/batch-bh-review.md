# BH 两路静态审查

Standards无具体阻断：与旧详情一致的活动可见membership EXISTS、事务count/page、MATERIALIZED先ID页后卡片投影；默认60/最大240，repo与IPC参数边界一致。

Spec初轮要求补日期空串/null与不同add_time、资源徽标/pending及WAL。最终测试逐项补齐：显式null置底、BINARY比较，local/web/magnet顺序和pending，count后外部hide保持当前快照，下次看到隐藏。定向29通过。最终静态无阻断。探针另补EQP非空断言并运行成功。

页计时包含存在性、count、排序、卡片投影，未单独测count或捕获count EQP。探针仅首末页ID/total等值；完整卡片等值由262条定向夹具支持。原全量2300通过、1跳过；之后只增强测试，最终定向与类型门通过、build成功，未重复全量。不声称UI已接入、字节预算已达标或目标平台/冷盘/p95/峰值内存已验收。
