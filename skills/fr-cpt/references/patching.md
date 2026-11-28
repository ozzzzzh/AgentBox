# 操作字典（cpt_patch ops）

`cpt_patch.py` 只认下面这些 op。未知 op 或未知样式键一律报错，不静默跳过。

```json
{ "ops": [ { "op": "...", ... }, ... ] }
```

除特别说明，都支持 `"sheet": "名字"` 指定工作表（默认第一张）。

## 目标选择器（`target`）

| 写法 | 命中 | 备注 |
|---|---|---|
| `A1` | 单格 | 0 基内部换算，写的是界面坐标 |
| `A1:D5` | 矩形区域 | 含端点 |
| `row:2` / `rows:2-4` | 整行 | 1 基，同界面 |
| `col:D` / `cols:A-D` | 整列 | 字母 |
| `role:上侧表头` \| `左侧表头` \| `数字` \| `文字` \| `取数与公式` | 按 6.2 角色 | 角色由结构推断 |
| `formula` / `number` / `bound` / `text` | 按值类型 | 公式 / 数字 / 数据列 / 纯文本 |
| `all` | 全部有内容的格子 | 慎用 |

选择器只命中**已存在的单元格对象**。被合并覆盖的格子、以及从未写过的空格子不在集合里。

## op 清单

### set_style
```json
{"op":"set_style","target":"role:上侧表头","role":"上侧表头","style":{...}}
```
- 给 `role` → 用该角色的规范样式打底（见 `zjky.style_for`），再用 `style` 覆盖。
- 不给 `role` → 在当前样式上叠加 `style`。
- `style` 可用键：`font_name` `font_size`(磅) `bold` `italic` `color` `fill` `align` `valign`
  `wrap` `no_wrap` `number_format` `padding_left` `padding_right` `border` `border_color` `border_style`。

### set_value
```json
{"op":"set_value","target":"A1","value":"标题"}
```
数字/布尔值自动分型为 `Number`。写入文本会顺带清掉该格的扩展设置。

### set_formula
```json
{"op":"set_formula","target":"D4","expr":"=sum(D3)"}
```
前导 `=` 可省。

### bind / unbind
```json
{"op":"bind","target":"C3","dataset":"ds1","column":"金额","mode":"list|group|summary",
 "aggregate":"sum","expand":"down|right"}
{"op":"unbind","target":"col:C"}
```
- `mode=group` → `RG FunctionGrouper`；`mode=summary`（或直接给 `aggregate`）→ `RG SummaryGrouper + FN`。
- 汇总格自动不带 `Expand`；可扩展格自动带 `dir`。
- `unbind` 把数据列变成空白格并清掉扩展。

### merge / unmerge
```json
{"op":"merge","range":"A1:D1"}
{"op":"unmerge","target":"A1"}
```
`merge` 会**删除**被覆盖区域里的其它 `C` 元素（帆软模型里合并区只有左上角一格）。

### resize
```json
{"op":"resize","rows":"1-4","height_mm":7}
{"op":"resize","cols":"A-D","width_mm":28}
```
也支持 `height_fu` / `width_fu` 直接给 FU。

### freeze
```json
{"op":"freeze","cell":"A3"}     // A3 = 数据区左上角，即第 1-2 行、A 列以左被冻结
{"op":"freeze","cell":null}     // 取消
```

### add_tail_rows
```json
{"op":"add_tail_rows","count":2,"height_mm":7}
```
在行高数组末尾追加空行（6.2 要求底部留 2 行）。

### highlight
```json
{"op":"highlight","target":"role:数字","formula":"D3 > 100","fill":"FFF2CC","name":"超百高亮"}
```
生成 `Highlight[DefaultHighlight]` + `FormulaCondition` + `BackgroundHighlightAction`。
**公式按单元格坐标写**（`D3 > 100`），不要写 `$列名`。

### add_dataset / update_dataset / delete_dataset
```json
{"op":"add_dataset","dataset":{"name":"ds2","type":"embedded",
  "columns":[{"name":"地区","type":"string"},{"name":"金额","type":"double"}],
  "rows":[["华东",12.5]]}}
{"op":"update_dataset","name":"ds1","query":"SELECT * FROM t WHERE dt='${dt}'"}
{"op":"delete_dataset","name":"ds2"}
```
`dataset` 的 schema 与 `xlsx2cpt` 配置里的 `datasets[]` 完全一致（含 `from_excel`）。

### writeback
```json
{"op":"writeback","spec":{"connection":"FRDemo","table":"sales_detail",
  "mappings":[{"column":"地区","cell":"A3","is_key":true}]}}
```
生成 `ReportWriteAttr/SubmitVisitor[BuiltInSQLSubmiter]/DMLConfig[IntelliDMLConfig]`。

### apply_standard
```json
{"op":"apply_standard","kind":"analysis|entry","tail_blank_rows":2,"roles":{"A1":"上侧表头"}}
```
重建样式表并整体刷新规范样式——会**丢弃**之前所有手工样式，等价于按规范重做一遍。
适合"先调结构、最后统一刷规范"的用法。

### rename_sheet
```json
{"op":"rename_sheet","name":"sales_detail"}
```

## 执行语义

- ops 按数组顺序执行，前一条的改动是后一条的输入（先改结构、再刷样式）。
- 每条 op 打印影响数量与前若干条明细，`--plan` 时不写文件。
- 默认输出 `*.patched.cpt`；`--in-place` 才覆盖原文件。
- 落盘前跑 `frcpt.validate`（引用/越界/重叠/孤儿数据集）与 `zjky.check`（6.2 规范）。
- 有 `error` 级问题时进程返回非零，便于在自动化里拦截。
