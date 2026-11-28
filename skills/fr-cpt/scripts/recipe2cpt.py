# -*- coding: utf-8 -*-
"""recipe2cpt — 「源表 + 自然语言描述」→ 配方（recipe）→ CPT。

为什么要有配方这一层：自然语言不可审计，直接生成不可回滚。配方是**人可读、机器可校验、
可进版本库**的中间产物——它把"要什么表"固定成显式字段：哪些列是维度、哪些是度量、
汇总怎么算、公式引用哪一格、用哪个数据集参数。模型只负责把话翻译成配方，编译是确定性的。

配方结构（字段含义见下方 FIELDS 与 references/formulas-and-params.md）：

    {
      "title": "2025年地区销量明细",
      "sheet_name": "sales_detail",
      "report_kind": "analysis",              // analysis | entry
      "standard": "zjky",
      "source": {
        "name": "ds1", "type": "sql",          // sql | embedded
        "connection": "FRDemo",
        "query": "SELECT ... WHERE dt = '${biz_date}'",
        "parameters": [{"name": "biz_date", "value": "2025-01-01"}],
        "columns": [{"name": "地区", "type": "string"}, {"name": "销量", "type": "integer"}],
        "rows": [["华东", 120]]                // embedded 时必填
      },
      "columns": [
        {"label": "地区", "field": "地区", "kind": "dimension", "group": true},
        {"label": "销量", "field": "销量", "kind": "measure", "format": "#,##0"}
      ],
      "formulas": [
        {"label": "占比", "expr": "=D{datarow}/D{footer}", "format": "0.00%"}
      ],
      "footer": [ {"text": "合计"}, {"agg": "sum", "field": "销量"} ],
      "write_back": { ... }                    // report_kind=entry 时可选
    }

用法：
    python tools/recipe2cpt.py 配方.json --out 结果.cpt [--xlsx 预览.xlsx] [--plan]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import frcpt  # noqa: E402
import zjky  # noqa: E402
import xlsx2cpt  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

AGGS = {"sum", "count", "avg", "max", "min"}


class RecipeError(Exception):
    pass


# ---------------------------------------------------------------- 校验
def validate_recipe(r: Dict[str, Any]) -> List[str]:
    """配方自身的完整性检查。返回问题列表（空 = 通过）。"""
    errs: List[str] = []
    src = r.get("source") or {}
    if not src.get("name"):
        errs.append("source.name 必填（数据集名，单元格按它绑定）")
    kind = (src.get("type") or "sql").lower()
    if kind not in ("sql", "embedded"):
        errs.append(f"source.type 只能是 sql / embedded，收到 {kind!r}")
    if kind == "sql":
        if not src.get("query"):
            errs.append("source.type=sql 时 source.query 必填")
        if not src.get("connection"):
            errs.append("source.type=sql 时 source.connection 必填（平台上已存在的数据连接名）")
        for p in src.get("parameters") or []:
            if not p.get("name"):
                errs.append("source.parameters 每项都要有 name")
            elif "${" + p["name"] + "}" not in (src.get("query") or ""):
                errs.append(f"参数 {p['name']} 声明了但 SQL 里没有 ${{{p['name']}}} 占位")
    else:
        if not src.get("columns"):
            errs.append("source.type=embedded 时 source.columns 必填")
        if src.get("rows") is None:
            errs.append("source.type=embedded 时 source.rows 必填（可为空数组）")

    known_fields = {c.get("name") for c in (src.get("columns") or []) if c.get("name")}
    cols = r.get("columns") or []
    if not cols:
        errs.append("columns 不能为空（至少一个维度或度量）")
    for i, c in enumerate(cols):
        if not c.get("label"):
            errs.append(f"columns[{i}].label 必填（表头文字）")
        if not c.get("field"):
            errs.append(f"columns[{i}].field 必填（源表字段名）")
        elif known_fields and c["field"] not in known_fields:
            errs.append(f"columns[{i}].field={c['field']!r} 不在 source.columns 里")
        k = (c.get("kind") or "dimension").lower()
        if k not in ("dimension", "measure"):
            errs.append(f"columns[{i}].kind 只能是 dimension / measure")
        if k == "measure" and c.get("agg") and c["agg"] not in AGGS:
            errs.append(f"columns[{i}].agg 只能是 {sorted(AGGS)}")

    for i, f in enumerate(r.get("formulas") or []):
        if not f.get("expr"):
            errs.append(f"formulas[{i}].expr 必填，形如 =D{{datarow}}/D{{footer}}")
        elif not f["expr"].lstrip().startswith("="):
            errs.append(f"formulas[{i}].expr 必须以 = 开头")

    footer = r.get("footer") or []
    if footer:
        n = len(cols) + len(r.get("formulas") or [])
        if len(footer) != n:
            errs.append(f"footer 长度 {len(footer)} 与列数 {n} 不匹配（要对齐到每一列）")
        for i, f in enumerate(footer):
            if "agg" in f:
                if f["agg"] not in AGGS:
                    errs.append(f"footer[{i}].agg 只能是 {sorted(AGGS)}")
                if not f.get("field"):
                    errs.append(f"footer[{i}] 用了 agg 就必须给 field")
                elif known_fields and f["field"] not in known_fields:
                    errs.append(f"footer[{i}].field={f['field']!r} 不在 source.columns 里")
    return errs


# ---------------------------------------------------------------- 编译
def _source_dataset(r: Dict[str, Any]) -> frcpt.Dataset:
    src = r["source"]
    kind = (src.get("type") or "sql").lower()
    if kind == "sql":
        return frcpt.SqlDataset(
            name=src["name"],
            connection=src["connection"],
            query=src["query"],
            parameters=[frcpt.Parameter(p["name"], str(p.get("value", "")))
                        for p in (src.get("parameters") or [])],
            page_query=src.get("page_query", ""),
            max_mem_row_count=int(src.get("max_mem_row_count", -1)),
        )
    cols = [(c["name"], c.get("type", "string")) for c in src["columns"]]
    rows = [list(x) for x in (src.get("rows") or [])]
    return frcpt.EmbeddedDataset(name=src["name"], columns=cols, rows=rows)


def compile_recipe(r: Dict[str, Any]) -> frcpt.Workbook:
    errs = validate_recipe(r)
    if errs:
        raise RecipeError("配方有问题：\n  - " + "\n  - ".join(errs))

    ds = _source_dataset(r)
    wb = frcpt.Workbook(datasets=[ds])
    sheet = frcpt.Sheet(name=r.get("sheet_name") or "sheet1")

    cols: List[Dict[str, Any]] = r["columns"]
    formulas: List[Dict[str, Any]] = r.get("formulas") or []
    footer: List[Dict[str, Any]] = r.get("footer") or []
    ncols = len(cols) + len(formulas)
    has_title = bool(r.get("title"))
    header_row = 1 if has_title else 0
    data_row = header_row + 1
    footer_row = data_row + 1 if footer else None
    nrows = (footer_row + 1) if footer_row is not None else (data_row + 1)
    nrows += int(r.get("tail_blank_rows", 2))

    def sub(expr: str) -> str:
        """把 {datarow}/{footer} 占位替换成真实的 1 基行号，方便自然语言里写公式。"""
        out = expr.replace("{datarow}", str(data_row + 1))
        if footer_row is not None:
            out = out.replace("{footer}", str(footer_row + 1))
        return out

    def put(c, rr, value, role):
        cell = frcpt.Cell(c=c, r=rr, value=value)
        sheet.add(cell)
        roles[(c, rr)] = role
        return cell

    roles: Dict[Tuple[int, int], str] = {}
    if has_title:
        put(0, 0, frcpt.Text(r["title"]), zjky.TITLE)
        for c in range(1, ncols):
            # 标题横跨整表：只保留左上角一格，其余由 cs 覆盖
            pass
        sheet.cells[-1].cs = ncols

    for i, c in enumerate(cols):
        put(i, header_row, frcpt.Text(c["label"]), zjky.TITLE)
    for j, f in enumerate(formulas):
        put(len(cols) + j, header_row, frcpt.Text(f["label"]), zjky.TITLE)

    for i, c in enumerate(cols):
        kind = (c.get("kind") or "dimension").lower()
        dscol = frcpt.DSColumn(
            ds_name=ds.name, column_name=c["field"],
            grouper="group" if c.get("group") else None,
            aggregate=c.get("agg") if kind == "measure" else None,
            expand_dir=1 if (c.get("expand") or "").lower() in ("right", "横向") else 0,
        )
        cell = put(i, data_row, dscol, zjky.BODY_NUM if kind == "measure" else zjky.BODY_TEXT)
        cell.expand = frcpt.Expand() if dscol.aggregate else frcpt.Expand(direction=dscol.expand_dir)
        if c.get("format"):
            st = zjky.style_for(zjky.BODY_NUM if kind == "measure" else zjky.BODY_TEXT)
            st.number_format = c["format"]
            cell.style_hint = st  # 见下方统一取样式
    for j, f in enumerate(formulas):
        cell = put(len(cols) + j, data_row, frcpt.Formula(sub(f["expr"])), zjky.BODY_NUM)
        cell.expand = frcpt.Expand()
        if f.get("format"):
            st = zjky.style_for(zjky.BODY_NUM)
            st.number_format = f["format"]
            cell.style_hint = st

    if footer:
        for i, f in enumerate(footer):
            rr = footer_row
            if "agg" in f:
                cell = put(i, rr, frcpt.DSColumn(ds_name=ds.name, column_name=f["field"],
                                                 aggregate=f["agg"]), zjky.BODY_NUM)
                cell.expand = frcpt.Expand()
            elif f.get("expr"):
                cell = put(i, rr, frcpt.Formula(sub(f["expr"])), zjky.BODY_NUM)
                cell.expand = frcpt.Expand()
            else:
                # 合计行首格是正文里的标签，规范没有单独的"合计"角色，按正文文字处理
                put(i, rr, frcpt.Text(f.get("text", "")), zjky.BODY_TEXT)

    # 样式：先用标准，再叠配方里的数字格式覆盖
    hints = {id(c): getattr(c, "style_hint", None) for c in sheet.cells}
    layout = zjky.Layout(header_rows=header_row + 1,
                         has_left_header=bool(r.get("has_left_header")),
                         tail_blank_rows=int(r.get("tail_blank_rows", 2)))
    zjky.apply(sheet, roles, layout, wb.styles, entry=(r.get("report_kind") == "entry"))
    for cell in sheet.cells:
        h = hints.get(id(cell))
        if h is not None:
            cell.style = wb.styles.add(h)
    for cell in sheet.cells:
        if hasattr(cell, "style_hint"):
            delattr(cell, "style_hint")

    wb.sheets.append(sheet)
    if (r.get("report_kind") or "analysis").lower() == "entry" and r.get("write_back"):
        sheet.write_back = xlsx2cpt._build_writeback(r["write_back"], None, {})
    return wb


# ---------------------------------------------------------------- Excel 预览
def to_preview_xlsx(r: Dict[str, Any], path: str) -> str:
    """把配方渲染成一张 Excel，供人确认版式后再生成 CPT。"""
    from openpyxl import Workbook as XW
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = XW()
    ws = wb.active
    ws.title = "报表"
    cols = r["columns"]
    formulas = r.get("formulas") or []
    footer = r.get("footer") or []
    ncols = len(cols) + len(formulas)
    row = 1
    if r.get("title"):
        ws.cell(row=row, column=1, value=r["title"]).font = Font(size=14, bold=True)
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=ncols)
        row += 1
    for i, c in enumerate(cols + formulas):
        cell = ws.cell(row=row, column=i + 1, value=c["label"])
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="FF1D9390")
        cell.alignment = Alignment(horizontal="center")
    row += 1
    data_row = row
    for i, c in enumerate(cols):
        marker = f"{{{{{r['source']['name']}.{c['field']}"
        if c.get("group"):
            marker += "|group"
        if c.get("agg"):
            marker += f"|{c['agg']}"
        marker += "}}"
        ws.cell(row=row, column=i + 1, value=marker)
    for j, f in enumerate(formulas):
        ws.cell(row=row, column=len(cols) + j + 1,
                value=f["expr"].replace("{datarow}", str(data_row)).replace("{footer}", str(data_row + 1)))
    if footer:
        row += 1
        for i, f in enumerate(footer):
            if "agg" in f:
                ws.cell(row=row, column=i + 1,
                        value=f"{{{{{r['source']['name']}.{f['field']}|{f['agg']}}}}}")
            elif f.get("expr"):
                ws.cell(row=row, column=i + 1, value=f["expr"])
            else:
                ws.cell(row=row, column=i + 1, value=f.get("text", ""))
    for i in range(ncols):
        ws.column_dimensions[chr(65 + i)].width = 14
    wb.save(path)
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description="配方 → CPT")
    ap.add_argument("recipe")
    ap.add_argument("--out")
    ap.add_argument("--xlsx", help="同时导出一份 Excel 预览")
    ap.add_argument("--plan", action="store_true", help="只校验配方，不生成")
    a = ap.parse_args(argv)

    r = json.load(open(a.recipe, encoding="utf-8-sig"))
    errs = validate_recipe(r)
    print("配方校验：" + ("通过" if not errs else f"{len(errs)} 个问题"))
    for e in errs:
        print("  -", e)
    if errs:
        return 1
    if a.plan:
        return 0

    wb = compile_recipe(r)
    issues = frcpt.validate(wb)
    zissues = zjky.check(wb, entry=(r.get("report_kind") == "entry"))
    print(frcpt.describe_issue_summary(issues))
    print("\n--- 6.2 规范自查 ---")
    print(frcpt.describe_issue_summary(zissues) if zissues else "符合 6.2 报表规范。")

    out = a.out or os.path.splitext(a.recipe)[0] + ".cpt"
    wb.save(out)
    print(f"\n已写出: {out} ({os.path.getsize(out)} bytes)")
    if a.xlsx:
        to_preview_xlsx(r, a.xlsx)
        print(f"Excel 预览: {a.xlsx}")
    return 0 if not [i for i in issues if i.level == "error"] else 1


if __name__ == "__main__":
    sys.exit(main())
