# 公式与数据集参数：生成侧怎么处理

这份文档回答两个高频问题：**公式写在哪个节点**、**参数怎么传到 SQL 里**。
所有结论都对着 CPT 的实际 XML 结构，样例可在 `references/protocol.md` 与官方模板里核对。

## 一、公式在 CPT 里有 5 个落点，别混

| # | 落点 | XML 位置 | 触发方式 | 语法 |
|---|---|---|---|---|
| 1 | **单元格公式** | `C/O[@t='XMLable'][@class='com.fr.base.Formula']/Attributes` | 单元格值就是一个公式 | `=sum(D3)`、`=D3/D4` |
| 2 | **数据集参数** | `TableData/Parameters/Parameter` + `Query` 里的 `${name}` | SQL 里取参数 | SQL 片段 |
| 3 | **单元格过滤条件** | `C/O[@t='DSColumn']/Condition` | 数据列过滤（WHERE） | `CommonCondition` / `FormulaCondition` / `ListCondition` |
| 4 | **扩展后排序** | `C/Expand/SortFormula` | 分组后排序 | `=inarray(A2, 自定义顺序.select(地区顺序))` |
| 5 | **条件属性公式** | `C/HighlightList/Highlight/Condition[@class='com.fr.data.condition.FormulaCondition']/Formula` | 满足条件改样式 | `D3 > 100`、`$op = 'view'` |

生成器的对应关系（`recipe2cpt.py` / `cpt_patch.py`）：

| 配方/操作 | 产出 |
|---|---|
| `{"label":"占比","expr":"=D{datarow}/D{footer}"}` | 落点 1，`{datarow}`/`{footer}` 编译时替换成真实行号（1 基） |
| `source.parameters` + `query` 里的 `${x}` | 落点 2 |
| `{"op":"bind",...,"mode":"group"}` + 单元格 `Condition` | 落点 3（当前生成器只在读时保留，不新建过滤器） |
| `{"op":"highlight","formula":"D3 > 100"}` | 落点 5 |
| `{{ds1.销量\|sum}}` | 不是公式，是数据列 + `RG SummaryGrouper`（汇总在引擎侧算，比公式快） |

**选择原则**：能在数据集里算的（分组、汇总、过滤）就不要用单元格公式——
帆软对数据列有引擎级优化，公式格是逐格求值。公式只用在"跨格运算"上（占比、差额、同比）。

## 二、公式语法必须遵守的三条

1. **以 `=` 开头**。不带 `=` 会被当文本；校验器会给 `FORMULA_EQ` 警告。
2. **单元格引用用 A1 记法**，范围 `A1:B10`；引用别的 sheet 的语法本项目未取证，不要生成。
3. **扩展后取值**（父格定位）形如 `D3[B3:-1]A`，官方模板里有，但生成器不主动产出；
   `cpt_analyze.py` 解析公式时会把 `D3` 认成单元格引用、把 `[...]A` 原样保留在表达式里。

函数方面：`sum/avg/count/max/min/if/round/abs/left/right/len/concat/inarray` 都在官方模板里出现过。
拿不准就用最朴素的写法，别自创函数名——帆软不认识会渲染成 `#NAME?` 且不报错。

## 三、参数的三套声明与「同名隐式绑定」

帆软里叫"参数"的东西有三套，**靠同名隐式绑定**，这是最常出错的地方：

| 种类 | 位置 | 谁消费 |
|---|---|---|
| 模板参数（面板） | `WorkBook/ReportParameterAttr/ParameterUI` 里的控件 | 预览时顶部查询栏 |
| 数据集参数 | `TableData/Parameters/Parameter` | SQL 里的 `${name}` |
| 公式里的 `$name` | 单元格公式文本 | 求值时的参数上下文 |

生成器的策略（重要，和规范 6.1 一致）：

- **不生成参数面板控件。** 6.1 明确"查询条件均需提取至平台，严禁使用帆软参数面板"，
  所以查询条件由平台的搜索栏负责，模板只消费参数值。
- **SQL 里出现 `${x}`，必须同时生成 `Parameters/Parameter name="x"`**，否则运行期取不到值。
  校验器有两条对称检查：`SQL_PARAM_UNDECLARED`（用了没声明）、`SQL_PARAM_UNUSED`（声明了没引用）。
- **默认值**写 `Parameter/O` 的 CDATA（语料里 `地区 = 华东` 就是这么存的）。
  日期参数按规范 4.x 的命名：`bizdate`（yyyymmdd）/ `biz_date`（yyyy-mm-dd）/ `biz_1d_ago`（前一天）。

## 四、数字与文本的分型——公式翻车的头号原因

`<O>` 的 `t` 决定类型：`I` 整数、`D` 浮点、`BigDecimal` 小数、无 `t` = 文本。
**文本参与 `sum()` 会得到 0，而且不报错。** 生成侧的处理：

- 内置数据集按列类型给行值（`integer/double/decimal` → 数值；`string` → 文本）；
- Python 的 `int`/`float` → `Number`（`t=I`/`t=D`），`str` → `Text`；
- 混合列（既有数字又有空/文本）一律按文本，公式里需要 `value()` / `tonumber()` 显式转换；
- 分析时 `cpt_analyze.py` 用列类型判断"维度 vs 度量"，SQL 数据集则从 `sum(...) AS 别名` 里猜数值列。

## 五、参数化 SQL 的两种写法与取舍

```sql
-- ① 数据集参数（推荐）：模板自带声明，换环境只有连接名不同
SELECT 地区, SUM(销量) AS 销量 FROM 销量 WHERE dt = '${biz_date}' GROUP BY 地区
```

```sql
-- ② 平台侧拼参数：SQL 里写死，由平台查询条件替换
SELECT 地区, SUM(销量) AS 销量 FROM 销量 WHERE dt = '2025-01-01' GROUP BY 地区
```

生成器只做 ①。② 等于把值写死在模板里，跨环境会错，且审计时看不出参数来源。

## 六、已知不确定项

1. 跨 sheet 单元格引用（`sheet2!A1`）的语法没有官方样本，未取证、不生成。
2. `$op='view'` 这个参数由平台注入，注入方式（URL / 系统变量）不在规范文本里。
3. 日期类型不进内置数据集（`RowData` 的日期序列化没有可靠样本），一律按字符串。
4. `FormulaCondition` 里的表达式求值上下文（是否可以看到父格）未在语料里验证过。
