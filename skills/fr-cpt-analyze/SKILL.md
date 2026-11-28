---
name: fr-cpt-analyze
description: 解析帆软 CPT 的血缘与取数逻辑，画出单元格↔源字段↔加工逻辑的逻辑图，并定位问题、给可执行修复。
whenToUse: 接手别人的模板要弄清口径、报表数据不对要排查、要出字段级血缘/逻辑图文档、或要批量修模板里的循环引用与失效引用。
---

# 解析 CPT：逻辑图 + 问题修复

引擎：`../fr-cpt/scripts/cpt_analyze.py`。

## 三件产出

```bash
python ../fr-cpt/scripts/cpt_analyze.py 模板.cpt                  # 人读的逻辑图（控制台）
python ../fr-cpt/scripts/cpt_analyze.py 模板.cpt --md 逻辑图.md    # 落成文档
python ../fr-cpt/scripts/cpt_analyze.py 模板.cpt --mermaid        # Mermaid 流程图
python ../fr-cpt/scripts/cpt_analyze.py 模板.cpt --json 血缘.json  # 机器可读（给下游系统/血缘平台）
```

逻辑图逐格给出六列：**单元格 / 类型 / 来源 / 加工逻辑 / 依赖 / 最终溯源**。

```
| E3 | formula | `=D3/D4`      | 公式（引用 2 格） | D3, D4 | ds1.销量 |
| D3 | column  | `ds1.销量`    | 纵向扩展          | ds1.销量 | ds1.销量 |
| D4 | summary | `ds1.销量`    | SUM               | ds1.销量 | ds1.销量 |
| A3 | column  | `ds1.地区`    | 分组 → 纵向扩展   | ds1.地区 | ds1.地区 |
```

"最终溯源"是**穿透公式**的：`E3` 本身没有数据源，但它引用的 `D3/D4` 都回溯到 `ds1.销量`，
所以 E3 的溯源也是 `ds1.销量`。这就是要沉淀的那条链：**单元格 → 公式 → 单元格 → 数据集列 → 源表字段**。

## 还原查询

每张 sheet 会给一段反推 SQL，用来和业务方核对口径：

```sql
SELECT 地区, 销售员, 产品, 销量, SUM(销量) AS 销量_合计
FROM ds1
GROUP BY 地区, 销售员, 产品
-- 跨集关联: ds2.销售员 = ds1.销售员
-- 数据集参数: 地区 = '华东'
```

规则：非聚合的文本列 → 维度；非聚合的数值列 → 度量（进 SELECT 不进 GROUP BY）；
聚合列 → `SUM/COUNT/…`；`Condition` 里的等值判断 → WHERE；跨数据集判断 → 注释里的「跨集关联」。
**这是反推，不保证可执行**，用途是"让业务方看懂这段报表在算什么"。

## 诊断与修复

诊断分两层，都要看：

```bash
python ../fr-cpt/scripts/cpt_dump.py 模板.cpt --standard   # 结构 + 6.2 规范
python ../fr-cpt/scripts/cpt_analyze.py 模板.cpt           # 血缘层面
```

血缘层规则：

| code | 含义 | 是否自动修 |
|---|---|---|
| `L-REF-MISSING` | 公式引用了不存在的单元格 | 可（置 0，需人确认） |
| `L-REF-EMPTY` | 公式引用了空白格（结果是 0/空） | 否，要补取数 |
| `L-CYCLE` | 公式循环引用 | 否，需人工断环 |
| `L-ORPHAN-COL` | 数据集有列但没被任何格子引用 | 否 |
| `L-DUP-BIND` | 同一列绑定到多个格子 | 否 |
| `L-PARAM-UNDECLARED` | 公式用了 `$x` 但没声明 | 否 |

只有"安全修复"（当前是 `L-REF-MISSING` 置 0）会由 `--fix` 落盘，其余只报告并给 `fix_hint`：

```bash
python ../fr-cpt/scripts/cpt_analyze.py 模板.cpt --fix   # → 模板.fixed.cpt
```

`--json` 里每条诊断都带 `fix`（可直接喂 `cpt_patch.py` 的 ops 数组）与 `fix_hint`（人话），
要批量修就取 `fix` 拼成一个 ops 文件，走 `fr-cpt-edit` 的流程（带 `--plan` 审核）。

## 排查模板"数据不对"的固定顺序

1. `cpt_dump` 看数据集是否真的读到了行（内置数据集会被解码打印）——数据没进来，后面都白搭。
2. `cpt_analyze` 看那个格的**来源**：是数据列、公式、还是写死的常量（很常见）。
3. 看**加工逻辑**：有没有意料之外的分组（`分组`）、汇总（`SUM`）、过滤（`过滤 …`）。
4. 看**最终溯源**：业务口径说的字段，和这条链最后落到的是不是同一个。
5. 看还原 SQL 的 `WHERE` 与 `-- 数据集参数`：参数没传进来时，条件会退化成"全表"或空。
6. 还不对就查平台侧：连接名、服务器数据集、参数是否真传进来了（模板里查不到）。

## 输出文档时

给用户的东西按这个顺序，别堆原始 JSON：

1. 一句话口径结论（这段报表等价的 SQL / 一句话业务描述）。
2. 血缘表（只列有来源的格子，表头和常量行可以省）。
3. Mermaid 图（贴进文档或 wiki 能直接渲染）。
4. 诊断清单 + 修复建议；能自动修的附上 `--fix` 命令。

**不确定就标注**：图表格（`<chart>`）、斜线表头、跨集关联条件、平台侧参数，
这些是解析的盲区，直接说明"未建模/需人工核对"，不要编一个看起来完整的结论。
