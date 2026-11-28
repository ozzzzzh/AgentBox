# -*- coding: utf-8 -*-
"""dialect — 数据集 SQL 的 PostgreSQL / Greenplum 方言适配与检查。

为什么需要它：帆软模板里的数据集 SQL 是**跨库移植时最先坏的东西**。官方示例模板大量用
SQL Server 方言（`[销量]A` 这种方括号表别名、`TOP n`、`ISNULL`），直接搬到 PG/GP 会报错。
这个模块做三件事：

  1. ``lint(sql, dialect)``  —— 找出不兼容写法，给出 PG/GP 的等价写法
  2. ``adapt(sql, dialect)`` —— 自动改写能安全改的那些（方括号、TOP、ISNULL、DATE_FORMAT…）
  3. ``page_query(dialect)`` —— 给帆软 <PageQuery> 的 PG/GP 分页语句

帆软参数 ``${name}`` 是**文本替换**，不是 JDBC 绑定参数，所以 PG 下的类型与引号必须自己写对：
``'${biz_month}'::date``、``in (${ids})``。lint 会把这类风险点单独标出来。
"""
from __future__ import annotations

import re
from typing import Dict, List

PG_LIKE = ("postgres", "postgresql", "pg", "greenplum", "gp", "gpdb")

DIALECT_ALIASES = {
    "postgres": "postgres", "postgresql": "postgres", "pg": "postgres",
    "greenplum": "greenplum", "gp": "greenplum", "gpdb": "greenplum",
    "hive": "hive", "sqlserver": "sqlserver", "mssql": "sqlserver",
    "oracle": "oracle", "mysql": "mysql",
}


def normalize(dialect: str) -> str:
    return DIALECT_ALIASES.get((dialect or "").strip().lower(), (dialect or "").strip().lower() or "postgres")


def is_pg_family(dialect: str) -> bool:
    return normalize(dialect) in ("postgres", "greenplum")


# ---------------------------------------------------------------- 规则表
# (code, level, regex, message, suggestion, rewrite_fn or None)
Rules = List[Dict]


def _rules_target_pg() -> Rules:
    return [
        {
            "code": "PG-BRACKET",
            "level": "error",
            "pattern": re.compile(r"\[([^\[\]]{1,64})\](?![^\s,;)]*\]\s*(?:AS\b)?)", re.I),
            "message": "方括号标识符是 SQL Server 写法，PG/GP 会当成数组下标",
            "suggestion": '改成双引号："表名"（注意 PG 的双引号是大小写敏感）',
        },
        {
            "code": "PG-TOP",
            "level": "error",
            "pattern": re.compile(r"\bSELECT\s+TOP\s+(\d+)", re.I),
            "message": "`SELECT TOP n` 是 SQL Server 写法",
            "suggestion": "改成 `LIMIT n`（放在 ORDER BY 之后）",
        },
        {
            "code": "PG-BACKTICK",
            "level": "error",
            "pattern": re.compile(r"`[^`]+`"),
            "message": "反引号是 MySQL/Hive 写法",
            "suggestion": "改成双引号，或去掉引号（PG 会折叠成小写）",
        },
        {
            "code": "PG-ISNULL",
            "level": "warning",
            "pattern": re.compile(r"\bISNULL\s*\(", re.I),
            "message": "`ISNULL(x,y)` 是 SQL Server 的判空替换",
            "suggestion": "改成 `COALESCE(x,y)`",
        },
        {
            "code": "PG-IFNULL",
            "level": "warning",
            "pattern": re.compile(r"\bIFNULL\s*\(", re.I),
            "message": "`IFNULL` 是 MySQL 写法",
            "suggestion": "改成 `COALESCE(...)`",
        },
        {
            "code": "PG-GETDATE",
            "level": "warning",
            "pattern": re.compile(r"\b(GETDATE|SYSDATETIME|NOW\(\)\s*\(\s*\))\s*\(\s*\)", re.I),
            "message": "`GETDATE()` 在 PG 里不存在",
            "suggestion": "改成 `CURRENT_DATE`（只要日期）或 `now()`（要时间戳）",
        },
        {
            "code": "PG-DATEFORMAT",
            "level": "warning",
            "pattern": re.compile(r"\b(DATE_FORMAT|TO_CHAR_SAFE)\s*\(", re.I),
            "message": "`DATE_FORMAT` 是 MySQL/Hive 写法",
            "suggestion": "改成 `to_char(col, 'YYYY-MM')`（PG/GP 一致）",
        },
        {
            "code": "PG-DATEADD",
            "level": "warning",
            "pattern": re.compile(r"\bDATEADD\s*\(|\bDATEPART\s*\(", re.I),
            "message": "`DATEADD/DATEPART` 是 SQL Server 写法",
            "suggestion": "改成 `col + interval '1 day'`、`date_trunc('month', col)`",
        },
        {
            "code": "PG-LEN",
            "level": "warning",
            "pattern": re.compile(r"\bLEN\s*\(", re.I),
            "message": "`LEN()` 在 PG 里是 `length()`",
            "suggestion": "改成 `length(col)`",
        },
        {
            "code": "PG-NSTRING",
            "level": "info",
            "pattern": re.compile(r"\bN'"),
            "message": "`N'...'` 前缀是 SQL Server 的 unicode 字面量",
            "suggestion": "PG/GP 直接写 `'...'`（库编码已是 UTF-8）",
        },
        {
            "code": "PG-TYPE",
            "level": "info",
            "pattern": re.compile(r"\b(NVARCHAR|DATETIME2?|TINYINT|MONEY)\b", re.I),
            "message": "用了 SQL Server 类型名",
            "suggestion": "对应 PG 类型：`varchar / timestamp / smallint / numeric(18,2)`",
        },
        {
            "code": "PG-PARAM-NOQUOTE",
            "level": "warning",
            "pattern": re.compile(r"(?<!['\"])\$\{(\w+)\}(?!['\"])"),
            "message": "`${...}` 在帆软里是文本替换；不加引号会被当成数字/标识符",
            "suggestion": "字符串参数写成 `'${name}'`，日期写成 `'${name}'::date`，多值写成 `in (${ids})`",
        },
        {
            "code": "PG-AGG-CAST-ORDER",
            "level": "error",
            "pattern": re.compile(
                r"\b(SUM|AVG|MAX|MIN|COUNT)\s*\([^()]*\)\s*::\s*(numeric|decimal|int|integer|bigint|float|double|real)",
                re.I),
            "message": "先聚合后转型：源列若是 varchar/text，SUM 自己就会报 "
                       "`function sum(character varying) does not exist`，外面加 ::numeric 救不了",
            "suggestion": "把转型挪进去：SUM(x::numeric)；对本来就是 numeric 的列也无害",
        },
        {
            "code": "PG-BOOL-COMPARE",
            "level": "warning",
            "pattern": re.compile(r"\b(is_|has_|flag|是否)[A-Za-z_]*\s*=\s*[01]\b", re.I),
            "message": "标志列与 0/1 比较：PG 里 boolean = integer 会报 "
                       "`operator does not exist: boolean = integer`",
            "suggestion": "布尔列直接写 `is_sum` 或 `is_sum IS TRUE`；混用类型时写 `is_sum::int = 1`",
        },
        {
            "code": "PG-DATE-TEXT-MIX",
            "level": "warning",
            "pattern": re.compile(
                r"\b\w*(month|date|day|time|dt)\w*\s*=\s*(to_char|to_date)\s*\(", re.I),
            "message": "拿文本函数的结果去等值比较日期/月份列，成败取决于列类型："
                       "列是 date 时会报 `invalid input syntax for type date`",
            "suggestion": "类型无关写法 `col::text LIKE '2025-05%'`；"
                          "已知是 date 就用范围 `col >= to_date('2025-05','YYYY-MM') "
                          "AND col < … + interval '1 month'`（还能走索引）",
        },
        {
            "code": "PG-PARAM-TEXT-CMP",
            "level": "info",
            "pattern": re.compile(r"\b\w*(month|date|day|time|dt)\w*\s*=\s*'\$\{", re.I),
            "message": "日期/月份列直接和 '${...}' 比较，依赖 PG 的隐式转换",
            "suggestion": "列是 text 就保持；列是 date 改成 to_date('${x}','YYYY-MM') 或范围比较",
        },
        {
            "code": "PG-SELECT-STAR",
            "level": "info",
            "pattern": re.compile(r"\bSELECT\s+\*\s+FROM\b", re.I),
            "message": "`SELECT *` 会把源表所有列带进数据集，上游加列会悄悄改变报表",
            "suggestion": "分析表建议显式列出用到的字段（也便于血缘核对）",
        },
        {
            "code": "PG-IMPLICIT-JOIN",
            "level": "info",
            "pattern": re.compile(r"\bFROM\s+\w+\s*,\s*\w+", re.I),
            "message": "逗号连接在 GP 上容易被优化器选成笛卡尔积",
            "suggestion": "改成显式 `JOIN ... ON ...`",
        },
    ]


# ---------------------------------------------------------------- 自动改写
_REWRITES = [
    # [name] -> "name"  （只处理单个标识符，不含点号）
    (re.compile(r"\[([^\[\]]+)\]"), lambda m: '"' + m.group(1) + '"'),
    # `name` -> "name"
    (re.compile(r"`([^`]+)`"), lambda m: '"' + m.group(1) + '"'),
    # N'...' -> '...'
    (re.compile(r"\bN'"), lambda m: "'"),
    # ISNULL(a,b) -> COALESCE(a,b)
    (re.compile(r"\bISNULL\s*\(", re.I), lambda m: "COALESCE("),
    (re.compile(r"\bIFNULL\s*\(", re.I), lambda m: "COALESCE("),
    # GETDATE() -> CURRENT_DATE
    (re.compile(r"\bGETDATE\s*\(\s*\)", re.I), lambda m: "CURRENT_DATE"),
    # LEN( -> length(
    (re.compile(r"\bLEN\s*\(", re.I), lambda m: "length("),
    # SQL Server 字符串拼接 'a' + 'b' 不动（PG 也支持 + 数值相加，字符串需 ||），
    # 这里只在两侧都是字面量时提示，改写交给 lint。
]

_TOP_RE = re.compile(r"\bSELECT\s+TOP\s+(\d+)\s+", re.I)


def adapt(sql: str, dialect: str = "greenplum") -> str:
    """把能安全改写的方言写法改成 PG/GP。改不了的只由 lint 报告，不在此处猜。"""
    if not sql or not is_pg_family(dialect):
        return sql
    out = sql
    # TOP n  ->  去掉 TOP，末尾补 LIMIT n
    m = _TOP_RE.search(out)
    limit = None
    if m:
        limit = m.group(1)
        out = re.sub(r"\bSELECT\s+TOP\s+\d+\s+", "SELECT ", out, count=1, flags=re.I)
    for pat, fn in _REWRITES:
        out = pat.sub(fn, out)
    # 引号标识符后面直接跟字母（如 FROM "销量"A）在 PG 里是语法错误，补空格
    out = re.sub(r'("(?:[^"]|"")+")(?=[A-Za-z_\u4e00-\u9fa5])', r"\1 ", out)
    if limit and not re.search(r"\bLIMIT\b", out, re.I):
        out = out.rstrip().rstrip(";") + f"\nLIMIT {limit}"
    return out


# ---------------------------------------------------------------- 检查
TEXT_TYPES = ("char", "varchar", "character varying", "text", "string", "bpchar", "nvarchar")

# 只跟"列是不是日期/文本"有关的规则：调用方声明了列类型就不该再猜
_TYPE_SENSITIVE = {"PG-DATE-TEXT-MIX", "PG-PARAM-TEXT-CMP"}


def _column_of(snippet: str) -> str:
    m = re.match(r"\s*([A-Za-z_][\w.]*)\s*(?:=|>=|<=|>|<|LIKE)", snippet, re.I)
    return (m.group(1).split(".")[-1] if m else "").strip().strip('"')


def _declared_text(snippet: str, known_types) -> bool:
    if not known_types:
        return False
    col = _column_of(snippet)
    t = (known_types.get(col) or "").lower()
    return any(k in t for k in TEXT_TYPES)


def lint(sql: str, dialect: str = "greenplum", known_types=None) -> List[Dict[str, str]]:
    """返回问题列表：[{level, code, message, suggestion, snippet}]。

    ``known_types``：{列名: 类型}，来自配方的 source.columns。给了就能把
    "拿文本函数比日期列"这类**依赖列类型**的规则判准（列本来就是 varchar 就不报）。
    """
    sql = sql or ""
    if not is_pg_family(dialect):
        return [{
            "level": "info", "code": "DIALECT-NOT-PG",
            "message": f"当前方言 {normalize(dialect)!r} 不在 PG/GP 适配范围内",
            "suggestion": "若目标库是 PostgreSQL/Greenplum，把 dialect 设为 greenplum 后再检查",
            "snippet": "",
        }]
    out = []
    for r in _rules_target_pg():
        for m in r["pattern"].finditer(sql):
            snippet = sql[max(0, m.start() - 12):m.end() + 12].replace("\n", " ")
            if r["code"] in _TYPE_SENSITIVE and _declared_text(m.group(0), known_types):
                break  # 列已声明为文本，这条规则不适用
            out.append({
                "level": r["level"], "code": r["code"], "message": r["message"],
                "suggestion": r["suggestion"], "snippet": snippet.strip(),
            })
            break  # 同一规则只报一次，避免刷屏
    return out


def lint_summary(sql: str, dialect: str = "greenplum", known_types=None) -> str:
    issues = lint(sql, dialect, known_types)
    if not issues:
        return "SQL 方言检查通过（PostgreSQL / Greenplum 兼容）。"
    lines = [f"SQL 方言检查：{len(issues)} 项"]
    for i in issues:
        lines.append(f"  [{i['level']}] {i['code']}: {i['message']} —— {i['suggestion']}")
        if i["snippet"]:
            lines.append(f"        片段: {i['snippet']}")
    return "\n".join(lines)


def page_query(dialect: str = "greenplum", page_size: str = "20") -> str:
    """帆软 <PageQuery> 的分页语句。PG/GP 用 LIMIT/OFFSET；不需要分页就留空。"""
    if is_pg_family(dialect):
        return f"LIMIT {page_size} OFFSET ({{page}} - 1) * {page_size}"
    return ""


PG_NOTES = [
    "标识符：未加引号的英文名会被折叠成小写；混合大小写、保留字、带特殊字符一律用双引号。中文别名可裸写，但建议统一加双引号。",
    "字符串拼接用 `||`（或 `concat()`）；`+` 只做数值加法。",
    "日期：`to_char(col,'YYYY-MM')` 格式化、`date_trunc('month',col)` 取月初、`col + interval '1 day'` 偏移、`'2025-01-01'::date` 显式转。",
    "分页：`LIMIT n OFFSET m`；Greenplum 与 PostgreSQL 一致。",
    "类型转换用 `::`（如 `system_value::numeric`），或 `CAST(x AS numeric)`。",
    "Greenplum 是 MPP：尽量避免不带分布键的大表 JOIN、避免 `SELECT ... FOR UPDATE`、`DISTINCT` 大结果集要留意数据倾斜。",
    "帆软 `${param}` 是文本替换：字符串要自己加单引号，日期要 `::date`，多值要 `in (${ids})`；参数值必须由平台侧校验，避免拼接注入。",
]
