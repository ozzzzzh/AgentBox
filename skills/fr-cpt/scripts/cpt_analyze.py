# -*- coding: utf-8 -*-
"""cpt_analyze — 解析 CPT，沉淀「单元格 ↔ 源表字段 ↔ 加工逻辑」的逻辑图，并给出可执行的修复建议。

产出三样东西：

  1. 血缘清单：每个单元格的类型 / 来源（数据集列 / 字面量 / 公式）/ 加工（分组、汇总、过滤、排序）/ 依赖
  2. 还原 SQL：按血缘反推一段"这段报表大概等价于什么查询"，用于和源表核对口径
  3. 诊断 + 修复 ops：循环引用、引用空单元格、孤儿列、重复绑定等，每条都附可直接喂给
     `cpt_patch.py` 的修复操作；`--fix` 可直接落盘

用法：
    python tools/cpt_analyze.py 模板.cpt                     # 人读的逻辑图
    python tools/cpt_analyze.py 模板.cpt --mermaid           # Mermaid 流程图
    python tools/cpt_analyze.py 模板.cpt --json out.json     # 机器可读血缘
    python tools/cpt_analyze.py 模板.cpt --md 报告.md        # 落成文档
    python tools/cpt_analyze.py 模板.cpt --fix               # 只修"安全"问题，输出 *.fixed.cpt
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import frcpt  # noqa: E402
import zjky  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

AGG_LABEL = {"sum": "SUM", "count": "COUNT", "avg": "AVG", "max": "MAX", "min": "MIN"}

# ---------------------------------------------------------------- 公式解析
_STR_RE = re.compile(r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"")
_RANGE_RE = re.compile(r"\b([A-Z]{1,3})(\d+)\s*:\s*([A-Z]{1,3})(\d+)\b")
_CELL_RE = re.compile(r"(?<![A-Za-z0-9_.$])([A-Z]{1,3})(\d+)(?![A-Za-z0-9_(])")
_SELECT_RE = re.compile(r"([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\.(select|group)\(([^)]*)\)")
_PARAM_RE = re.compile(r"\$([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)")
_FUNC_RE = re.compile(r"([A-Za-z_]\w*)\s*\(")
_SELF_RE = re.compile(r"^(?:[A-Za-z_.]*?)([A-Z]{1,3})(\d+)$")


def parse_formula(expr: str) -> Dict[str, Any]:
    """把一段帆软公式拆成：引用的单元格 / 区域 / 数据集取值 / 参数 / 函数。"""
    body = expr.strip()
    if body.startswith("="):
        body = body[1:]
    clean = _STR_RE.sub("''", body)          # 字符串字面量不参与引用解析
    ranges = []
    for m in _RANGE_RE.finditer(clean):
        ranges.append({"from": f"{m.group(1)}{m.group(2)}", "to": f"{m.group(3)}{m.group(4)}"})
    no_range = _RANGE_RE.sub(" ", clean)
    cells = []
    for m in _CELL_RE.finditer(no_range):
        ref = f"{m.group(1)}{m.group(2)}"
        # 形如 ds1.select(...) 里不会有 A1；但 sum(D3) 的 D3 会被捕获，正确
        cells.append(ref)
    selects = []
    for m in _SELECT_RE.finditer(clean):
        ds, fn, arg = m.group(1), m.group(2), m.group(3)
        cols = [c.strip().strip("'\"") for c in arg.split(",") if c.strip()]
        selects.append({"dataset": ds, "func": fn, "columns": cols})
    params = sorted(set(_PARAM_RE.findall(clean)))
    funcs = sorted({f.lower() for f in _FUNC_RE.findall(clean)} - {"sum", "count", "avg", "max", "min", "if"})
    return {"cells": sorted(set(cells)), "ranges": ranges, "selects": selects,
            "params": params, "funcs": funcs}


# ---------------------------------------------------------------- 血缘
@dataclass
class CellLineage:
    ref: str
    c: int
    r: int
    kind: str                      # header | column | summary | formula | literal | empty
    source: str = ""               # ds1.销量 / 字面量 / 公式表达式
    transform: str = ""            # 分组 / SUM / 过滤 / 排序 / 无
    depends_on: List[str] = field(default_factory=list)
    origin: List[str] = field(default_factory=list)   # 追溯到的最底层：ds.col
    note: str = ""


def _cond_desc(cond) -> str:
    if cond is None:
        return ""
    cls = (cond.get("class") or "").split(".")[-1]
    name = cond.findtext("CNAME") or ""
    if cls == "CommonCondition":
        op = cond.find("Compare")
        rhs = ""
        if op is not None:
            sd = op.find("SimpleDSColumn")
            if sd is not None:
                rhs = f"{sd.get('dsName')}.{sd.get('columnName')}"
            elif op.text:
                rhs = op.text.strip()
        return f"过滤 {name} = {rhs}".strip()
    if cls == "ListCondition":
        return "过滤（列表/多值）"
    if cls == "FormulaCondition":
        f = cond.findtext("Formula")
        return f"过滤（公式 {f.strip() if f else '?'}）"
    return f"过滤（{cls}）"


def build_lineage(wb: frcpt.Workbook, sheet: frcpt.Sheet,
                  entry: bool = False) -> Tuple[List[CellLineage], Dict[str, frcpt.Issue]]:
    roles, layout = zjky.infer_roles(sheet, wb, entry)
    cmap = {(c.c, c.r): c for c in sheet.cells}
    out: List[CellLineage] = []
    for cell in sorted(sheet.cells, key=lambda x: (x.r, x.c)):
        ref = frcpt.cell_ref(cell.c, cell.r)
        v = cell.value
        cl = CellLineage(ref=ref, c=cell.c, r=cell.r, kind="empty")
        if isinstance(v, frcpt.DSColumn):
            cl.kind = "summary" if v.aggregate else "column"
            cl.source = f"{v.ds_name}.{v.column_name}"
            bits = []
            if v.grouper == "group":
                bits.append("分组")
            if v.aggregate:
                bits.append(AGG_LABEL.get(v.aggregate, v.aggregate.upper()))
            cond = _cond_desc(v.condition) if v.condition is not None else ""
            if cond:
                bits.append(cond)
            if cell.expand.direction is not None:
                bits.append("横向扩展" if cell.expand.direction == 1 else "纵向扩展")
            if v.sort_formula or cell.expand.sort_formula:
                bits.append("扩展后排序")
            cl.transform = " → ".join(bits) or "直接取数"
            cl.depends_on = [cl.source]
            cl.origin = [cl.source]
        elif isinstance(v, frcpt.Formula):
            cl.kind = "formula"
            cl.source = v.expr if v.expr.startswith("=") else "=" + v.expr
            info = parse_formula(cl.source)
            cl.depends_on = info["cells"] + [f"{s['dataset']}.{c}"
                                             for s in info["selects"] for c in s["columns"]]
            cl.transform = "公式" + (f"（引用 {len(info['cells'])} 格）" if info["cells"] else "")
            if info["params"]:
                cl.transform += f"；参数 {', '.join('$' + p for p in info['params'])}"
        elif isinstance(v, frcpt.Number):
            cl.kind = "literal"
            cl.source = f"数字 {v.value}"
            cl.transform = "常量"
        elif isinstance(v, frcpt.Text):
            if cell.r < layout.header_rows:
                cl.kind = "header"
                cl.transform = "表头"
            elif v.text.startswith("<chart>"):
                cl.kind = "chart"
                cl.transform = "单元格图表（未建模）"
            elif v.text.startswith("<斜线"):
                cl.kind = "diagonal"
                cl.transform = "斜线表头"
            else:
                cl.kind = "literal"
                cl.transform = "常量"
            cl.source = f"文字 {v.text!r}"[:60]
        else:
            cl.kind = "empty"
            cl.transform = "—"
        cl.note = zjky.ROLE_LABEL.get(roles.get((cell.c, cell.r), ""), "")
        out.append(cl)

    # 二级追溯：公式 → 单元格 → 数据集列（最多 8 层，防环）
    by_ref = {x.ref: x for x in out}
    for cl in out:
        if cl.kind != "formula":
            continue
        seen: Set[str] = set()
        frontier = list(cl.depends_on)
        origins: List[str] = []
        for _ in range(8):
            nxt = []
            for d in frontier:
                if d in seen:
                    continue
                seen.add(d)
                target = by_ref.get(d)
                if target is None:
                    continue
                if target.kind in ("column", "summary"):
                    origins.append(target.source)
                elif target.kind == "formula":
                    nxt.extend(x for x in target.depends_on if "." in x or x in by_ref)
                elif "." in d:
                    origins.append(d)
            frontier = nxt
            if not frontier:
                break
        cl.origin = sorted(set(origins))
    return out, by_ref


def sql_sketch(wb: frcpt.Workbook, sheet: frcpt.Sheet) -> str:
    """还原这段报表的取数口径。

    - 数据集是 SQL 时：直接给**数据集自己的 SQL**（那才是真正的口径来源），
      再补一段"报表在这之上怎么摆"的布局说明。不要伪造 `FROM ds1`——ds1 是数据集不是表。
    - 数据集是内置表时：反推一段等价 SELECT（维度进 GROUP BY，数值度量只进 SELECT）。
    """
    dims, hdims, measures, conds, params, aggs, joins = [], [], [], [], [], [], []
    ds_votes: Dict[str, int] = {}
    for cell in sorted(sheet.cells, key=lambda x: x.r * 1000 + x.c):
        v = cell.value
        if not isinstance(v, frcpt.DSColumn):
            continue
        ds_votes[v.ds_name] = ds_votes.get(v.ds_name, 0) + 1
        if v.aggregate:
            fn = AGG_LABEL.get(v.aggregate, v.aggregate.upper())
            aggs.append(f"{fn}({v.column_name}) AS {v.column_name}_合计")
        elif zjky._column_kind(wb, v.ds_name, v.column_name) == "num":
            measures.append(v.column_name)
        elif cell.expand.direction == 1:
            hdims.append(v.column_name)
        else:
            dims.append(v.column_name)
        if v.condition is not None:
            c = _cond_desc(v.condition).replace("过滤", "").strip().strip("（）")
            if "=" in c and "." in c.split("=", 1)[1]:
                joins.append(f"{v.ds_name}.{c}")
            elif c.startswith("公式"):
                conds.append(f"({c[2:].strip()})")
            elif "列表" in c or "多值" in c:
                conds.append(None)
            elif c:
                conds.append(c)

    def uniq(seq):
        out, seen = [], set()
        for x in seq:
            if x not in seen:
                seen.add(x)
                out.append(x)
        return out

    src = max(ds_votes, key=ds_votes.get) if ds_votes else None
    ds = next((d for d in wb.datasets if d.name == src), None)
    if isinstance(ds, frcpt.SqlDataset):
        params = [f"{p.name} = {p.value!r}" for p in ds.parameters]

    layout = []
    if uniq(dims):
        layout.append("行维度: " + ", ".join(uniq(dims)) + "（纵向分组/扩展）")
    if uniq(hdims):
        layout.append("列维度: " + ", ".join(uniq(hdims)) + "（横向分组/扩展）")
    if uniq(measures):
        layout.append("度量  : " + ", ".join(uniq(measures)) + "（明细取数）")
    if aggs:
        layout.append("汇总  : " + ", ".join(aggs))
    if joins:
        layout.append("跨集关联: " + "; ".join(sorted(set(joins))))
    if params:
        layout.append("数据集参数: " + "; ".join(params))

    if isinstance(ds, frcpt.SqlDataset):
        head = f"/* 数据集 {ds.name}（连接 {ds.connection}）的取数 SQL —— 口径的来源 */"
        body = head + "\n" + ds.query.strip() + "\n"
        if layout:
            body += "\n/* 报表在它之上的呈现 */\n" + "\n".join("-- " + x for x in layout)
        return body

    cols = uniq(dims) + uniq(hdims) + uniq(measures) + aggs
    out = f"SELECT {', '.join(cols) if cols else '*'}\nFROM {src or '（无数据源）'}"
    real_conds = [c for c in conds if c]
    if real_conds:
        out += "\nWHERE " + " AND ".join(real_conds)
    if joins:
        out += "\n-- 跨集关联: " + "; ".join(sorted(set(joins)))
    if len(real_conds) < len(conds):
        out += "\n-- 另有列表/多值过滤条件（ListCondition，需人工核对）"
    if aggs:
        out += "\nGROUP BY " + (", ".join(uniq(dims + hdims)) or "—")
    if params:
        out += "\n-- 数据集参数: " + "; ".join(params)
    return out


# ---------------------------------------------------------------- 诊断
def diagnose(wb: frcpt.Workbook, entry: bool = False) -> List[Dict[str, Any]]:
    """除通用 validate/6.2 之外，血缘层面的问题 + 可执行修复 ops。"""
    diags: List[Dict[str, Any]] = []
    for sh in wb.sheets:
        lineage, by_ref = build_lineage(wb, sh, entry)
        cmap = {(c.c, c.r): c for c in sh.cells}

        # 1. 公式引用了不存在的/空的单元格
        for cl in lineage:
            if cl.kind != "formula":
                continue
            for dep in cl.depends_on:
                if "." in dep:
                    continue
                target = by_ref.get(dep)
                if target is None:
                    diags.append({
                        "level": "error", "code": "L-REF-MISSING",
                        "message": f"{cl.ref} 的公式引用了不存在的单元格 {dep}",
                        "where": sh.name,
                        "fix": [{"op": "set_value", "target": cl.ref, "value": 0}],
                        "fix_hint": f"确认 {dep} 是否被删除；临时可把 {cl.ref} 置 0",
                    })
                elif target.kind == "empty":
                    diags.append({
                        "level": "warning", "code": "L-REF-EMPTY",
                        "message": f"{cl.ref} 的公式引用了空白单元格 {dep}（结果会是 0 或空）",
                        "where": sh.name,
                        "fix": [],
                        "fix_hint": f"在 {dep} 补上取数或常量",
                    })

        # 2. 循环引用
        graph = {cl.ref: [d for d in cl.depends_on if d in by_ref] for cl in lineage}
        state: Dict[str, int] = {}

        def dfs(node: str, stack: List[str]) -> Optional[List[str]]:
            state[node] = 1
            stack.append(node)
            for nxt in graph.get(node, []):
                if state.get(nxt) == 1:
                    return stack[stack.index(nxt):] + [nxt]
                if state.get(nxt, 0) == 0:
                    cyc = dfs(nxt, stack)
                    if cyc:
                        return cyc
            stack.pop()
            state[node] = 2
            return None

        for ref in graph:
            if state.get(ref, 0) == 0:
                cyc = dfs(ref, [])
                if cyc:
                    diags.append({"level": "error", "code": "L-CYCLE",
                                  "message": "公式循环引用: " + " → ".join(cyc),
                                  "where": sh.name, "fix": [],
                                  "fix_hint": "环上任选一格改成取数或常量"})
                    break

        # 3. 孤儿列（数据集有列，但没有任何格子引用）
        used = set()
        for cell in sh.cells:
            v = cell.value
            if isinstance(v, frcpt.DSColumn):
                used.add((v.ds_name, v.column_name))
            elif isinstance(v, frcpt.Formula):
                for s in parse_formula(v.expr)["selects"]:
                    for c in s["columns"]:
                        used.add((s["dataset"], c))
        for ds in wb.datasets:
            if not isinstance(ds, frcpt.EmbeddedDataset):
                continue
            orphans = [n for n, _ in ds.columns if (ds.name, n) not in used]
            if orphans:
                diags.append({
                    "level": "info", "code": "L-ORPHAN-COL",
                    "message": f"数据集 {ds.name} 有未被引用的列: {', '.join(orphans)}",
                    "where": sh.name, "fix": [],
                    "fix_hint": "若确实不需要，可从内置数据集里删列；否则检查是否漏了展示",
                })

        # 4. 同一列重复绑定（非汇总格）
        seen_cols: Dict[str, List[str]] = {}
        for cell in sh.cells:
            v = cell.value
            if isinstance(v, frcpt.DSColumn) and not v.aggregate:
                seen_cols.setdefault(f"{v.ds_name}.{v.column_name}", []).append(
                    frcpt.cell_ref(cell.c, cell.r))
        for k, refs in seen_cols.items():
            if len(refs) > 1:
                diags.append({"level": "info", "code": "L-DUP-BIND",
                              "message": f"{k} 被绑定到多个格子: {', '.join(refs)}",
                              "where": sh.name, "fix": [],
                              "fix_hint": "确认是否刻意重复展示（如跨页签对照）"})

        # 5. 公式里用了 $参数，但模板/数据集都没声明
        declared = set()
        for ds in wb.datasets:
            if isinstance(ds, frcpt.SqlDataset):
                declared |= {p.name for p in ds.parameters}
        for cell in sh.cells:
            v = cell.value
            if isinstance(v, frcpt.Formula):
                for p in parse_formula(v.expr)["params"]:
                    if p not in declared and p != "op":
                        diags.append({
                            "level": "warning", "code": "L-PARAM-UNDECLARED",
                            "message": f"{frcpt.cell_ref(cell.c, cell.r)} 的公式引用了未声明的参数 ${p}",
                            "where": sh.name, "fix": [],
                            "fix_hint": "在数据集 parameters 或模板参数里声明，否则取到空值",
                        })
    return diags


# ---------------------------------------------------------------- 渲染
def to_markdown(path: str, wb: frcpt.Workbook, entry: bool = False) -> str:
    lines = [f"# CPT 逻辑图：`{os.path.basename(path)}`", ""]
    lines.append(f"- xmlVersion `{wb.xml_version}` / releaseVersion `{wb.release_version}`")
    lines.append(f"- sheet {len(wb.sheets)} 个，数据集 {len(wb.datasets)} 个，样式 {len(wb.styles.styles)} 条")
    lines.append("")
    lines.append("## 数据集")
    lines.append("")
    lines.append("| 名称 | 类型 | 内容 |")
    lines.append("|---|---|---|")
    for ds in wb.datasets:
        if isinstance(ds, frcpt.SqlDataset):
            content = f"连接 `{ds.connection}`：`{' '.join(ds.query.split())[:120]}`"
        elif isinstance(ds, frcpt.EmbeddedDataset):
            content = f"内置，{len(ds.columns)} 列 × {len(ds.rows)} 行（{'、'.join(n for n, _ in ds.columns)}）"
        else:
            content = f"引用 {getattr(ds, 'target', '')}"
        lines.append(f"| `{ds.name}` | {type(ds).__name__} | {content} |")
    lines.append("")

    for sh in wb.sheets:
        lineage, _ = build_lineage(wb, sh, entry)
        lines.append(f"## sheet `{sh.name}`")
        lines.append("")
        lines.append("| 单元格 | 类型 | 来源 | 加工逻辑 | 依赖 | 最终溯源 |")
        lines.append("|---|---|---|---|---|---|")
        for cl in lineage:
            if cl.kind == "empty":
                continue
            lines.append(f"| `{cl.ref}` | {cl.kind} | `{cl.source}` | {cl.transform} | "
                         f"{', '.join(cl.depends_on) or '—'} | {', '.join(cl.origin) or '—'} |")
        lines.append("")
        lines.append("**还原查询（用于核对口径，不保证可执行）**")
        lines.append("")
        lines.append("```sql")
        lines.append(sql_sketch(wb, sh))
        lines.append("```")
        lines.append("")

    diags = diagnose(wb, entry)
    lines.append("## 诊断")
    lines.append("")
    if not diags:
        lines.append("血缘层面未发现问题。")
    else:
        for d in diags:
            lines.append(f"- **{d['level'].upper()} {d['code']}**：{d['message']}"
                         + (f" —— {d['fix_hint']}" if d.get("fix_hint") else ""))
    lines.append("")
    return "\n".join(lines)


def to_mermaid(wb: frcpt.Workbook) -> str:
    lines = ["flowchart LR"]
    ds_nodes = {}
    for i, ds in enumerate(wb.datasets):
        nid = f"DS{i}"
        ds_nodes[ds.name] = nid
        lines.append(f'  {nid}["{ds.name}"]')
    for sh in wb.sheets:
        lineage, _ = build_lineage(wb, sh)
        for cl in lineage:
            if cl.kind in ("header", "empty"):
                continue
            cid = f"C_{cl.ref}"
            label = cl.ref
            if cl.kind == "formula":
                label += f"<br/>{cl.source[:28]}"
            elif cl.kind in ("column", "summary"):
                label += f"<br/>{cl.source}"
                if cl.transform:
                    label += f"<br/>{cl.transform[:28]}"
            lines.append(f'  {cid}["{label}"]')
            if "." in cl.source and cl.kind in ("column", "summary"):
                dsn = cl.source.split(".", 1)[0]
                if dsn in ds_nodes:
                    lines.append(f"  {ds_nodes[dsn]} -->|{cl.transform or '取数'}| {cid}")
            for dep in cl.depends_on:
                if "." not in dep and dep:
                    lines.append(f"  C_{dep} --> {cid}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="解析 CPT：血缘 / 逻辑图 / 诊断 / 修复")
    ap.add_argument("file")
    ap.add_argument("--json", help="输出机器可读血缘 JSON")
    ap.add_argument("--mermaid", action="store_true", help="输出 Mermaid 流程图")
    ap.add_argument("--md", help="输出 Markdown 报告")
    ap.add_argument("--entry", action="store_true", help="按填报表口径")
    ap.add_argument("--fix", action="store_true", help="应用安全修复并写出 *.fixed.cpt")
    ap.add_argument("--dialect", help="检查数据集 SQL 的方言兼容性（postgres / greenplum）")
    a = ap.parse_args(argv)

    wb = frcpt.read_cpt(a.file)
    if a.dialect:
        import dialect as frdialect
        for ds in wb.datasets:
            if isinstance(ds, frcpt.SqlDataset):
                print(f"--- 数据集 {ds.name} 的 SQL 方言（目标 {frdialect.normalize(a.dialect)}）---")
                print(frdialect.lint_summary(ds.query, a.dialect))
                print()
    if a.mermaid:
        print(to_mermaid(wb))
        return 0
    if a.md:
        text = to_markdown(a.file, wb, a.entry)
        with open(a.md, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"Markdown 报告 → {a.md}")

    if a.json:
        payload = {"file": a.file, "xmlVersion": wb.xml_version, "sheets": []}
        for sh in wb.sheets:
            lineage, _ = build_lineage(wb, sh, a.entry)
            payload["sheets"].append({
                "name": sh.name,
                "sql_sketch": sql_sketch(wb, sh),
                "cells": [{"ref": cl.ref, "kind": cl.kind, "source": cl.source,
                           "transform": cl.transform, "depends_on": cl.depends_on,
                           "origin": cl.origin, "role": cl.note} for cl in lineage],
            })
        payload["diagnostics"] = diagnose(wb, a.entry)
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"血缘 JSON → {a.json}")

    if not (a.mermaid or a.md or a.json):
        print(to_markdown(a.file, wb, a.entry))

    diags = diagnose(wb, a.entry)
    if a.fix:
        fixable = [d for d in diags if d.get("fix")]
        if not fixable:
            print("没有可自动修复的问题。")
            return 0
        import cpt_patch
        patcher = cpt_patch.Patcher(wb)
        ops = [op for d in fixable for op in d["fix"]]
        print(f"\n=== 应用 {len(fixable)} 条安全修复（{len(ops)} 个操作） ===")
        for rec in patcher.run(ops):
            print(f"[{rec['index']}] {rec['op']} 影响 {rec['affected']} 处")
            for n in rec["notes"]:
                print("    ·", n)
        out = re.sub(r"\.cpt$", ".fixed.cpt", a.file)
        wb.save(out)
        print(f"\n已写出: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
