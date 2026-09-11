# BS SQL只读审查

Spec reviewer `01a0895e-3dbd-78e3-abef-f3ab66f8ffd6`：未发现语义回归或阻断；未修改文件或运行测试。

- 原资格条件保留，组织同行OR不重复。
- 内外层完整排序一致，NULL、空串、空白的原始release_date仍参与排序。
- 唯一主键回表不增减页项，count/page/回表仍同一只读事务，worker连接注入未变。
- 减少宽字段排序不等于消除cover_path资格读取或深页计算；提速以独立探针为依据。
