# 紫金 6.2 报表规范（编码版）

来源：《紫金矿业大数据平台数据开发规范 v1.18》6.2 报表规范。
这里是 `zjky.py` 里那套常量的可读副本，两者必须一致；改常量时同步本文。

## 样式表

| 分类 | 细类 | 填充 | 边框 | 字色 | 字体 | 字号 | 加粗 | 对齐 | 缩进 |
|---|---|---|---|---|---|---|---|---|---|
| 上侧表头 | | `1D9390` | `FFFFFF` | `FFFFFF` | 微软雅黑 | 11 | 是 | 居中 | 左右 3 |
| 左侧表头 | | `BAE4E3` | `F1FDFD` | `06171F` | 微软雅黑 | 11 | 是 | 居中 | 左右 3 |
| 正文 | 数字 | `FFFFFF` | `A0D0CF` | `000000` | 微软雅黑 | 10 | 否 | 右对齐 | 右 3 |
| 正文 | 非数字 | `FFFFFF` | `A0D0CF` | `000000` | 微软雅黑 | 10 | 否 | 居中 | 左右 3 |
| 正文 | 填报表取数与公式 | `E3F1F1` | `A0D0CF` | `000000` | 微软雅黑 | 10 | 否 | 右对齐 | 右 3 |
| 鼠标悬浮 | | `BAE4E3` | | | | | | | |
| 超链接 | | `226D6D` | | | | | | | |

行高 7mm，列宽 28mm，字体统一微软雅黑。

## 换算到 CPT（与 `zjky.py` 常量一一对应）

| 规范值 | CPT 落点 | 值 | 依据 |
|---|---|---|---|
| 行高 7mm | `RowHeight` 数组 | `1008000` | `FU_PER_MM=144000`（`com.fr.stable.Constants`） |
| 列宽 28mm | `ColumnWidth` 数组 | `4032000` | 同上 |
| 字号 11 | `FRFont@size` | `88` | 属性 = 磅 × 8（`FRFont.SCALE_TO_FRSIZE=8`） |
| 字号 10 | `FRFont@size` | `80` | 同上 |
| 缩进 3 | `Style@paddingLeft/Right` | `11` | 3mm × 96/25.4 ≈ 11.3 → 11（**推断**） |
| 数字不换行 | `Style@textStyle` | `1` | `TEXTSTYLE_SINGLELINE=1` |
| 居中/右/左 | `Style@horizontal_alignment` | `0` / `4` / `2` | `com.fr.stable.Constants` |
| 垂直居中 | `Style@vertical_alignment` | `0` | 同上（CENTER=0） |
| 细边框 | `Border@style` | `1` | `LINE_THIN` |
| 冻结 | `ReportSettings/FrozenColumnRow@columnrow` | 如 `A3` | 数据区左上角 |

## 判断题（生成/修改时的默认决策）

- 表格第一行是标题还是表头？→ 标题单独一行且横跨整表时为标题；否则第一行就是上侧表头。
  两者都套「上侧表头」样式（规范只给了三类样式）。
- 要不要左侧表头？→ 数据列左侧还有一列纯文字（指标名/序号）时，是左侧表头；否则没有。
- 某列算数字还是文字？→ 看数据集列类型（`java.lang.Integer/Double/BigDecimal` 为数字），
  字符串列一律按文字。拿不准就按文字（居中），比错标数字安全。
- 千分位？→ 默认不加（规范：默认不要，按业务要求再加）。
- 小数位？→ 默认沿用 Excel 的数字格式；规范没定死。

## 检查器规则编号

`ZJ-STYLE` / `ZJ-STYLE-MISSING` / `ZJ-ROW-HEIGHT` / `ZJ-COL-WIDTH` / `ZJ-FREEZE` /
`ZJ-TAIL-BLANK` / `ZJ-DASH-ALIGN` / `ZJ-DASH-FILL` / `ZJ-VIEW-HIGHLIGHT` / `ZJ-COMPANY-HEADER`。
含义见 `fr-cpt-standard/SKILL.md`。

## 不确定项

1. 缩进单位按毫米推断（见上表）；若实为 px，改 `zjky.INDENT_MM = None, INDENT_PX = 3`。
2. `$op='view'` 的参数来源（URL / 系统变量）不在规范文本里，条件属性生成正确但要平台确认。
3. 标题行样式沿用上侧表头，若贵司另有规定用 `set_style` 覆盖。
4. 鼠标悬浮 / 超链接只给了底色，字形未定义，未纳入检查。
