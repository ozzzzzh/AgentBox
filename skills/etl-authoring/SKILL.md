# ETL SQL 编写

## 适用范围

脚本型 ETL：多来源抽取、口径计算、最终落表（`TRUNCATE + INSERT INTO ... SELECT`）。
目标：口径清楚、依赖可读、改动可控。

**30 秒上手**

- 新写脚本：§二 骨架 → §五 命名 → §六 注释 → §八 口径。
- 改口径/加 `CASE`：§七 参数 → §八 口径。
- 选落表方式：§三。
- 补历史数据：看配套 skill `etl-backfill`。
- 交付前：§十三 检查。

## 一、先定粒度和输出

动笔前先回答两个问题：

1. 这张表一行代表什么？例：`每行 = 一个 category + plate`。
2. 输出哪些列、什么类型、谁在用？

```text
粒度: 每行 = 一个 category + plate（两者唯一）
输出: category, plate, total, diff
```

粒度决定主键、去重键和 `UNION ALL` 的字段顺序，后面所有步骤都围绕它。

## 二、脚本骨架

```sql
-- author / create time / update time / purpose / requirement
TRUNCATE TABLE ads.ads_xxx;

INSERT INTO ads.ads_xxx (category, plate, total, diff)
WITH
    p_date_params AS (...),
    b_xxx AS (...),
    j_xxx AS (...),
    a_xxx AS (...)
SELECT category, plate, total, diff FROM a_xxx
UNION ALL
SELECT category, plate, total, diff FROM a_yyy;

ANALYZE ads.ads_xxx;

-- 数据源清单
-- 输入：...
-- 输出：...
-- ODS 字段释义（待补充）
```

- 目标表、字段名、字段顺序写全，禁止 `SELECT *` 落表。
- 小结果表可以用 `TRUNCATE + INSERT`，但 **`TRUNCATE` 成功后 `INSERT` 失败，表是空的**。关键表先写 `_tmp` 再切换，或失败立即告警重跑。
- 大表不要全表重刷，按分区更新，见 §三。
- 收尾 `ANALYZE`（数据库支持时做）。

## 三、先选表的更新方式

| 表类型 | 怎么更新 | 适用 | 注意 |
|---|---|---|---|
| 小结果快照表（ADS 报表） | `TRUNCATE + INSERT` | 每天整表重算，几万行 | 失败会空表；关键表用 `_tmp` 切换或失败重跑 |
| 按天分区大表（事实/明细） | 覆盖当天分区：`INSERT OVERWRITE`、分区交换或 `DELETE + INSERT` | 按 `dt` 分区 | 只动当天分区，不要全表重刷 |
| 需要保留变更历史（拉链表） | `MERGE` / `UPSERT` | 人员、客户等 | 记录 `valid_from / valid_to` |
| 只追加日志 | `INSERT` | 事件流、日志 | 不清表 |

- **ADS 报表默认全量重算**；只有事实表、明细大表才按分区。
- 方言按引擎改：Hive 用 `INSERT OVERWRITE ... PARTITION`、`ANALYZE TABLE`；Greenplum/PostgreSQL 用 `DELETE`、`ANALYZE`。

## 四、做报表模型时再看（可选）

- 默认星型：事实表 + 维度表；只有同一层级被多个模型共享且需独立维护才拆雪花。维度用代理键，历史属性加 `valid_from / valid_to / is_current`。

## 五、CTE 命名：前缀 + 业务域

| 前缀 | 含义 | 示例 |
|---|---|---|
| `p_` | 参数：日期、分区、月份口径、开关 | `p_date_params` |
| `b_` | base：直接读源表或做最小聚合 | `b_mgmt_cnt_non_overseas_cur` |
| `f_` | filter：按当期/上年期/条件筛出的集合 | `f_person_cur` |
| `j_` | join：多表拼接后的明细 | `j_overseas_company_ledger` |
| `a_` | agg/result：一个业务口径的最终结果 | `a_mgmt_cnt_overseas` |
| `o_` | output：可选，最终输出层 | `o_result` |

- 命名 = `前缀_业务域_指标_维度`，如 `b_struc_person_cnt_by_month_plate`。
- 缩写统一：`cnt` 数量、`amt` 金额或汇总值、`mgmt` 管理人员、`cur` 本期、`last_year` 上年同期。
- 一个 CTE 只做一件事；名字里出现 `and` 就考虑拆开。
- **设计时先画链路**：主干 3–5 层（p → b → f/j → a → 输出），单个 CTE 内不再套多层子查询；超过就拆中间表。简单脚本 `p_ → b_ → a_` 就够。
- `f_/j_` 按实际数据流排，不必都用；`o_` 仅多目标输出时用。
- 阅读顺序应能按 `p_ → b_ → f_/j_ → a_ → 最终输出` 走通。

```text
p_date_params
  └─ b_xxx（直接读源表）
       ├─ f_xxx_cur（筛当期）
       └─ f_xxx_last_year（筛上年同期）
            └─ a_xxx（算 total / diff）
                 └─ 最终 SELECT / UNION ALL
```

## 六、每个 CTE 开头写一句注释，CTE 之间留空行

```sql
WITH
-- p_ 统一日期与台账月份口径
p_date_params AS (
    ...
),

-- b_ 按月份 + 板块汇总员工数量
b_xxx AS (
    ...
),

-- a_ 员工数量口径：当期与上年同期对比
a_xxx AS (
    ...
)
SELECT ...
```

- 注释放 CTE 开头，先看注释再看 SQL；不要写在 `),` 后面。
- CTE 之间空一行，长脚本也不会挤在一起。
- 一句话写清"这步产出什么 + 口径/时间对齐方式"。

## 七、参数与日期全部放在 p_

常用参数：`today_yyyymmdd`、`as_of_date_yyyymmdd`、`as_of_month_yyyymm`、`*_last_year_*`。

台账月份这类规则也只写一次：

```sql
CASE WHEN to_char(current_date, 'dd') >= '10'
     THEN to_char(current_date - interval '1 month', 'yyyymm')
     ELSE to_char(current_date - interval '2 month', 'yyyymm')
END AS overseas_ledger_month_yyyymm
```

- 禁止在多段 SQL 里重复手写 `to_char(current_date...)` 或同一段 `CASE`；改口径只改 `p_`。
- 参数 CTE 只算参数，不读业务表。
- 变量命名带含义和格式，如 `overseas_ledger_month_yyyymm`，不要 `v1 / v2`。

## 八、口径、指标卡与 CASE WHEN

- 一个指标一个 `a_` CTE；不要在一个 `a_` 里混多个口径。
- **先在 `a_` CTE 前写指标卡**，把口径说清楚：

```sql
-- 指标: 员工数量
-- 定义: 月末在职员工人数，按 PERNR 去重
-- 过滤: 排除 plate = '全集团'
-- 时间: 统计月；上年同期 = 当前月往前 1 年
-- 维度: category, plate
```

- **0 和 NULL 要定规矩**：没有上年数据时 `diff` 记 0 还是 NULL，和业务确认，整张表保持一致。
- **跨源去重**：人员、客户可能重复，先按主键去重；用 `count(distinct 主键)`，不要 `count(*)`。
- `CASE` 只回答一个问题，放在命名 CTE 里，例如 `b_status_normalized`。
- 必须写 `ELSE`；未知值落 `'unknown'` 或 `'其他'`，并单独查一次确认没有漏映射。
- 范围条件用左闭右开 `>= from AND < to`；分支互斥，顺序写清。
- 所有分支返回同一类型；嵌套不超过 2 层，超过就拆 CTE 或改映射表。
- 简单等值映射可以用 `decode`，默认值要写全：`decode(plate_code, '', '其他单位', plate_code)`；多条件或范围用 `CASE`。
- 同一个 `CASE` 在 2 处以上出现、或业务经常改，改成映射表 `map_xxx`；需要保留历史口径的映射表带生效时间，并按业务发生时间 join。用当前映射回算历史，报表历史会变。
- 口径或映射变更后，评估是否需要补数（见 `etl-backfill`）。

```sql
CASE
    WHEN "ZRCLB" = '13' THEN '雏鹰人才'
    ELSE "ZRCLB_T"          -- 未覆盖的值也要有去处
END AS talent_type
```

正式 SQL 和检查 SQL 都要按业务日期 join 映射表，用同一套日期条件；否则会误报 0：

```sql
SELECT t."ZRCLB", count(*)
FROM ods."ods_hr_hana_ZTHR_RCK" t
LEFT JOIN map_talent_type m
       ON m.code = t."ZRCLB"
      AND t."BEGDA" >= m.effective_from
      AND t."BEGDA" < coalesce(m.effective_to, '9999-12-31')
WHERE m.code IS NULL
GROUP BY 1;
```

## 九、输出组织

- 每个 `a_` 的输出列名、顺序、类型必须完全一致：`category, plate, total, diff`。
- `UNION ALL` 只做拼接，不再做计算、过滤、去重。
- 只需要一个指标时，删掉其他 `a_` 段，避免落表混入无关数据。
- 最后统一 `SELECT` 列清单，不使用 `SELECT *`。
- **下游要求固定维度时**（比如所有板块都要出现），先列维度全集，再 left join 结果，缺的补 0；否则没数据的维度会直接消失。

```sql
SELECT d.category, d.plate,
       coalesce(r.total, 0) AS total,
       coalesce(r.diff, 0) AS diff
FROM dim_category_plate d
LEFT JOIN a_result r
       ON r.category = d.category AND r.plate = d.plate;
```

- 粒度检查：落表前用源数据预检，落表后用目标表复核，结果应为空。

```sql
SELECT category, plate, count(*)
FROM ads.ads_xxx
GROUP BY 1, 2
HAVING count(*) > 1;
```

## 十、源表与 staging

- 源表清单只列真实表：`ods.* / dm.* / dwd_* / ads.*`，不要把 `b_/j_/a_` 当成源表。
- 直接读 ODS 时，字段名不直观的（如 `ZRCLB`、`OBJID`、`BEGDA`）要在脚本末尾列释义。
- 需要落 staging 时：与源表 1:1，只做重命名、类型转换、轻清洗；加 `_loaded_at`、`_batch_id`、`_source`、`_is_deleted`；大表按 `dt` 分区增量，不写业务口径。

```sql
INSERT INTO stg_shop_orders PARTITION (dt = :dt)
SELECT order_id, line_no, sku, qty, price,
       current_timestamp AS _loaded_at,
       :batch_id AS _batch_id,
       'shop.orders' AS _source,
       false AS _is_deleted
FROM ods.orders
WHERE updated_at >= :last_watermark - interval '2' day;
```

- 去重放在 `b_` 或中间层，排序规则写清楚：按 `updated_at DESC, ingested_at DESC` 取第一行，保证每次重跑选同一行。

## 十一、脚本末尾：数据源清单 + ODS 字段释义

```text
-- 数据源清单
-- 输入：
--   ods."ods_hr_hana_ZTHR_RYJG"
--   ods.ods_hr_sapsr3_zhrt_szpt_ryjg_nf
-- 输出：
--   ads.ads_dp_hr_talent_category_amt_nf

-- ODS 字段释义（待补充）
-- ods."ods_hr_hana_ZTHR_RYJG"
-- ZSSBK_T - ""（板块）
-- BEGDA - ""（开始日期）
```

- 只列本脚本直接依赖的表，上游的上游不列。
- 字段只列实际引用到的（`SELECT / WHERE / JOIN / GROUP BY / ORDER BY`）。
- 不知道含义就留空 `""`，不要猜；等业务确认后补。
- 用途：迁移、血缘、交接。

提取：搜 `FROM/JOIN` 后的 `schema.table` 记为输入，`INSERT INTO` 后的表记为输出；对直接读源表的 `b_` CTE 收集 `别名.字段` 和引号字段；排除 `p_/b_/f_/j_/a_`；按表分组列出。

## 十二、完整小例子

```sql
TRUNCATE TABLE ads.ads_employee_cnt_by_plate;

INSERT INTO ads.ads_employee_cnt_by_plate (category, plate, total, diff)
WITH
-- p_ 统计月
p_date_params AS (
    SELECT to_char(current_date - interval '1 day', 'yyyymm') AS as_of_month_yyyymm
),

-- b_ 按月份 + 板块汇总人数
b_person_by_plate AS (
    SELECT biz_month,
           plate,
           sum(person_num) AS person_num
    FROM ads.ads_person_struc_table
    WHERE plate <> '全集团'
    GROUP BY 1, 2
),

-- a_ 员工数量：当期与上年同期对比
a_employee_cnt_by_plate AS (
    SELECT '员工数量' AS category,
           cur.plate,
           cur.person_num AS total,
           coalesce(cur.person_num, 0) - coalesce(ly.person_num, 0) AS diff
    FROM b_person_by_plate cur
    LEFT JOIN b_person_by_plate ly
           ON ly.plate = cur.plate
          AND ly.biz_month = to_char((cur.biz_month || '01')::date - interval '1 year', 'yyyymm')
    WHERE cur.biz_month = (SELECT as_of_month_yyyymm FROM p_date_params)
)
SELECT category, plate, total, diff
FROM a_employee_cnt_by_plate;

ANALYZE ads.ads_employee_cnt_by_plate;

-- 数据源清单
-- 输入：ads.ads_person_struc_table
-- 输出：ads.ads_employee_cnt_by_plate
```

要点：

- 小表可以引用两次；大表先落临时表，避免重复扫描。上年期用 `- interval '1 year'`；`coalesce(...,0)` 是业务选择，要 NULL 就统一改。

## 十三、提交前检查

- [ ] 粒度清了吗？
- [ ] 表类型和更新方式选对了吗？关键表 `TRUNCATE` 有失败预案吗？（§三）
- [ ] 命名按 `p_/b_/f_/j_/a_`，同域一致吗？
- [ ] 日期/月份口径都在 `p_` 吗？有没有重复手写？
- [ ] 指标卡写了吗？0 和 NULL 的规则定了吗？
- [ ] `CASE` 都有 `ELSE`，未知值有去处吗？未映射检查带日期条件了吗？
- [ ] 输出列顺序/类型一致，`UNION ALL` 没做额外计算吗？
- [ ] 下游维度补零了吗？粒度检查跑过了吗？
- [ ] 末尾有数据源清单和 ODS 释义吗？

## 反模式

- `step1/step2` 命名；`SELECT *` 落表；一个 `a_` 混多个指标。
- 关键表裸 `TRUNCATE` 且无恢复方案；日期口径散落各处；同一 `CASE` 抄多遍；ODS 字段不写释义。
