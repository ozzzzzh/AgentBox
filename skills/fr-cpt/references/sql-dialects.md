# 数据集 SQL：PostgreSQL / Greenplum 方言

目标库只有 **PG 系**（PostgreSQL、Greenplum）。帆软官方示例模板大量用 SQL Server 方言
（`[销量]A`、`TOP n`、`ISNULL`），直接搬过来会报错——这份文档把这些坑固定下来，
`scripts/dialect.py` 是它的可执行版本。

## 一、帆软侧的两个前提

1. **数据集 SQL 是原样下发给 JDBC 的**，帆软不做方言翻译。写 PG 不认识的语法，预览就报错，
   且错误信息在网页端很模糊（常常只显示"数据集执行失败"）。
2. **`${name}` 是文本替换，不是绑定参数**。所以：
   - 字符串要自己加单引号：`'${name}'`
   - 日期要显式转：`to_date('${biz_month}','YYYY-MM')` 或 `'${date_str}'::date`
   - 多值要写 `in (${ids})`（帆软把多值展开成 `1,2,3`）
   - **参数值必须由平台侧校验/白名单**，文本替换天然有注入面；这条不是模板能解决的，
     在平台的数据服务或查询条件里限制。

`<PageQuery>` 一般留空；真要分页，PG/GP 用 `LIMIT n OFFSET m`。

## 二、方言对照：常见写法 → PG/GP

| 你会看到的写法 | 来源 | PG/GP 正确写法 |
|---|---|---|
| `[表名]` / `[列名]` | SQL Server | `"表名"` / `"列名"`（双引号，大小写敏感） |
| `` `表名` `` | MySQL / Hive | `"表名"` 或裸写（会被折叠成小写） |
| `SELECT TOP 10 ...` | SQL Server | `... LIMIT 10`（在 ORDER BY 之后） |
| `ISNULL(x, 0)` | SQL Server | `COALESCE(x, 0)` |
| `IFNULL(x, 0)` | MySQL | `COALESCE(x, 0)` |
| `GETDATE()` | SQL Server | `CURRENT_DATE`（要时间戳用 `now()`） |
| `DATE_FORMAT(d,'%Y-%m')` | MySQL / Hive | `to_char(d,'YYYY-MM')` |
| `DATEADD(day,1,d)` | SQL Server | `d + interval '1 day'` |
| `DATEPART(month,d)` | SQL Server | `extract(month from d)` 或 `date_trunc('month',d)` |
| `LEN(x)` | SQL Server | `length(x)` |
| `N'中文'` | SQL Server | `'中文'`（库编码 UTF-8） |
| `NVARCHAR/DATETIME/TINYINT/MONEY` | SQL Server | `varchar/timestamp/smallint/numeric(18,2)` |
| `a + 'xxx'`（字符串拼接） | SQL Server | `a || 'xxx'` 或 `concat(a,'xxx')` |
| `IF(...)` | Hive | `CASE WHEN ... THEN ... END` |
| `nvl(x,0)` | Oracle | `COALESCE(x,0)` |
| `rowid` / `rownum` | Oracle | `ctid`（慎用）/ `row_number() over()` |

`scripts/dialect.py --adapt` 能自动改的：方括号、反引号、`N'`、`ISNULL/IFNULL`、`GETDATE()`、
`LEN(`。**不能自动改的**（必须人看着改）：`TOP`→`LIMIT` 的位置、`DATE_FORMAT` 的格式串、
`a+b` 字符串拼接、`IF(`、类型名。

## 三、PG 上必须守的 6 条

1. **标识符大小写**：裸写 `SelectName` 会被折叠成 `selectname`；混合大小写、保留字、特殊字符
   一律加双引号。中文别名裸写可以（不会被折叠），但**建议统一加双引号**——将来改成英文别名
   时不会因为折叠而让帆软绑定不到列。
2. **字符串拼接用 `||`**，`+` 只做数值加法。PG 里 `'a' + 'b'` 直接报错。
3. **`concat()` 忽略 NULL**（`concat('产量', NULL)` → `'产量'`），而 `||` 遇到 NULL 会让整格变 NULL。
   拼"指标(单位)"这种可能缺单位的场景，用 `concat()` 更安全。
4. **类型转换用 `::`**：`SUM(system_value)::numeric`。上游是 `float8` 时先转 `numeric` 再汇总/展示，
   避免尾部浮点误差出现在报表上。
5. **`GROUP BY` 必须列全**所有非聚合列（标准 SQL，PG 严格执行；MySQL 的宽松模式在这里不成立）。
6. **分页 `LIMIT n OFFSET m`**，且 `LIMIT` 必须在 `ORDER BY` 之后。

## 四、Greenplum 额外注意事项

Greenplum 是 MPP（基于 PG），语法基本同 PG，但下面这些在 GP 上更容易踩：

- **分布键**：大表 JOIN 尽量让连接键等于分布键，否则会广播/重分布，慢到超时。
  报错前通常表现为"查询很慢"而不是"语法错"。
- **避免 `SELECT ... FOR UPDATE`**：GP 上语义受限，报表数据集里不要用。
- **大结果集 `DISTINCT` / 窗口函数**容易数据倾斜，报表侧尽量先过滤（`biz_month`、`company_code`）。
- **`RETURNING` 可用**，但只影响填报提交，不影响报表取数。
- GP6 支持 `concat()`、`::` cast、`date_trunc`、`interval`；GP5 老版本 `concat` 也支持，
  但 `format()` 之类较新的函数要注意版本。

## 五、生成器里怎么用

配方/配置里声明方言（默认就是 `greenplum`）：

```jsonc
{ "dialect": "greenplum", "source": { "type": "sql", "dialect": "postgres", "query": "..." } }
```

```bash
python scripts/recipe2cpt.py 配方.json --plan            # 配方校验 + 方言检查
python scripts/recipe2cpt.py 配方.json --adapt           # 自动改写能改的那些
python scripts/recipe2cpt.py 配方.json --out 结果.cpt
python scripts/cpt_analyze.py 结果.cpt --dialect greenplum   # 事后检查已有模板
```

检查规则（`dialect.py`）：

| code | 级别 | 含义 |
|---|---|---|
| `PG-BRACKET` | error | 方括号标识符 |
| `PG-TOP` | error | `SELECT TOP n` |
| `PG-BACKTICK` | error | 反引号标识符 |
| `PG-ISNULL` / `PG-IFNULL` | warning | 应改 `COALESCE` |
| `PG-GETDATE` | warning | 应改 `CURRENT_DATE` / `now()` |
| `PG-DATEFORMAT` | warning | 应改 `to_char` |
| `PG-DATEADD` | warning | 应改 `interval` / `date_trunc` |
| `PG-LEN` | warning | 应改 `length` |
| `PG-PARAM-NOQUOTE` | warning | `${x}` 没加引号 |
| `PG-PARAM-DATE` | info | 日期列直接和 `'${}'` 比较，依赖隐式转换 |
| `PG-NSTRING` / `PG-TYPE` | info | SQL Server 字面量/类型名 |
| `PG-SELECT-STAR` | info | `SELECT *` 会把上游新增列带进报表 |
| `PG-IMPLICIT-JOIN` | info | 逗号连接在 GP 上易变笛卡尔积 |

## 六、不确定项

1. `biz_month` 到底是 `text('2025-01')` 还是 `date`：决定了 `= '${biz_month}'` 还是
   `= to_date('${biz_month}','YYYY-MM')`。样例按 text 写，date 场景给出了替代写法。
2. 平台是否对 `${}` 参数做白名单/类型校验——这决定注入面，模板侧看不到。
3. GP 版本（5 / 6 / 7）会影响个别函数可用性；样例只用 `concat/::numeric/date_trunc` 这类长期存在的。
