---
name: fr-cpt-build
description: 用 Excel 表样 + 数据集配置生成帆软 CPT 模板（分析表/填报表），自动套用紫金 6.2 报表规范。
whenToUse: 用户给了表样（Excel/截图/字段清单）与数据集（SQL 或内置数据），要一份能直接打开的 .cpt；或要求"按规范生成报表"。
---

# 生成 CPT 模板

引擎在 `../fr-cpt/scripts/`（同一次安装的兄弟 skill）。下文命令以该目录为工作目录，
或写全路径 `../fr-cpt/scripts/xlsx2cpt.py`。

## 两条入口，按用户给的东西选

| 用户给了 | 走哪条 | 命令 |
|---|---|---|
| 现成 Excel 表样 | **表样路径**：Excel 管版式，JSON 管数据集 | `xlsx2cpt.py 配置.json` |
| 只给了源表（DDL/字段清单/样本行）+ 一句自然语言需求 | **配方路径**：先把话翻译成配方，再编译 | `recipe2cpt.py 配方.json --xlsx 预览.xlsx` |
| 表样 + 要改结构/口径 | 配方路径更好核对；或先表样路径生成再 `fr-cpt-edit` | — |

**推荐配方路径**：自然语言不可审计，配方是**人可读、可进版本库、可复核**的中间产物。
你只负责把需求翻译成配方字段，编译是确定性的；用户改一行配方就能改口径，不用重画 Excel。

## 路径 A：配方（源表 + 自然语言）

### 第 1 步：从源表建数据集

`source` 是唯一的数据来源声明。两种：

```jsonc
{ "name": "ds1", "type": "sql", "connection": "FRDemo",
  "query": "SELECT 地区, SUM(销量) AS 销量 FROM 销量 WHERE dt = '${biz_date}' GROUP BY 地区",
  "parameters": [{"name": "biz_date", "value": "2025-01-01"}],
  "columns": [{"name":"地区","type":"string"},{"name":"销量","type":"integer"}] }
```
```jsonc
{ "name": "ds1", "type": "embedded",
  "columns": [{"name":"地区","type":"string"},{"name":"销量","type":"integer"}],
  "rows": [["华东",120],["华南",95]] }
```

- `columns` 两个用途：校验 `fields` 是否存在、决定"维度 vs 度量"（`integer/double/decimal` 算数值）。
  SQL 数据集也建议写（从 `information_schema` 或 DDL 抄），没有就靠 SQL 里的 `sum(...) AS 别名` 猜。
- SQL 里出现 `${x}`，就必须在 `parameters` 里声明 `x`，否则运行期取不到值（校验器会挡）。
- 能离线就选 `embedded`：数据随模板走，跨机器可跑。

### 第 2 步：把需求翻译成列定义

```jsonc
"columns": [
  {"label": "企业名称", "field": "地区", "kind": "dimension", "group": true},
  {"label": "销量",     "field": "销量", "kind": "measure", "format": "#,##0"}
]
```

- `label` = 表头文字（用户怎么说就怎么写，公司列头按规范统一【企业名称】）；
- `field` = 源表字段名，必须在 `source.columns` 里；
- `kind` = `dimension`（分组/展开）或 `measure`（数值）；
- `group: true` → 分组（相同值合并）；省略 → 明细展开；
- `format` → 数字格式（`#,##0` 千分位、`0.00%` 百分比）。规范默认不要千分位，用户要才加。

### 第 3 步：公式与合计

```jsonc
"formulas": [ {"label":"销量占比","expr":"=D{datarow}/D{footer}","format":"0.00%"} ],
"footer":   [ {"text":"合计"}, {"agg":"sum","field":"销量"} ]
```

- 公式里用 `{datarow}` / `{footer}` 占位，编译时替换成真实行号（1 基），别手数。
- 公式必须以 `=` 开头；跨格运算才用公式，能在数据集算的（分组/汇总/过滤）用 `kind/agg`。
- `footer` 长度必须等于 `columns + formulas` 的总列数，逐列对齐；空位写 `{"text": ""}`。
- `agg` ∈ `sum/count/avg/max/min`。

### 第 4 步：编译与核对

```bash
python ../fr-cpt/scripts/recipe2cpt.py 配方.json --out 结果.cpt --xlsx 预览.xlsx
```

- 先跑 **配方校验**（字段缺失、字段不在源表、footer 长度、参数未声明），有问题直接改配方；
- 再看 **结构校验** 与 **6.2 自查**，两条都绿；
- `--xlsx` 产出的预览表是给业务方确认版式的，比读 XML 有用；
- 最后用 `fr-cpt-analyze` 出逻辑图，把口径回给用户确认：
  `python ../fr-cpt/scripts/cpt_analyze.py 结果.cpt`

### 填报表（录入）的配方增量

```jsonc
"report_kind": "entry",
"write_back": {
  "connection": "FRDemo", "table": "sales_detail",
  "mappings": [ {"column":"地区","cell":"A3","is_key":true}, {"column":"销量","cell":"D3"} ]
}
```
填报表的取数/公式格会自动带 `E3F1F1` 底色 + `$op='view'` 条件属性（一套表兼作分析表）。

## 路径 B：Excel 表样

1. **看表样**：`openpyxl` 读出表头行、数据行、合并区域，确认哪一行是表头
   （判断标准：这一行往下开始出现数据列绑定）、哪一列是数字。
2. **定数据集**：能从 Excel 取数就 `from_excel`；必须查库才用 `sql`，并提醒用户连接名要对。
3. **生成**：`python ../fr-cpt/scripts/xlsx2cpt.py 配置.json`，配置里 `standard: "zjky"`。
4. **复核**：`python ../fr-cpt/scripts/cpt_dump.py 结果.cpt --standard`，
   确认表头行在上、数据行 `Expand dir="0"`、汇总格无 `Expand`、冻结锚点在数据区左上角、
   底部有 2 行空行、行高 7mm / 列宽 28mm。

### 版式里的占位符（必须独占整个单元格）

| 占位符 | 产出 |
|---|---|
| `{{ds1.地区}}` | 数据列，纵向扩展 |
| `{{ds1.地区|right}}` | 数据列，横向扩展（交叉报表的第二个维度） |
| `{{ds1.地区|group}}` | 分组（相同值合并） |
| `{{ds1.销量|sum}}` | 汇总，不扩展；`count/avg/max/min` 同理 |
| `{{=D3*C3}}` | 公式 |
| `{{text:合计：}}` | 纯文本（防止被认成绑定） |

Excel 自身的字体/颜色/边框在 `standard: "zjky"` 下会被统一覆盖——这正是"不用重复配置"的地方；
合并单元格、行列数量、占位符位置仍然决定结构。

### 配置骨架

```jsonc
{
  "excel": "表样.xlsx",
  "output": "../out/result.cpt",
  "sheet": "报表",
  "report_name": "sales_detail",
  "standard": "zjky",
  "report_kind": "analysis",
  "tail_blank_rows": 2,
  "datasets": [
    { "name": "ds1", "type": "embedded",
      "from_excel": { "sheet": "数据", "header_row": 1, "first_data_row": 2, "columns": "A:D" } }
  ],
  "write_back": { "...": "填报表才需要" },
  "roles": {}
}
```

## 分析表 / 填报表的差别

| | 分析表 | 填报表 |
|---|---|---|
| 数据格 | 数据列正常取数 | 数据列=取数格，底色 `E3F1F1` |
| 公式格 | 右对齐正文 | 底色 `E3F1F1` + `$op='view'` 条件属性转白 |
| 提交配置 | 无 | `ReportWriteAttr/SubmitVisitor/BuiltInSQLSubmiter`，需表的字段↔单元格映射 |
| 用途 | 看数 | 录入/修改 + 兼作分析表（一套表两用） |

## 报告给用户的固定结论项

- 数据集：名称、类型（内置/SQL）、列与行数（内置要报实际行数）。
- 版式：表头行数、是否有序号列、冻结位置。
- 规范：6.2 自查结论（绿/黄，列出偏差单元格）。
- 边界：未做的部分直接说（例如"未生成图表"、"连接名沿用 FRDemo，需要你确认平台上是否存在同名连接"）。

不确定的地方**标出来而不是编**：连接名、业务口径、是否需要千分位、日期格式，
这些都要问或给默认值并注明是默认值。
