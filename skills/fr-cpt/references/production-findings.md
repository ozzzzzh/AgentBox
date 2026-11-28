# 生产模板实测：两份真实 CPT 的解剖

样本：`samples/production/hr_structure.cpt`（境外人力资源结构分析表，260 KB）、
`samples/production/roe_entry.cpt`（ROE 分析填报，802 KB）。均为 `xmlVersion 20211223 /
releaseVersion 10.0.0`，连接 `生产环境Greenplum`。

这两份把官方示例模板**没有**的东西全带出来了：单元格填报控件、多条提交规则、
`ColumnRowGroup`、插件属性节点、三 sheet 架构。本文记录实测结论和据此做的模型补齐。

## 一、两份表长什么样

| | 人力资源结构分析表 | ROE 分析填报 |
|---|---|---|
| sheet | 3 个：`1-境外人力资源结构分析表Monthly report` / `系统取数` / `企业填报` | 1 个：`sheet1` |
| 单元格 | 554 / 565 / 562 | 922 |
| 数据集 | 3 个（全部 DBTableData） | 8 个（全部 DBTableData） |
| 样式 | 9 | 26 |
| 填报 | `ReportWriteAttr` 为空（纯查询） | **5 条 SubmitVisitor**，目标 3 张表 |
| 单元格控件 | 0 | **105 个 TextEditor** |
| 参数 | `reportDate`、`companyName` | `reportDate`、`prevQuarterEndDate`、`prevPrevQuarterEndDate` + 2 个控件参数 |

**三 sheet 架构**（人力资源表）是生产填报类报表的典型做法：一个 sheet 给终端用户看
（`1-…Monthly report`），另外两个分别承载`系统取数`与`企业填报`，用单元格/超链/条件属性
在同一个模板里切换用途。生成器目前按单 sheet 产出，多 sheet 需要配方里写成 `sheets[]`。

## 二、数据集与连接：三个实测坑

### 1. 连接名带前导换行

```xml
<Connection class="com.fr.data.impl.NameDatabaseConnection">
  <DatabaseName><![CDATA[
生产环境Greenplum]]></DatabaseName>
</Connection>
```

`DatabaseName` 的 CDATA 里是 `"\n生产环境Greenplum"`——**开头有一个换行**。而同一个模板里
`SubmitVisitor/Attributes@dsName="生产环境Greenplum"` 又没有换行。说明帆软内部对连接名做了
trim，两边指向同一个连接。

我方处理：读的时候 `strip("\r\n")`（`_text_of`），写回时不带换行。语义一致；
但**对比文件时不要被这个换行骗了**——`connection` 名相等不等于字节相等。

### 2. 一个连接挂多个数据集，`maxMemRowCount` 恒为 -1

8 个数据集全用 `生产环境Greenplum`，`<Attributes maxMemRowCount="-1"/>`。生产上没有人调这个值。

### 3. 参数默认值可能是空串

`资产负债表/现金流量表/利润明细表` 的参数 `reportDate` 默认值是 `''`（空），
运行时由平台搜索栏注入。这意味着**数据集 SQL 必须能容忍空值**，否则预览直接报错。
人力资源表的 `reportDate` 默认 `2025-05`、`companyName` 默认 `全部`，是可预览的写法。

生成侧口径：参数给一个可预览的默认值（日期给上月或示例月），并保证 SQL 在空值时不会炸。

## 三、SQL 风格（PG/GP 实战）

- 一律带 **`WITH ... AS (...)` CTE** 或 `IN (...)` 硬编码公司清单（`entity_code IN ('2A01','2A03',…)`），
  不用 JOIN 维表——GP 上避免重分布。
- 金额统一 `COALESCE(x,0) * 10000`（**单位换算写进数据集**，不放到报表里算）。
- 时间取"次小 timekey"这种边界值，用 `ORDER BY … LIMIT 1 OFFSET 1` 子查询（ROE 的
  `公司数据时间边界`）——这正是 PG/GP 写法，印证了方言层里 `LIMIT/OFFSET` 的必要性。
- 表名前缀齐全：`ads.`（明细/汇总）、`dm_intern.`（填报落地表）。
- SQL 里带**作者/时间/变更记录的注释头**，生产模板普遍如此。

## 四、填报属性：真正的复杂度所在

ROE 的 `ReportWriteAttr` 里有 **5 个 `SubmitVisitor`**（差异性分析填报、改进措施填报、
自订科目填报_1…），分别写 3 张 `dm_intern` 表。三种 `ColumnConfig` 形态都出现了：

```xml
<!-- ① 单格映射 -->
<ColumnConfig name="improvement_method_produce" isKey="false" skipUnmodified="false">
  <ColumnRow column="2" row="54"/>
</ColumnConfig>

<!-- ② 多格映射：同名列对应 40+ 个格子 -->
<ColumnConfig name="diff_quarter" isKey="false" skipUnmodified="false">
  <ColumnRowGroup>
    <ColumnRow column="5" row="4"/>
    …（40+ 条）
  </ColumnRowGroup>
</ColumnConfig>

<!-- ③ 直接取控件值的公式（不是单元格映射） -->
<ColumnConfig name="entity_codea" isKey="true" skipUnmodified="false">
  <O t="XMLable" class="com.fr.base.Formula"><Attributes>=$comboBox0_companyA</Attributes></O>
</ColumnConfig>

<!-- ④ 命名参数：提交时算出来的键 -->
<ColumnConfig name="timekey" isKey="true" skipUnmodified="false">
  <Parameter>
    <Attributes name="prevQuarterEndDate"/>
    <O t="XMLable" class="com.fr.base.Formula"><Attributes>=IF(MONTH($reportDate)&lt;=3, …)</Attributes></O>
  </Parameter>
</ColumnConfig>
```

要点：

- `isKey="true"` 的列参与更新条件（`entity_codea + entity_codeb + timekey + account_name`）；
- `timekey` 不是直接取单元格，而是**用公式从上季度末推出来**——所以同一个界面上的
  "分析视图"和"填报落库"用的是两套时间口径，这是最容易对不上的地方；
- `Parameter` 里带名字，说明它会作为提交参数进入 `UpdateAttr/UpdateStatus` 的流程。

### 单元格填报控件

```xml
<C c="5" r="4" s="6">
  <O t="DSColumn">…</O><PrivilegeControl/><CellPageAttr/>
  <Widget class="com.fr.form.ui.TextEditor">
    <WidgetAttr aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">
      <MobileBookMark useBookMark="false" bookMarkName="" frozen="false" index="-1" oldWidgetName=""/>
      <PrivilegeControl/>
    </WidgetAttr>
    <TextAttr/><Reg class="com.fr.form.ui.reg.NoneReg"/>
    <widgetValue/><MobileScanCodeAttr scanCode="true" textInputMode="0"/>
  </Widget>
  <HighlightList/><Expand/>
</C>
```

`<C>` 子节点顺序：`O → PrivilegeControl → CellPageAttr → Widget → HighlightList → Expand`。
**105 个取数格同时是录入格**——数据集带出初值，用户改完提交回写。没有 `Widget` 的填报表
打开只能看不能填。

### 参数面板用服务器数据集做字典

```xml
<Dictionary class="com.fr.data.impl.TableDataDictionary">
  <FormulaDictAttr kiName="code" viName="name"/>
  <TableDataDictAttr>
    <TableData class="com.fr.data.impl.NameTableData"><Name>公司名称</Name></TableData>
  </TableDataDictAttr>
</Dictionary>
```

下拉框的选项来自平台上的**服务器数据集**（`NameTableData` 只存名字），不是模板里的数据集。
控件名 `comboBox1_companyB`，值通过 `$comboBox1_companyB` 在公式/过滤条件里引用。

## 五、其他被官方示例遗漏的节点

| 节点 | 出现 | 作用 | 我方处理 |
|---|---|---|---|
| `StrategyConfigsAttr` | 两表都有 | ESD 插件（智能取数/进化策略）配置 | 原样透传 |
| `ExcelImportTemplateAttr` | 人力资源表 | Excel 导入插件（智能匹配） | 原样透传 |
| `WebWriteContent` | 两表 | 填报工具栏（提交/校验/Excel导入按钮） | 随 `ReportWebAttr` 整块保留 |
| `ReportWebAttr/Title` | 人力资源表 | 网页标题 | 同上 |
| `Formula@reserveExecute` | 306 次 | 公式的"保留执行"标记 | 透传（属性未建模） |
| `HighlightAction` 的 5 类动作 | ROE 500+ | 行高/列宽/值/呈现/超链 高亮 | 整块 `HighlightList` 原样保留 |
| `NameJavaScriptGroup` | 人力资源表 | 单元格 JS 事件 | 原样透传 |
| `CellInsertPolicy` / `CellPageAttr` / `CellGUIAttr` | 两表 | 插入行策略/分页/界面属性 | 原样透传 |

## 六、据此对模型做的补齐（`tools/frcpt.py`）

1. **未知节点透传 + 保序**：`Workbook.extras` / `Sheet.extras` / `Cell.extras` +
   `child_order`，用 `merge_children()` 按原始顺序重建。插件属性、JS 事件、页面属性不再丢。
2. **`Cell.widget`**：建模 `Widget`（TextEditor 形态），生成填报表时可自动挂。
3. **`WriteBack` 支持多规则**：`Sheet.write_backs`（列表），`WriteBack.to_submit_element()`。
4. **`ColumnMapping`** 支持 `rows`（→ `ColumnRowGroup`）、`formula`、`parameter`。
5. **`highlight_raw`**：整块保留 `HighlightList`，高亮动作类型不再被简化成背景色。
6. **`parameter_attr_raw` / `web_attr_raw` / `mobile_attr_raw`**：参数面板与网页属性整块保留
   （之前只写最小骨架，等于把查询栏和提交按钮删掉）。
7. **`fix`**：`ReportWriteAttr` 双层嵌套 bug（`to_element()` 与 `to_submit_element()` 分离）。

回归：`tools/production_roundtrip.py` 对两份生产模板做读→写→读，逐项比对指纹——

```
hr_structure.cpt  结构指纹：一致 (3 sheets, 3 datasets, 插件根属性 2 个)
roe_entry.cpt     结构指纹：一致 (8 datasets, 105 单元格控件, 5 SubmitVisitor, 161 ColumnRow)
                  单元格子节点顺序 400 个抽样一致
```

同时 400 份官方模板与 5 份定向样本仍全部保真（`corpus_roundtrip.py` / `roundtrip_test.py`）。

## 七、仍然没做到的部分（诚实清单）

1. `Widget` 只建模了 `TextEditor`；数字/日期/下拉这几类控件读进来只透传、不建模，
   生成时也只会产出 TextEditor。
2. `HighlightAction` 的 5 类动作只保留原文，不能"按语义"生成；`$op='view'` 那类背景色动作
   由生成器产出，其余动作改不了。
3. `StrategyConfigsAttr`、`ExcelImportTemplateAttr` 只是透传，不解释其字段含义。
4. 三 sheet 架构（系统取数/企业填报）没有专门的生成支持；配方可以写多个 sheet，但
   "同一个模板里取数与填报双视图"这套编排仍要手工做。
5. 生产 SQL 里的注释头、CTE 风格、公司清单硬编码，属于团队约定，不由生成器强加。
