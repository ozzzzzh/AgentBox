---
name: fr-cpt-edit
description: 按自然语言改现有帆软 CPT 的样式、绑定、数据集、冻结、条件属性，输出可审计的变更清单。
whenToUse: 用户说"把…改成…""这一列不要了""表头换颜色""加个合计行""标题改成 2025""绑定到另一个数据集"等针对已有 .cpt 的修改。
---

# 对话式修改 CPT

引擎：`../fr-cpt/scripts/cpt_patch.py`。核心思路是**意图 → 操作列表（JSON ops）→ 确定性执行**。
你不直接改 XML，也不手写 blob：你写 ops，工具执行、列出每一处改动、再跑两道校验。

## 三步走，不许跳

```bash
# 1. 先看清当前状态（别凭文件名猜）
python ../fr-cpt/scripts/cpt_patch.py 模板.cpt --show-selectors

# 2. 写 ops.json，先干跑
python ../fr-cpt/scripts/cpt_patch.py 模板.cpt ops.json --plan

# 3. 确认后落盘（默认写 *.patched.cpt）
python ../fr-cpt/scripts/cpt_patch.py 模板.cpt ops.json
```

`--plan` 会打印每条操作影响几处、具体是哪几个格子；落盘后再打印结构校验 + 6.2 自查。
两步的输出都要给用户看，尤其"改了几处"——用户常以为改一个格子，其实命中一整列。

## 目标选择器

| 写法 | 命中 |
|---|---|
| `A1` / `A1:D5` | 单元格 / 区域 |
| `row:2` / `rows:2-4` | 整行（行号按界面 1 基） |
| `col:D` / `cols:A-D` | 整列 |
| `role:上侧表头` | 按规范角色：上侧表头 / 左侧表头 / 数字 / 文字 / 取数与公式 |
| `formula` / `number` / `bound` / `text` | 按值类型（公式 / 数字 / 数据列 / 纯文本） |
| `all` | 全部 |

**优先用 `role:` 和类型选择器**。"把所有数字改成两位小数"用 `role:数字`，
比 `col:D` 稳——用户改了列宽/插了列之后 `col:D` 就错了。

## 意图 → ops 对照

| 用户说 | ops |
|---|---|
| 标题改成 XXX | `{"op":"set_value","target":"A1","value":"XXX"}` |
| 表头加粗/换色/字号 11 | `{"op":"set_style","target":"role:上侧表头","style":{"bold":true,"fill":"1D9390","font_size":11}}` |
| 数字列千分位/两位小数 | `{"op":"set_style","target":"role:数字","style":{"number_format":"#,##0.00"}}` |
| 金额靠右、文字居中 | `{"op":"set_style","target":"role:数字","style":{"align":"right"}}` |
| 这一列不要了 | `{"op":"unbind","target":"col:C"}`（只清绑定）或 `{"op":"set_value","target":"col:C","value":""}`（清内容） |
| 把 C 列绑到 ds2 的金额 | `{"op":"bind","target":"C3","dataset":"ds2","column":"金额"}` |
| 按地区分组 | `{"op":"bind","target":"A3","dataset":"ds1","column":"地区","mode":"group"}` |
| 销量求和 | `{"op":"bind","target":"D4","dataset":"ds1","column":"销量","aggregate":"sum"}` |
| 加公式 | `{"op":"set_formula","target":"D4","expr":"=sum(D3)"}` |
| 合并标题行 | `{"op":"merge","range":"A1:D1"}` |
| 取消合并 | `{"op":"unmerge","target":"A1"}` |
| 行高 7mm / 列宽 28mm | `{"op":"resize","rows":"1-4","height_mm":7}` / `{"op":"resize","cols":"A-D","width_mm":28}` |
| 冻结首行 | `{"op":"freeze","cell":"A2"}`（A2 = 标题行下方第一格） |
| 底部留空行 | `{"op":"add_tail_rows","count":2}` |
| 超过阈值标黄 | `{"op":"highlight","target":"role:数字","formula":"D3 > 100","fill":"FFF2CC"}` |
| 填报表兼分析表 | `{"op":"highlight","target":"role:取数与公式","formula":"$op = 'view'","fill":"FFFFFF"}` |
| 换数据源 SQL | `{"op":"update_dataset","name":"ds1","query":"SELECT ..."}` |
| 加一个数据集 | `{"op":"add_dataset","dataset":{"name":"ds2","type":"embedded","columns":[{"name":"地区","type":"string"}],"rows":[["华东"]]}}` |
| 整个表重刷规范 | `{"op":"apply_standard","kind":"analysis","tail_blank_rows":2}` |
| 改 sheet 名 | `{"op":"rename_sheet","name":"sales_detail"}` |

多条意图按顺序拼进一个 `ops` 数组；**顺序有意义**（先改结构再刷样式，否则样式会被覆盖）。

## 样式属性字典（`style` 里能写什么）

`font_name` / `font_size`（磅，工具自己 ×8）/ `bold` / `italic` / `color`（字色，`RRGGBB`）/
`fill`（底色，`RRGGBB`，`none` 清空）/ `align`（`left|center|right`）/ `valign`（`top|center|bottom`）/
`wrap` / `no_wrap` / `number_format`（`#,##0.00`、`0.00%`）/ `padding_left` / `padding_right`（px）/
`border`（`thin|medium|dash|thick|double|none`）/ `border_color` / `border_style`。
不认识的键会**报错**而不是静默忽略——这是故意的。

## 反例（别这么干）

- 不要直接改 `.cpt` 的 XML 文本。位置下标（`s`）、CDATA、blob 编码任何一个错都会静默坏页面。
- 不要给 `role:` 之外的目标猜坐标：先 `--show-selectors` 看角色分布，再决定。
- 不要在 `highlight.formula` 里写 `$列名`。条件属性的公式按**单元格坐标**写，例如 `D3 > 100`。
- 不要把"删除列"理解成 `merge`：删列要同时处理 `cs`、列宽数组、提交映射，属于重构，
  先告诉用户影响面，再让他确认。
- 不要一次提交 10 条以上 ops 而不 `--plan`。

## 改完必须回答的三句话

1. 改了哪些格子（用工具打印的清单，必要时归并成"表头 5 个格子"）。
2. 结构校验 / 6.2 自查结论。
3. 输出文件路径（默认 `*.patched.cpt`；用户要覆盖原文件才加 `--in-place`）。
