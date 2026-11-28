# 数据源 / 数据集：定义、调试与业务逻辑沉淀

本文回答第二件事：模板里的数据是怎么挂上去的、出问题怎么定位、以及 400 份官方模板背后
反复出现的业务模式是什么。协议细节见 `01-cpt-protocol.md`。

## 1. 三层数据模型

```
① 平台层数据连接        ② 模板层数据集            ③ 单元格绑定
   (URL/驱动/账号)          (SQL 文本 或 内置数据表)     (数据列 + 扩展 + 分组/汇总)
   ─────────────────       ─────────────────────      ─────────────────────
   FRDemo  ──────────►  ds1: SELECT … ${地区}  ──►  A3: O t="DSColumn" dsName="ds1" columnName="地区"
   (不在 CPT 里)            (TableDataMap)              + Expand dir="0" + RG FunctionGrouper
```

这条链路有三个「名字」，任何一层对不上都会出现「模板正常但没数据」：

1. 连接名（`NameDatabaseConnection/DatabaseName`）必须与平台「数据连接」里的名字完全一致，
   区分大小写；
2. 数据集名（`TableDataMap/TableData@name`）必须与单元格 `dsName` 一致；
3. 列名（`columnName`）必须与 SQL 结果列名 / 内置数据集列名一致，别名也算（`SUM(x) AS 总销量`
   之后列名是 `总销量`）。

## 2. 数据连接（平台侧）

- **不在 CPT 里**。模板只写一个名字，例如 `<DatabaseName>FRDemo</DatabaseName>`。
- FR10 放在 `WEB-INF/embed/finedb`（H2/HSQL 配置库）；FR9 及更早在
  `WEB-INF/resources/datasource.xml`。本机安装里 `resources/` 只剩 `plugin_trail.info`，
  说明连接是建在配置库里的。
- `FRDemo` 是安装自带的示例库（FineReport 内置演示数据源），语料里 343 处引用它。
- 推论（对生成器很重要）：**想做出「拷到任何机器都能跑」的模板，就别用 SQL 数据集**，
  改用内置数据集——数据随模板走，零外部依赖。这也是 `examples/demo-config.json` 里
  `ds1` 用内置、`ds2` 只用来说明 SQL 形态的原因。

## 3. 数据集类型

### 3.1 SQL 数据集（`com.fr.data.impl.DBTableData`）

```xml
<TableData name="ds1" class="com.fr.data.impl.DBTableData">
  <Parameters>
    <Parameter><Attributes name="地区"/><O><![CDATA[华东]]></O></Parameter>
  </Parameters>
  <Attributes maxMemRowCount="-1"/>
  <Connection class="com.fr.data.impl.NameDatabaseConnection">
    <DatabaseName><![CDATA[FRDemo]]></DatabaseName>
  </Connection>
  <Query><![CDATA[SELECT * FROM [销量]A WHERE 地区 ='${地区}']]></Query>
  <PageQuery><![CDATA[]]></PageQuery>
</TableData>
```

| 节点 | 语义 | 注意 |
|---|---|---|
| `Query` | SQL 本体 | `${参数名}` 是**数据集参数**占位符；直接写死值也可以 |
| `Parameters/Parameter` | 数据集参数声明 + 默认值 | 声明了就必须在 SQL 里被 `${}` 引用，否则是脏配置 |
| `Attributes@maxMemRowCount` | 内存驻留行数上限 | `-1` = 不限（语料 273/273 都是 -1） |
| `PageQuery` | 分页 SQL（大数据量分页优化） | 可空；老模板没有这个节点 |
| `Connection` | 连接名引用 | 见第 2 节 |

`Query` 里的方言细节（`[销量]A` 这种写法）来自 FineReport 的「数据集表别名」语法，
换库时最容易崩的地方，生成器不做改写、原样保留。

### 3.2 内置数据集（`com.fr.data.impl.EmbeddedTableData`，即「内置数据集」）

数据直接编码进 CPT，**不需要任何数据库连接**，这是本项目生成器的主力。

| 节点 | 内容 |
|---|---|
| `ColumnNames` | 列名，分隔符 `,,.,,`（不是逗号！） |
| `ColumnTypes` | Java 类名，逗号分隔，顺序与列名一一对应 |
| `RowData` | 数据体：ascii85(裸deflate(UTF-8 行文本))，行 `\n` 分隔、字段 `\t` 分隔 |

支持的类型键（生成器 `COLUMN_TYPE_NAMES`）：`string / integer / long / double / decimal /
boolean`，分别落到 `java.lang.String / Integer / Long / Double / java.math.BigDecimal /
Boolean`。日期建议先按字符串存（`RowData` 的日期序列化格式没有在语料里得到可靠样本，
生成器刻意不猜）。

硬约束：

- 列名不要含逗号（`ColumnTypes` 用逗号分隔，会错位）；
- 每行字段数必须等于列数，少写会被静默当成空单元格；
- 单模板数据量建议控制在几万行以内——`RowData` 会在每次保存时整体重编码。

### 3.3 数据集引用（`com.fr.data.impl.NameTableData`）

```xml
<TableData class="com.fr.data.impl.NameTableData"><Name>Embedded1</Name></TableData>
```

只存一个名字，指向别处（另一数据集 / 平台服务器数据集）。语料里它连 `name` 属性都没有，
说明在官方模板中它是内部包装节点，不是常规入口。**结论：生成别名数据集这条路没有可靠样本
支撑，本项目的 `AliasDataset` 会在写出时保留 `name` 属性并标注为未验证项**，生产上请直接用
SQL 或内置数据集。

### 3.4 递归数据集（`com.fr.data.impl.RecursionTableData`，v10 新特性）

节点为 `markFields / parentmarkFields / markFieldsName / parentmarkFieldsName /
originalTableDataName`，用于把「父ID 结构」的平表转成树（折叠树报表）。语料只有 1 例，
本项目只读不写。

### 3.5 插件数据集

`fine-core` 里已有实现，class 名即协议：`JSONTableData`（json 插件）、`ExcelTableData`、
`XMLTableData`、`TextTableData`、`FileTableData`、`MultiTDTableData`（多源合并）、
`UnionTableData`。它们的 XML 结构与上面同构（`Parameters` + 各自的内容节点），
换 class 名 + 对应内容节点即可。本机还装了 `com.fr.plugin.db.json.v10-9.5.11` 插件，
说明 JSON 数据集在本机可用。

## 4. 三种「参数」别混

| 种类 | 存在位置 | XML 形态 | 生效方式 |
|---|---|---|---|
| 模板参数 | `WorkBook/ReportParameterAttr` | 参数面板（`FormParameterUI` + `WParameterLayout` + 控件） | 预览时顶部出现查询栏，`?地区=华东` 或控件提交 |
| 数据集参数 | `TableData/Parameters/Parameter` | `<Attributes name="地区"/><O><![CDATA[默认值]]></O>` | 被 SQL 里 `${地区}` 消费 |
| 公式参数 | 单元格 `O t="XMLable" class="com.fr.base.Formula"` | `<Attributes><![CDATA[=…]]></Attributes>` | 单元格求值 |

常见错配：**在参数面板里加了「地区」，但数据集里没声明 `Parameter`，SQL 里的 `${地区}` 就取不到值**。
面板参数（`ReportParameterAttr`）与数据集参数（`TableData/Parameters`）是两套声明，靠**同名**隐式
绑定。`GettingStarted.cpt` 就是标准做法：面板里放 `ComboBox name="地区"`，`ds1` 里声明
`Parameter name="地区"` 默认 `华东`，SQL 里 `WHERE 地区='${地区}'`。

参数面板的 XML 结构（`GettingStarted.cpt`）：

```xml
<ReportParameterAttr>
  <Attributes showWindow="true" delayPlaying="true" windowPosition="1" align="1" useParamsTemplate="false"/>
  <PWTitle><![CDATA[参数]]></PWTitle>
  <ParameterUI class="com.fr.form.main.parameter.FormParameterUI">
    <Parameters/>
    <Layout class="com.fr.form.ui.container.WParameterLayout">
      <WidgetName name="para"/>
      <Widget class="com.fr.form.ui.container.WAbsoluteLayout$BoundsWidget">
        <InnerWidget class="com.fr.form.ui.ComboBox">
          <WidgetName name="地区"/>
          <Dictionary class="com.fr.data.impl.DatabaseDictionary">…</Dictionary>
          <widgetValue><O><![CDATA[华东]]></O></widgetValue>
        </InnerWidget>
        <BoundsAttr x="80" y="10" width="140" height="23"/>
      </Widget>
      …
    </Layout>
  </ParameterUI>
</ReportParameterAttr>
```

## 5. 业务逻辑沉淀（400 份官方模板归纳）

### 5.1 报表模式 → XML 特征对照表

| 业务模式 | 单元格/绑定特征 | 关键 XML | 语料出现 |
|---|---|---|---|
| 明细报表（行式） | 表头普通文本 + 数据行 `DSColumn` 无 `RG` | `<O t="DSColumn"><Attributes .../><Complex/><Parameters/></O>` + `<Expand dir="0"/>` | `Details.cpt` 等 |
| 分组报表 | 分组列 `FunctionGrouper`，右侧列跟随 | `RG class="…FunctionGrouper"` + 子单元格 `Expand dir="0" left="A2"` | `Group.cpt`、`纵向分组报表.cpt` |
| 分组汇总 | 汇总格 `SummaryGrouper` + `FN`，**不带 Expand** | `<RG class="…SummaryGrouper"><FN>com.fr.data.util.function.SumFunction</FN></RG>` | 分组报表常态 |
| 交叉报表 | 一行方向 `dir="0"`、另一方向 `dir="1"`，交点格汇总 | 同一格上 `Expand dir` 决定维度方向 | `Cross.cpt`、`交叉报表—数据双向扩展.cpt` |
| 主子表 / 联动 | 子表数据列带 `CommonCondition`，比较对象是 `SimpleDSColumn` | `<Condition class="com.fr.data.condition.CommonCondition"><CNAME>销售员</CNAME><Compare op="0"><SimpleDSColumn dsName="ds1" columnName="销售员"/></Compare></Condition>` | `GettingStarted.cpt` 第 3 列 |
| 参数查询 | 面板控件 + 数据集参数同名 | 见第 4 节 | `Parameter/*.cpt` |
| 扩展后排序 | `Expand order=` 或 `SortFormula` | `<Expand order="1"><SortFormula><![CDATA[=inarray(A2,自定义顺序.select(地区顺序))]]></SortFormula></Expand>` | `利用内置数据集实现自定义排序.cpt` |
| 条件高亮 | 单元格 `HighlightList` | `Highlight[com.fr.report.cell.cellattr.highlight.DefaultHighlight]` | 234 次 |
| 图表 | `O t="CC"`，`ChartDefinition` 里 `Series/Category` 用 `=C3` 这类单元格引用 | `<SeriesValue><O t="XMLable" class="com.fr.base.Formula"><Attributes>=C4</Attributes></O></SeriesValue>` | 图表类模板 |
| 填报 | `ReportWriteAttr/SubmitVisitor[BuiltInSQLSubmiter]/DMLConfig` | `ColumnConfig/ColumnRow` 映射 | 297 次 |
| 折叠树 | 分组列 + 条件属性「折叠树」 | `Highlight` + JS | `TreeReport.cpt` |

### 5.2 版式坐标语义

官方模板几乎都遵循同一套坐标约定，生成器也照此产出，便于人接手：

| 行 | 语义 | 典型 XML |
|---|---|---|
| 第 1 行 | 大标题，`cs` 横跨整表 | `cs="4"` + 粗体大字 `size="120"` |
| 第 2 行 | 表头 | 背景色 + 边框，普通文本 |
| 第 3 行起 | 数据行 | `DSColumn`，表头正下方一列对一列 |
| 最后一行 | 合计 | 汇总格 `SummaryGrouper` + `Text("合计")` |

父子格规则（决定数据怎么长）：
- 纵向分组：分组列 `Expand dir="0"`，右侧列 `Expand dir="0"` 且**默认**左父格 = 左侧最近的分组列；
- 想断开父子关系就显式写 `leftParentDefault="false"` 并给出 `left="A2"`；
- 汇总格永远不扩展（`<Expand/>`），否则会被当成明细列展开。

### 5.3 生成器对这些规则的落地

Excel 里的占位符直接映射到上面的模式（`tools/xlsx2cpt.py`）：

| 占位符 | 产出 |
|---|---|
| `{{ds1.地区}}` | `DSColumn` 列表扩展 + `Expand dir="0"` |
| `{{ds1.地区|group}}` | `DSColumn` + `RG FunctionGrouper` + `Expand dir="0"` |
| `{{ds1.地区|group|right}}` | 同上但 `dir="1"`（横向分组，交叉报表的一维） |
| `{{ds1.销量|sum}}` | `DSColumn` + `RG SummaryGrouper/FN`，无 `Expand` |
| `{{ds1.销量|count/avg/max/min}}` | 对应 `FN` 类名 |
| `{{=A2+B2}}` | `O t="XMLable" class="com.fr.base.Formula"` |
| `{{text:合计：}}` | 纯文本（防止被误识别为绑定） |

---

## 6. 调试清单（症状 → 定位 → 修复）

用 `python tools/cpt_dump.py 文件.cpt` 就能看到本文提到的全部结构（含数据集解码后的行），
校验器会直接报出下面大部分问题。

| # | 症状 | 定位点 | 修复 |
|---|---|---|---|
| 1 | 设计器能打开，预览一片空白 | `CellElementList` 是否为空；`Expand` 是否被设成不扩展 | 给数据列加 `Expand dir="0"` |
| 2 | 报「数据集 xxx 不存在」 | 平台是否有该连接/服务器数据集；`TableDataMap` 里是否有该 `name` | 补连接，或改 `dsName`；离线模板改用内置数据集 |
| 3 | 只显示一行 / 不展开 | 单元格 `Expand` 缺 `dir`，或被 `RG SummaryGrouper` 变成聚合 | 明细列去掉汇总、补 `dir="0"` |
| 4 | `sum()` 结果是 0 | 数值被写成文本（`<O><![CDATA[120]]></O>` 而不是 `<O t="I">120</O>`） | 改 `t="I"/"D"/"BigDecimal"` |
| 5 | 列错位 / 表格塌了 | `cs`/`rs` 与相邻 `C` 坐标冲突；被合并区域里还写了 `C` | 合并只留左上角一格，删掉被覆盖格 |
| 6 | 样式丢失或全表一个样 | `s` 下标 ≥ `StyleList` 长度；或用了样式库引用 `<Style index="n"/>` | 补齐 `StyleList`；样式库引用要保证服务器上存在 |
| 7 | 参数填了不生效 | 面板参数与数据集参数**不同名**；或 SQL 没写 `${参数}` | 两处同名，SQL 里引用 |
| 8 | 中文乱码 | CPT 不是 UTF-8；或 `RowData` 被当明文改写 | 保存为 UTF-8；内置数据集用工具重新编码 |
| 9 | 打开报 XML 解析错 | CDATA 里出现 `]]`（帆软转义规则是 `]]` → `]]A`） | 用工具生成，已自动处理 |
| 10 | 排序不对 | 需要 `Expand order=` 或 `SortFormula`；分组内排序要按父格 | 见 5.1「扩展后排序」 |
| 11 | 子表不跟随父格 | 缺 `CommonCondition` + `SimpleDSColumn`，或父格没设 `left` | 两个数据集建条件关联 |

### 具体操作流程

```powershell
# 1. 看结构 + 数据集解码 + 校验
python tools\cpt_dump.py 你的.cpt

# 2. 生成后再自检（含帆软编解码器验证 + 属性词汇表比对）
python tools\xlsx2cpt.py examples\demo-config.json
python tools\verify_generated.py out\demo-generated.cpt

# 3. 故意做坏的对照实验，看清每个报错长什么样
python examples\make_broken.py
python tools\cpt_dump.py out\broken.cpt
```

`out/broken.cpt` 是刻意注入 4 个缺陷的样本，校验器输出：

```
WARNING EMB_ROW_ARITY: ds1 第 7 行有 2 个值，列定义是 4 个 [ds1]
ERROR   STYLE_INDEX: A2 引用样式 99，但 StyleList 只有 6 项 [sheet1]
ERROR   DS_COLUMN_MISSING: B3 绑定列 '销售员姓名' 不在 ds1 中（现有: 地区, 销售员, 产品, 销量） [sheet1]
WARNING MARKER_LEFT: A4 仍有未解析的占位符: '{{ds1.不存在的列}}' [sheet1]
```

每条都带单元格坐标和可选值列表，改完即闭。

## 7. 明确的不确定项

诚实标注，避免把猜测当结论：

1. **垂直对齐的边界语义**：`TOP=1 / BOTTOM=3 / CENTER=0` 已从常量确认，但「未设置」与
   「显式居中」在渲染上是否等价，没有通过运行验证。
2. **`PageQuery` 的必需性**：老模板没有该节点也能用，生成器默认写空 `<PageQuery><![CDATA[]]></PageQuery>`。
3. **`AliasDataset`（`NameTableData` 带 `name` 属性）**：语料里没有先例，属未验证写法。
4. **`RowData` 里日期类型的序列化**：没有可靠样本，生成器不做日期类型。
5. **字体度量**：Excel 列宽（字符）→ 像素用了 Calibri 11 的标准公式（`w*7+5`），
   与原表用的字体不同时会有几像素偏差，可在 config 里显式给 `col_width` 覆盖。
