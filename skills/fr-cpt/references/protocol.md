# 帆软 CPT（FineReport 10 报表模板）协议解析

> 证据基准：本机 `D:\Tools\FineReport_10.0` 自带 1473 份官方模板，取 400 份建语料库（`corpus/`）
> 做结构统计（结果落在 `out/paths.tsv`、`out/classes.tsv`），并对 `fine-core-10.0.jar` /
> `fine-third-10.0.jar` / `fine-report-engine-10.0.jar` 做字节码级确认。凡本文给出的数字与
> 量纲，均可在对应 jar 里用 `javap` 复核。

## 0. 样本身份

| 文件 | 大小 | SHA256 | xmlVersion | releaseVersion | 结构 |
|---|---|---|---|---|---|
| `samples/Test1.cpt` | 1354 B | `8C2F1852…C9AE0` | 20211223 | 10.0.0 | 1 sheet / 1 空单元格 / 无 TableDataMap / 无移动端属性 |
| `samples/Test2.cpt` | 1647 B | `3F7D8794…330059` | 20211223 | 10.0.0 | 同上 + `ElementCaseMobileAttr` |

两份都是「新建空白模板」。真实差异只有两处：

1. `Test2` 多一个 `<ElementCaseMobileAttr>`（移动端渲染参数：缩放、刷新、全屏等）；
2. `TemplateIdAttMark/@TemplateId` 的 GUID 不同（每次新建随机）。

两者都**没有** `TableDataMap`（数据源/数据集）、`StyleList` 为空、单元格值为空。
也就是说：这两份样本只能证明「模板外壳」的协议，数据源与数据集部分需要从官方模板取证——
本文第 4、5 节即来自 `doc/Primary/...`、`GettingStarted.cpt` 等真实模板。

正文里出现的 `<C>` 等节点，`Test1.cpt` 的最小形态就是一行：

```xml
<CellElementList>
  <C c="0" r="0"><PrivilegeControl/><Expand/></C>
</CellElementList>
```

---

## 1. 根节点与一级子节点

根节点固定是 `WorkBook`，两个属性 `xmlVersion`（模板格式版本）与 `releaseVersion`（设计器版本）。
一级子节点按 400 份语料统计（出现次数）：

| 节点 | 命中 | 作用 | 可省 |
|---|---|---|---|
| `Report` | 404 | 一个 sheet（工作簿页）；404 > 400 说明有模板多 sheet | 否 |
| `ReportParameterAttr` | 400 | 参数面板定义（`Parameters` + `ParameterUI`） | 可省（两个样本就没有） |
| `StyleList` | 400 | 样式表，单元格用 `s="下标"` 引用 | 否（可为空 `<StyleList/>`） |
| `DesignerVersion` | 399 | `DesignerVersion="KAA"` | 可 |
| `PreviewType` | 399 | `PreviewType="0"` | 可 |
| `TableDataMap` | 377 | **数据集容器**（0 个数据集时整个节点不出现） | 可 |
| `ReportWebAttr` | 284 | 网页端工具栏/分页/适配 | 可 |
| `TemplateIdAttMark` | 157 | 模板 GUID | 可 |
| `TemplateID` | 59 | 老版本模板 ID | 可 |
| `ElementCaseMobileAttr` | 48 | 移动端属性（Test2 有、Test1 无） | 可 |
| `ReportFitAttr` | 26 | 页面自适应 | 可 |
| `TemplateCloudInfoAttrMark` | 11 | 云分析插件写入的元信息 | 可 |

结论：**只有 `Report` + `StyleList` 是必需的**，其余全部可选。生成器按帆软自己的书写顺序输出
（`TableDataMap → ReportWebAttr → ElementCaseMobileAttr → Report → ReportParameterAttr →
StyleList → DesignerVersion → PreviewType → TemplateIdAttMark`），因为读取端是按标签名分派、
顺序无关，但保持与厂商一致便于人工 diff。

---

## 2. 报表层（`Report`）

### 2.1 三种 `Report@class`

| class | 含义 |
|---|---|
| `com.fr.report.worksheet.WorkSheet` | 普通报表的 sheet（CPT 主体，`name="sheet1"`） |
| `com.fr.report.WorkSheet` | 决策报表（FRM）里的报表块容器；内部再套 `ElementCase[com.fr.report.SingleBlock]` |

一个 CPT 可以有多个 `Report`，`name` 即 sheet 名（语料中出现 `name="销售详情"`、`name="总销售情况"`），
名字必须唯一。

### 2.2 网格尺寸

```xml
<RowHeight defaultValue="723900"><![CDATA[723900,723900,...]]></RowHeight>
<ColumnWidth defaultValue="2743200"><![CDATA[2743200,...]]></ColumnWidth>
```

`defaultValue` 是未列出行的兜底值；CDATA 里是逐行/逐列的**整数数组**，长度 = 该方向单元格数。
单位见第 3 节（FU）。默认值 723900 FU = 19px，2743200 FU = 72px。

### 2.3 单元格 `C`

```xml
<C c="0" r="0" cs="4" rs="2" s="0">
  <O>…值…</O>
  <PrivilegeControl/>
  <Expand/>
</C>
```

| 属性 | 含义 |
|---|---|
| `c` / `r` | **0 基**的列/行下标（不是 A1 记法） |
| `cs` / `rs` | 跨列/跨行（合并单元格），缺省 1 |
| `s` | `StyleList` 里的**位置下标** |

合并单元格只写左上角那一个 `C`，被覆盖的格子**不出现**。`PrivilegeControl` 与 `Expand`
几乎是每个格子的标配（`PrivilegeControl` = 单元格权限控制，空即无限制）。

### 2.4 值节点 `O` 的全集

`O` 是「单元格值」的多态容器，`t` 决定类型（括号内是 400 份语料里的命中数）：

| `t` | 含义 | 形态 |
|---|---|---|
| 无（纯文本） | 字符串常量 | `<O><![CDATA[地区]]></O>` （2976） |
| `DSColumn` | **数据列绑定**（数据集列） | 见 2.5（927） |
| `I` | 整数 | `<O t="I">120</O>` （314） |
| `D` | 浮点（Double） | `<O t="D">1.1091</O>` （37） |
| `BigDecimal` | 高精度小数 | `<O t="BigDecimal">…</O>` （86） |
| `XMLable` + `class="com.fr.base.Formula"` | 公式（新写法） | `<O t="XMLable" class="com.fr.base.Formula"><Attributes><![CDATA[=sum(C4)]]></Attributes></O>` （203） |
| `Formula` + `class="Formula"` | 公式（旧写法，FR8/9） | `<O t="Formula" class="Formula"><Attributes>…</Attributes></O>` （532） |
| `CC` | 单元格图表 | 内含 `Chart[com.fr.plugin.chart.vanchart.VanChart]/…`（209） |
| `BiasTextPainter` | 斜线单元格 | `<IsBackSlash value="false"/>` + `A|B|C` |
| `Image` / `RichText` | 图片 / 富文本 | 少见 |

要点：**数字不是文本**。`I` / `D` / `BigDecimal` 才是数值型，写错类型会让公式 `sum()` 得到 0
（这是生成器最容易踩的坑之一）。

### 2.5 数据列绑定 `DSColumn`

```xml
<O t="DSColumn">
  <Attributes dsName="ds1" columnName="产品"/>
  <Condition class="com.fr.data.condition.CommonCondition">…</Condition>   <!-- 可选：过滤 -->
  <Complex/>
  <RG class="com.fr.report.cell.cellattr.core.group.FunctionGrouper"/>      <!-- 可选：分组 -->
  <Result>…</Result>                                                       <!-- 可选：结果集筛选 -->
  <Parameters/>
</O>
```

子节点顺序固定为 `Attributes → [Condition] → Complex → [RG] → [Result] → Parameters`。
语料的形态分布（`out/schema_stats`）：

| 子节点组合 | 命中 | 语义 |
|---|---|---|
| `Attributes+Complex+RG+Parameters` | 708 | 分组列（最常见的分组报表首列） |
| `Attributes+Complex+Parameters` | 21 | 列表列（明细展开，不分组） |
| `Attributes+Condition+Complex+RG+Result+Parameters` | 153 | 带过滤 + 结果集筛选 |

### 2.6 `Expand`（扩展方向与父子格）

```xml
<Expand dir="0"/>                                        <!-- 纵向扩展 -->
<Expand dir="1"/>                                        <!-- 横向扩展 -->
<Expand/>                                                <!-- 不扩展 -->
<Expand dir="0" leftParentDefault="false" left="A2"/>    <!-- 显式指定左父格 -->
<Expand order="1"><SortFormula><![CDATA[=inarray(A2,x)]]></SortFormula></Expand>
```

- `dir`：`0` 纵向（数据行向下长），`1` 横向（数据列向右长）；语料里 `dir=0` 812 次、`dir=1` 46 次。
- 父格：不写 `left`/`up` 时按「默认父格」规则（上方最近的、同方向的扩展格）。写 `left="A2"`
  就是显式指定，此时 `leftParentDefault="false"` 必须同时出现。
- `order` + `SortFormula`：扩展后排序。

### 2.7 `RG`（分组/汇总）

| class | 语义 |
|---|---|
| `com.fr.report.cell.cellattr.core.group.FunctionGrouper` | 分组（相同值合并显示），793 次 |
| `com.fr.report.cell.cellattr.core.group.SummaryGrouper` | 汇总，内部 `<FN>` 指定算法，108 次 |
| `com.fr.report.cell.cellattr.core.group.CustomGrouper` | 自定义分组，5 次 |

`<FN>` 取值：`com.fr.data.util.function.SumFunction`（103）、`CountFunction`（3）、
`AverageFunction`（2）——即类名即算法，可据此直接推导 `MaxFunction` / `MinFunction`。

**汇总格不能设扩展方向**，分组格的 `Expand` 才带 `dir`。

### 2.8 `Condition`（数据集过滤）

| class | 用途 |
|---|---|
| `com.fr.data.condition.CommonCondition` | 普通条件（`CNAME` 列名 + `Compare op=` + 比较对象） |
| `com.fr.data.condition.ListCondition` | 列表/多值 |
| `com.fr.data.condition.FormulaCondition` | 公式条件 |
| `com.fr.data.condition.ObjectCondition` | 对象比较 |

`Compare op="0"` 是「等于」，右侧可以是 `<SimpleDSColumn dsName="ds1" columnName="销售员"/>`
（跨数据集关联），也可以是常量。这是「子表跟随父格过滤」的实现方式。

### 2.9 样式 `StyleList` / `Style`

```xml
<StyleList>
  <Style horizontal_alignment="0" imageLayout="1">
    <Format class="com.fr.base.CoreDecimalFormat">#,##0</Format>
    <FRFont name="SimSun" style="0" size="72" foreground="-16777216"/>
    <Background name="ColorBackground" color="-1"/>
    <Border>
      <Top style="1" color="-6697729"/>
      <Bottom style="1" color="-6697729"/>
      <Left style="1" color="-6697729"/>
      <Right style="1" color="-6697729"/>
    </Border>
  </Style>
</StyleList>
```

- `<Style index="0"/>` 是**样式库引用**（82 次），此时内容为空，真正定义在服务器样式库里；
  `<Style style_name="…">` 是命名样式（5 次）。这两种情况下单元格的 `s` 下标可能大于本地
  `StyleList` 长度 —— 校验器据此单独判定，不当成错误。
- 顺序敏感：`s` 是**位置下标**，所以读改写时必须原样保留顺序、且**不能去重**
  （本项目早期版本去重导致 54 份模板的样式下标错位，已修，见 `tools/corpus_roundtrip.py`）。

---

## 3. 量纲与常量（协议里最容易搞错的部分）

全部来自 `com.fr.stable.Constants` / `com.fr.base.FRFont`，可用 `javap -constants` 复核。

| 量 | 单位 | 证据 |
|---|---|---|
| 行高 / 列宽 | **FU**：1 pt = 50800 FU；1 老像素 = 38100 FU | `FU_PER_PT=50800`、`FU_PER_OLD_PIX=38100`；默认 723900=19px、2743200=72px 完全整除 |
| 字号 | **pt × 8** | `FRFont.SCALE_TO_FRSIZE=8`、`FONT_SIZE_SCALE=1000`、`convert4TplFrSize(x)=x*125`（1000/8=125） |
| 颜色 | 有符号 32 位 ARGB | `color="-1"` 白、`-16777216` 黑、`-6697729` = `0xFF99CCFF` |
| 水平对齐 | `CENTER=0`、`LEFT=2`、`RIGHT=4` | `com.fr.stable.Constants` |
| 垂直对齐 | `TOP=1`、`CENTER=0`、`BOTTOM=3` | 同上 |
| 边框线型 | `0 无 / 1 细 / 2 中 / 3 虚 / 4 极细 / 5 粗 / 6 双 / 7 点` | `LINE_NONE…LINE_DOT` |

字号换算的实测校准：默认样式 `size="72"` → 9pt；标题 `size="120"` → 15pt；
图表标题 `size="128"` → 16pt。语料里出现的字号几乎全是 8 的倍数，这是 ×8 的直接证据。

---

## 4. 数据集层（`TableDataMap`）

```xml
<TableDataMap>
  <TableData name="ds1" class="com.fr.data.impl.DBTableData">…</TableData>
  <TableData name="ds2" class="com.fr.data.impl.EmbeddedTableData">…</TableData>
</TableDataMap>
```

`name` 就是单元格 `dsName` 引用的名字。`class` 决定数据集类型，语料里出现的实现：

| class | 中文名 | 命中 | 说明 |
|---|---|---|---|
| `com.fr.data.impl.DBTableData` | 数据库查询（SQL） | 273 | 基于命名连接的 SQL |
| `com.fr.data.impl.EmbeddedTableData` | **内置数据集** | 182 | 数据直接存在 CPT 里 |
| `com.fr.data.impl.NameTableData` | 数据集引用 | 275 | 只存 `<Name>`，引用别处的数据集 |
| `com.fr.data.impl.RecursionTableData` | 递归数据集 | 1 | v10 新特性，树形递归 |

插件还带来 `JSONTableData`（json 插件）、`ExcelTableData` / `XMLTableData` / `TextTableData` /
`FileTableData`（`fine-core` 里的实现）等，class 名同理可用。

两类最常用的 XML 契约如下（细节与参数体系见 `02-datasets-and-debug.md`）。

### 4.1 SQL 数据集

```xml
<TableData name="ds1" class="com.fr.data.impl.DBTableData">
  <Parameters>
    <Parameter><Attributes name="地区"/><O><![CDATA[华东]]></O></Parameter>
  </Parameters>
  <Attributes maxMemRowCount="-1"/>
  <Connection class="com.fr.data.impl.NameDatabaseConnection">
    <DatabaseName><![CDATA[FRDemo]]></DatabaseName>
  </Connection>
  <Query><![CDATA[SELECT * FROM [销量]A where 地区 ='${地区}']]></Query>
  <PageQuery><![CDATA[]]></PageQuery>
</TableData>
```

**关键点：连接只存名字。** `NameDatabaseConnection/DatabaseName` 是引用，连接本体（URL、账号、
密码）不在 CPT 里，而在平台侧（FR10 是 `WEB-INF/embed/finedb` 配置库；老版本是
`WEB-INF/resources/datasource.xml`，本机安装里该文件已不存在，只有 `plugin_trail.info`）。
这就是「换台服务器模板连不上库」的根本原因。

### 4.2 内置数据集（唯一的二进制层）

```xml
<TableData name="自定义顺序" class="com.fr.data.impl.EmbeddedTableData">
  <Parameters/>
  <DSName><![CDATA[]]></DSName>
  <ColumnNames><![CDATA[地区顺序,,.,,销量]]></ColumnNames>
  <ColumnTypes><![CDATA[java.lang.String,java.lang.Integer]]></ColumnTypes>
  <RowData ColumnTypes="java.lang.String,java.lang.Integer"><![CDATA[…ASCII85…]]></RowData>
</TableData>
```

三个坑：

1. `ColumnNames` 的分隔符是 **`,,.,,`** 而不是逗号（列名本身可能含逗号）；`ColumnTypes` 用逗号。
2. `RowData` 是**压缩+编码**后的字符串，不是明文。
3. 类型名是 Java 类名（`java.lang.String` / `java.lang.Integer` / `java.math.BigDecimal`…）。

`RowData` 算法（`com.fr.stable.xml.XMLEncodeUtils`，逐行字节码确认）：

```
行文本  = 每行用 "\t" 连接字段，行间用 "\n" 连接；字段内的 \t / \n 转义为 &t; / &n;
字节    = 行文本.getBytes("UTF-8")
压缩    = Deflater(level=9, nowrap=true)          // 裸 deflate，无 zlib 头
编码    = Ascii85（字符 '!'(0x21)…'u'(0x75)，零组用 'z'，每 72 字符换行，结尾 '~' + '\n'）
结果    = new String(bytes, "ISO-8859-1")
```

本项目的 `tools/frcodec.py` 是这个算法的 Python 移植，并已与帆软自己的代码做过**双向字节级**
对齐验证（`tools/verify_codec.py`：22 个探针 0 偏差；帆软能解我们生成的 blob；帆软重编码结果
与我们一致）。

历史包袱：`corpus` 里有 116 个 `RowData` 连帆软自己的 `decodeStringAsBytes` 都解不出来
（该方法内部 catch 所有异常并返回空数组），说明老版本写过一种现在的读端不认的格式。
生成端不必兼容它，但 read 时要把这种情况显式报出来，而不是静默当成空数据集。

---

## 5. 版本差异与兼容

| xmlVersion | 观察到的 releaseVersion | 特征 |
|---|---|---|
| 20110221 | 无 | `Report class="com.fr.report.WorkSheet"`（旧包名）、`RG class="com.fr.report.cellElement.core.FunctionGrouper"` |
| 20141222 / 20151125 | 8.0.0 | 有 `PageQuery` 缺失、`<O t="Formula" class="Formula">` |
| 20170715 / 20170720 | 9.0.0 / 10.0.0 | 现代形态，`com.fr.base.Formula`、`cellattr.core.group.*` |
| 20211223 | 10.0.0 | 当前（两份样本即此版本） |

两处包名迁移必须注意：

1. `RG@class`：`com.fr.report.cellElement.core.XxxGrouper`（旧）→
   `com.fr.report.cell.cellattr.core.group.XxxGrouper`（新）。读端两种都要认，写端用新包名。
2. 公式：`<O t="Formula" class="Formula">`（旧）→ `<O t="XMLable" class="com.fr.base.Formula">`（新）。

---

## 6. CPT 里「没有」的东西

明确列出，避免在模板里找不存在的配置：

- **数据库连接本体**（URL/驱动/账号/密码）——只有连接名引用。
- **平台级服务器数据集**——只被引用（`dsName`），本体在服务器上；语料里就有 4 份模板的
  `TableDataMap` 为空却绑定了 `staff` / `员工信息表`。
- **权限/角色/用户**——`PrivilegeControl` 只存「是否启用细粒度权限」的标记，规则在平台。
- **调度任务、导出模板、缓存策略**——在平台配置里。

理解了这条边界，才能解释「模板能打开但数据出不来」这类问题：症结几乎总在平台侧。
