# ETL 编写

## 何时使用

新建或修改 ETL、dbt model、数仓 SQL；设计 staging/中间层/mart；统一团队 SQL 风格。

**交付前 8 问**：grain 写了吗？stg 有没有业务逻辑？每层职责单一吗？CTE 名能看懂吗？还有 `SELECT *` 吗？注释写了"为什么"吗？重跑结果一致吗？验证 SQL 跑过吗？

## 0. 先写 grain

动笔前先用一行注释定义 grain，写不出来就不要开始：

```text
grain: 每行 = 一个订单的一个商品行（order_id + line_no 唯一）
```

- 事实表：业务事件的最小粒度，不要"先粗后细"；
- 维度表：一个实体一行；SCD2 是"实体 + 版本"一行；
- grain 决定主键、去重键和聚合方式，后面所有步骤都围绕它。

## 1. 源表落表（staging）

**职责**：接入、重命名、类型转换、轻清洗。不写业务口径、不聚合、不 join 维表。

**命名**

| 对象 | 规则 | 示例 |
|---|---|---|
| 表 | `stg_<源系统>_<实体>` | `stg_shop_orders` |
| 字段 | snake_case + 单位/时区后缀 | `amount_cents`, `created_at_utc` |
| 批次 | `_batch_id` | `20261126T0300` |

**必备审计列**

| 列 | 含义 |
|---|---|
| `_loaded_at` | 入库时间（UTC） |
| `_batch_id` | 批次标识，支持回放与对账 |
| `_source` | 源系统/表/文件 |
| `_is_deleted` | 软删除标记（CDC 或全量对比） |

**落表方式**

| 场景 | 方式 | 要点 |
|---|---|---|
| 小表/维度源 | 全量覆盖 | 写临时表再原子替换，避免半成品 |
| 大表/事实源 | 增量追加 | 按 `dt` 分区，watermark + lookback |
| CDC | 追加变更日志 | 保留 op 类型，int 层再合并 |
| 需要重跑 | 按分区覆盖 | `DELETE` 分区 + `INSERT`，不要全表重刷 |

```sql
-- 全量覆盖：小表 / 维度源，写临时表，校验行数后原子替换
CREATE TABLE stg_shop_customers_tmp AS
SELECT customer_id, name, region,
       CURRENT_TIMESTAMP AS _loaded_at,
       :batch_id AS _batch_id,
       'shop.customers' AS _source
FROM raw_shop_customers;
-- 校验通过后：DROP/RENAME 或事务内交换，避免半成品可见

-- 增量追加：大表 / 事实源，按 dt 分区
INSERT INTO stg_shop_orders PARTITION (dt = :dt)
SELECT order_id, line_no, sku, qty, price,
       created_at, updated_at,
       CURRENT_TIMESTAMP AS _loaded_at,
       :batch_id AS _batch_id,
       'shop.orders' AS _source,
       FALSE AS _is_deleted
FROM raw_shop_orders
WHERE updated_at >= :last_watermark - INTERVAL '2' DAY
  AND updated_at <  :last_watermark + INTERVAL '1' DAY;
```

**去重位置**：源可能重复时，stg 保留原始行并记录 `_loaded_at`；去重放 `int_` 或 stg 的最终视图，用 `updated_at/_loaded_at` 写 tie-breaker。**schema 漂移**：显式列清单；新增字段先加列再使用；类型变化先兼容转换并告警。

**物化建议（dbt）**：stg 用 `view`；int 用 `ephemeral`（复用少）或 `table`（复用多）；dim/fct 用 `table` 或 `incremental`。大事实表禁止全表重刷。

## 2. 模型选择

**分层职责**

| 层 | 回答的问题 | 允许 | 禁止 |
|---|---|---|---|
| stg | 源数据长什么样 | 重命名、cast、轻清洗 | 业务口径、聚合 |
| int | 口径如何统一 | 去重、关联、派生 | 最终 BI 宽表 |
| dim/fct | 业务如何度量 | 星型模型、代理键 | 直接读源表 |

**星型 vs 雪花**

| 判断 | 选择 |
|---|---|
| 默认分析 mart | 星型 |
| 维度层级被多个模型共享、需独立维护 | 雪花 |
| 仅单张维表内部有层级、查询简单 | 星型，层级拍平 |
| 集成层需要规范化/审计 | 规范化或 Data Vault，mart 再还原星型 |

```text
星型：
fct_order_line(order_line_sk, order_id, product_sk, customer_sk, date_sk, qty, amount)
dim_product(product_sk, sku, name, category_name, division_name)
dim_customer(customer_sk, customer_id, name, region)

只有在品类/事业部被多个维度共享且独立维护时才拆：
dim_product.product_sk -> dim_category.category_sk -> dim_division.division_sk
```

**选择顺序**：① 先定事实表类型与 grain；② 列出所有维度及层级；③ 默认把层级拍平进维度；④ 只有"层级被多个模型共享且需独立维护"才拆雪花；⑤ 需要历史属性再选 SCD2。

**键与 SCD**

| 项 | 建议 |
|---|---|
| 维度键 | 代理键 `*_sk`；事实表只存代理键 |
| 自然键 | 保留在维度表，用于回溯与对账 |
| 属性纠错 | SCD1 覆盖 |
| 需要历史 | SCD2 + `valid_from/valid_to/is_current` |
| 多对多 | 桥接表 `bridge_*` |

**事实表类型**：事务事实（一行一事件）、周期快照（每日余额）、累积快照（订单全流程时间戳）。先选类型再定 grain。

## 3. CTE 层级划分与命名

**推荐 3–7 个，顺序固定**

| # | 命名 | 职责 | 示例 |
|---|---|---|---|
| 1 | `src_<实体>` | 读源 + 分区/时间过滤 | `src_orders` |
| 2 | `typed_<实体>` | 显式 cast、时区、枚举归一 | `typed_orders` |
| 3 | `deduped_<实体>` | 按业务键去重 | `deduped_orders` |
| 4 | `enriched_<实体>` | join 维度、补充属性 | `enriched_orders` |
| 5 | `aggregated_<粒度>` | 聚合到目标 grain | `aggregated_daily` |
| 6 | `final` | 输出契约列 | `final` |

**命名规则**

- snake_case 名词短语，描述"产出什么"，不描述顺序（禁止 `step1/step2/cte1`）；
- 一个 CTE 只做一件事；名字里出现 `and` 通常应拆分；
- 同一 CTE 不要重复引用；需复用就落 `int_` 表；
- 超过 7 个 CTE 或嵌套超过 5 层，拆成独立 model。

```sql
-- grain: 每行 = 一个订单的一个商品行
WITH src_orders AS (
    SELECT order_id, line_no, sku, qty, price,
           created_at, updated_at, ingested_at
    FROM stg_shop_orders
    WHERE dt >= :start_dt AND dt < :end_dt
),
typed_orders AS (
    SELECT order_id, line_no, sku,
           CAST(qty AS INT) AS qty,
           CAST(price AS DECIMAL(18,2)) AS price,
           created_at AT TIME ZONE 'UTC' AS created_at_utc,
           updated_at, ingested_at
    FROM src_orders
),
deduped_orders AS (
    SELECT order_id, line_no, sku, qty, price, created_at_utc
    FROM (
        SELECT order_id, line_no, sku, qty, price, created_at_utc,
               ROW_NUMBER() OVER (
                   PARTITION BY order_id, line_no
                   ORDER BY updated_at DESC, ingested_at DESC
               ) AS rn
        FROM typed_orders
    ) ranked
    WHERE rn = 1
),
final AS (
    SELECT order_id, line_no, sku, qty, price,
           CAST(qty * price AS DECIMAL(18,2)) AS amount
    FROM deduped_orders
)
SELECT order_id, line_no, sku, qty, price, amount
FROM final;
```

**何时用中间表代替 CTE**：CTE 被引用 ≥2 次、单步扫描成本高、需要被其他 model 复用。注意部分引擎会内联 CTE，重复引用可能重复扫描。

## 4. 可读性清单

| 规则 | 反例 → 正例 |
|---|---|
| 显式列 | `SELECT *` → 列清单 |
| 显式 cast | `price * 1.0` → `CAST(price AS DECIMAL(18,2))` |
| 显式 NULL | `qty + 1` → `COALESCE(qty, 0) + 1` |
| 显式 join | `FROM a, b` → `FROM a JOIN b ON ...` |
| 业务别名 | `a/b/t1` → `o/ol/p` |
| 金额 | `FLOAT` → `DECIMAL(18,2)` |
| 时间 | 本地时间 → UTC 存储 |
| 魔法值 | `status = 3` → 命名 CTE/参数 |
| 窗口 | 省略 partition → 写全 |
| 排序 | 无意义 `ORDER BY` → 仅在需要确定性时写 |

格式：关键字大写、4 空格缩进、逗号前置、每行一列/一条件；团队统一，不混用。

## 5. 注释规范

**文件头**（每张表都必须有）

```sql
-- 目的: 订单商品事实表，供销售日报
-- grain: 每行 = 一个订单的一个商品行
-- 来源: stg_shop_orders, dim_product
-- 参数: :start_dt, :end_dt（UTC，左闭右开）
-- 负责人: data-platform / @owner
-- 更新: 每日 03:00，SLA 04:00
-- 下游: dm_sales_daily, bi.sales
```

**CTE 头**：一行写 grain + 关键规则

```sql
-- deduped_orders: 按 (order_id, line_no) 去重，updated_at/ingested_at 大者优先
```

**业务规则写"为什么"**

```sql
-- 坏: 过滤掉 status=0 的数据
-- 好: status=0 是源系统占位行，非真实订单；见 SOURCE-123
WHERE status <> 0
```

**假设/TODO 写解除条件**

```sql
-- TODO(@owner): 2027Q1 源表上线 region_code 后删除映射
```

不要注释 `-- 查询订单表`、`-- 这里做 join`；注释与代码同次更新。

## 6. 增量与幂等

- watermark + lookback：`WHERE updated_at >= :last_watermark - INTERVAL '2' DAY`，覆盖迟到数据；
- 合并：自然键 `MERGE`，或分区 `DELETE + INSERT`；
- 删除：软删 `_is_deleted` / CDC `op='D'`，不要静默丢行；
- 空批次、重复批次、历史回放都必须可跑；同批次重跑结果一致；
- 不依赖"上次运行成功"这类不可恢复的外部状态。

```sql
MERGE INTO fct_order_line AS t
USING int_order_line AS s
   ON t.order_id = s.order_id AND t.line_no = s.line_no
WHEN MATCHED AND s.updated_at > t.updated_at THEN UPDATE SET
    qty = s.qty, amount = s.amount, _loaded_at = CURRENT_TIMESTAMP
WHEN NOT MATCHED THEN INSERT
    (order_id, line_no, product_sk, qty, amount, _loaded_at)
    VALUES (s.order_id, s.line_no, s.product_sk, s.qty, s.amount, CURRENT_TIMESTAMP);

-- 或按分区覆盖（可重跑、易回滚）：
-- DELETE FROM fct_order_line WHERE dt = :dt;
-- INSERT INTO fct_order_line SELECT ... WHERE dt = :dt;
```

## 7. 性能清单

- 分区裁剪、谓词下推；先过滤再 join；
- join key 类型一致，键上不用函数或隐式 cast；
- 小维表广播，大表按分布键 join，防倾斜；
- 先聚合再 join，避免行数放大和笛卡尔积；
- 优先增量，监控中间结果行数膨胀。

## 8. 验证

| 检查 | SQL |
|---|---|
| grain 唯一 | `SELECT order_id, line_no FROM fct GROUP BY 1,2 HAVING COUNT(*) > 1` |
| 关键列非空 | `SELECT COUNT(*) FROM fct WHERE product_sk IS NULL` |
| 外键可命中 | left join dim，统计未命中且非未知成员的行 |
| 对账 | 源/目标行数与金额聚合在约定容差内 |
| 回放 | 同批次重跑两次，checksum 一致 |
| 新鲜度 | `MAX(_loaded_at)` 符合 SLA |

dbt 用 `unique` / `not_null` / `relationships` + singular test，纳入 CI。

## 反模式

- 不写 grain 就写 SQL；`SELECT *`；`a/b/t1` 别名；
- 在 stg 写业务口径；把整条链路塞进一个巨型 `WITH`；
- CTE 名 `step1/step2`；同一 CTE 重复引用却不评估重复扫描；
- 去重无 deterministic tie-breaker；join key 上套函数；
- `FLOAT` 存金额；时间不带时区；全量刷新代替增量；
- 注释复述语法或长期不更新。
