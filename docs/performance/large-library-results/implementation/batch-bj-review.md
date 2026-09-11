# BJ 两路复核及边界

Standards/Spec发现旧演员load在actor归属检查前递增共享metadata序列，可使新演员资料永远loading。真实旧EditModal保存挂起、切B metadata挂起、旧保存完成，red2断言Actor2不存在。将load guard放在序列/刷新之前，回归通过，静态确认关闭。

Spec又发现成功A result可在A→B在途→A按字符串pageKey复活。真实Page红例返回A时60卡而期望0；导航pageKey变化增generation，reload不增generation，sessionKey隔离旧result；回归证明当前A返回前及迟到B之后均0卡。offset ABA同机制，当前仅静态覆盖。最终只读复核无新增阻断。

15定向包括原Merge/Avatar回归、作品60/60/5/125总数及metadata仅翻页不重读、嵌套返回仍末页、失败重试及总数缩水clamp、迟到actor结果、旧保存/metadata竞态、merge实例搜索/125总数及当前卡片刷新保持、actor ABA、封面60/60/5及迟到首页不覆盖用户tab。

两尺寸真实组件/styles浏览器用合成API和本地SVG替换media URL。作品/封面分页、activeSource及实际键盘zoom=1.01翻页保持，pager与绝对图片区不重叠、可达、无横向溢出/pageerror。图片字节/真实IPC/数据库/像素锚点/全局缓存预算不在证据中；actor其他变更命令生命周期不因此全部验收。

最终全量2310通过、1跳过、0失败，build成功。首次CSS门因测试用className.includes查询元素触发规则，改语义aria-label查找测试对象，未放宽标准。
