---
name: fr-cpt
description: FineReport 10 的 .cpt 模板协议手册与工具库：解析结构、解码内置数据集、校验、按操作列表改模板。
whenToUse: 任何涉及帆软 CPT/FRM 模板的读写、结构解析、数据集编解码、批量生成或规范落标；其他 fr-cpt-* skill 的基础库。
---

# FineReport CPT 基础库

`.cpt` 是帆软 FineReport 的 XML 模板。本 skill 是**协议手册 + 引擎脚本**，另三个 skill 在它之上：

| skill | 职责 |
|---|---|
| `fr-cpt-build` | 源表 + 自然语言（或 Excel 表样）→ 标准模板 |
| `fr-cpt-edit` | 自然语言 → 操作列表 → 改现有模板 |
| `fr-cpt-analyze` | 解析血缘/逻辑图、定位问题、给可执行修复 |
| `fr-cpt-standard` | 紫金 6.2 报表规范落标与自查 |

脚本都在 `scripts/`（本 skill 的 base dir 下）。跑法：用 `load_workspace_dependencies`
给的 python 解释器（已带 lxml / openpyxl），例如
`python scripts/cpt_dump.py 模板.cpt`。

## 先看清结构，再动手

```bash
python scripts/cpt_dump.py 模板.cpt            # 结构 + 数据集解码 + 校验
python scripts/cpt_dump.py 模板.cpt --standard # 追加紫金 6.2 自查
python scripts/cpt_patch.py 模板.cpt --show-selectors   # 可用的目标选择器与角色分布
python scripts/cpt_analyze.py 模板.cpt         # 血缘 / 逻辑图 / 诊断
```

`cpt_dump` 会打印：根节点一级子节点、数据集（内置数据集会被**解码成行**）、样式表、
逐格矩阵（`[4x1]Text('标题')` / `DSColumn(ds=ds1, col=地区, group)`）、扩展/父子格、
最后是校验清单。任何"模板不显示数据"的问题，第一步都是这条命令。
`cpt_analyze` 再进一步：每个格子的来源/加工/最终溯源、反推 SQL、可执行修复建议。

## 协议要点（细节见 references/protocol.md）

- 根 `WorkBook`，`xmlVersion` / `releaseVersion`；必需子节点只有 `Report` + `StyleList`。
- 单元格 `<C c r cs rs s>`：`c`/`r` 是 **0 基**下标，`cs`/`rs` 是跨行跨列，`s` 是 `StyleList` 的
  **位置下标**（顺序敏感，读改写时不能去重）。
- 值节点 `<O>` 靠 `t` 分型：无 `t` = 文本，`I` 整数，`D` 浮点，`BigDecimal` 小数，
  `DSColumn` 数据列绑定，`XMLable`+`com.fr.base.Formula` 公式，`CC` 图表。
- 量纲（踩坑重灾区）：行高列宽是 **FU**（1pt = 50800 FU，1mm = 144000 FU）；
  字号属性 = **磅 × 8**；颜色是有符号 32 位 ARGB；对齐 `CENTER=0 / LEFT=2 / RIGHT=4`。
- 内置数据集 `RowData` 是私有编码：`ascii85(裸 deflate(UTF-8 行文本))`，行 `\n`、字段 `\t`、
  转义 `&t;`/`&n;`，`ColumnNames` 分隔符是 `,,.,,`。**永远用 `scripts/frcodec.py` 生成，
  不要手写 blob。**
- 数据库连接**不在 CPT 里**，只有连接名引用（`NameDatabaseConnection/DatabaseName`）。
- **数据集 SQL 只写 PostgreSQL / Greenplum 方言**：方括号标识符、`TOP n`、`ISNULL`、`GETDATE()`
  都要改（`scripts/dialect.py` 会检查并自动改写能改的）。`${x}` 是文本替换，日期要显式转。

## 工具

| 脚本 | 用途 |
|---|---|
| `scripts/frcpt.py` | 模型 / 读写 / 校验（量纲换算、样式表、数据集、冻结、条件属性、填报提交） |
| `scripts/frcodec.py` | 内置数据集 blob 编解码（已与帆软自身代码字节级对齐） |
| `scripts/zjky.py` | 紫金 6.2 规范的样式工厂与检查器 |
| `scripts/xlsx2cpt.py` | Excel 表样 + 配置 → CPT |
| `scripts/recipe2cpt.py` | 配方（源表 + 自然语言的结构化描述）→ CPT，带 Excel 预览 |
| `scripts/cpt_patch.py` | 操作列表（JSON）→ 改 CPT，含变更清单与校验 |
| `scripts/cpt_dump.py` | 反向：CPT → 人可读结构 |
| `scripts/cpt_analyze.py` | 血缘 / 逻辑图 / 反推 SQL / 诊断修复 |
| `scripts/dialect.py` | 数据集 SQL 的 PostgreSQL / Greenplum 方言检查与改写 |

参考文档：`references/protocol.md`（协议）、`references/datasets-debug.md`（数据集与排查）、
`references/production-findings.md`（**生产模板实测：填报控件/多提交规则/连接名坑**）、
`references/sql-dialects.md`（**PG/GP 方言对照，目标库就是这两个**）、
`references/formulas-and-params.md`（公式与参数怎么落）、`references/patching.md`（改模板操作字典）、
`references/zjky-standard.md`（6.2 换算表）。

## 铁律

1. **不猜节点名和属性名。** 生成任何节点前，确认它已出现在官方模板或生产模板语料里；本项目有
   `verify_generated.py`（工作区）做属性词汇表比对。凭空造属性 = 模板能打开但行为不对。
2. **不手写 `<RowData>`。** 用 `frcodec.encode_row_blob`。
3. **改文件先留退路。** `cpt_patch` 默认写 `*.patched.cpt`，要原地改才加 `--in-place`。
4. **改完必须过两道检查**：`frcpt.validate`（引用/越界/重叠）和 `zjky.check`（6.2 规范）。
5. **字号/行高/列宽一律走换算函数**（`pt_to_font_size` / `pt_to_fu` / `zjky.mm_to_fu`），
   不要直接填阿拉伯数字。
6. **碰生产模板前先跑保真回归**：`production_roundtrip.py`（工作区）。生产模板里有官方示例
   没有的东西——单元格填报控件 `Widget`、多条 `SubmitVisitor`、`ColumnRowGroup`、插件属性
   节点（`StrategyConfigsAttr` / `ExcelImportTemplateAttr`）、5 类高亮动作。模型用
   `extras` + `child_order` + `*_raw` 做透传保序，任何新增节点都要验证它们没被吃掉。

## 已知边界

不生成图表（`t="CC"`）、不生成决策报表 `.frm`、日期类型不进内置数据集、
样式库引用（`<Style index>`）只在读时保留；填报控件只建模 `TextEditor`，
高亮动作只保留原文不能按语义生成。详见 `references/protocol.md` 末节与
`references/production-findings.md` 第七节。
