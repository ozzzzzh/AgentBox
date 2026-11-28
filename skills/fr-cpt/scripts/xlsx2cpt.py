# -*- coding: utf-8 -*-
"""xlsx2cpt — build a FineReport .cpt from an Excel sheet plus an explicit dataset config.

The Excel file supplies the *layout*: text, numbers, formulas, merges, fonts, borders,
row heights and column widths.  The JSON config supplies the *data model*: datasets
(SQL / in-template / server-dataset alias) and, if you want, explicit cell bindings.

Cell markers (whole-cell), default delimiters {{ }}:

    {{ds1.地区}}             列表扩展（纵向）
    {{ds1.地区|right}}       横向扩展
    {{ds1.地区|group}}       分组扩展（纵向）
    {{ds1.销量|sum}}         汇总（不扩展）；也支持 count / avg / max / min
    {{ds1.销量|group|right}} 分组 + 横向
    {{=A2+B2}}               公式
    {{text:合计：}}          纯文本（避免被识别成绑定）

Usage:
    python tools/xlsx2cpt.py config.json [--out FILE] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import frcpt  # noqa: E402
import zjky  # noqa: E402
import dialect  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# openpyxl border style name -> com.fr.stable.Constants LINE_*
BORDER_STYLE = {
    "none": frcpt.LINE_NONE,
    "hair": frcpt.LINE_HAIR,
    "thin": frcpt.LINE_THIN,
    "dotted": frcpt.LINE_DOT,
    "dashed": frcpt.LINE_DASH,
    "medium": frcpt.LINE_MEDIUM,
    "mediumDashed": frcpt.LINE_DASH,
    "double": frcpt.LINE_DOUBLE,
    "thick": frcpt.LINE_THICK,
}
HALIGN = {"center": frcpt.ALIGN_CENTER, "left": frcpt.ALIGN_LEFT,
          "right": frcpt.ALIGN_RIGHT, "justify": frcpt.ALIGN_LEFT,
          "general": None, None: None}
VALIGN = {"center": frcpt.ALIGN_CENTER, "top": frcpt.ALIGN_TOP,
          "bottom": frcpt.ALIGN_BOTTOM, "justify": frcpt.ALIGN_CENTER, None: None}


# --------------------------------------------------------------------------- helpers
def color_of(obj, attr="rgb") -> Optional[str]:
    """openpyxl color -> 'RRGGBB' or None when the colour is theme/indexed."""
    if obj is None:
        return None
    try:
        if getattr(obj, "type", None) == "rgb":
            rgb = getattr(obj, attr, None)
            if rgb and len(str(rgb)) == 8 and not str(rgb).startswith("00"):
                return str(rgb)[2:]
            if rgb and len(str(rgb)) == 6:
                return str(rgb)
        return None
    except Exception:
        return None


def border_of(side) -> frcpt.Border:
    if side is None or side.style is None:
        return frcpt.Border(frcpt.LINE_NONE)
    style = BORDER_STYLE.get(side.style, frcpt.LINE_THIN)
    c = color_of(side.color)
    return frcpt.Border(style, frcpt.fr_color(c) if c else -16777216)


def style_from_cell(cell, defaults: dict) -> frcpt.Style:
    st = frcpt.Style()
    font = cell.font
    if font is not None:
        st.font_name = font.name or defaults.get("font_name", "SimSun")
        if font.sz:
            st.font_size = frcpt.pt_to_font_size(float(font.sz))
        st.font_style = (1 if font.b else 0) | (2 if font.i else 0)
        c = color_of(font.color)
        if c:
            st.foreground = frcpt.fr_color(c)
        if font.u:
            st.underline = 1
    fill = cell.fill
    if fill is not None and getattr(fill, "patternType", None) == "solid":
        c = color_of(fill.fgColor)
        if c:
            st.background = frcpt.fr_color(c)
    al = cell.alignment
    if al is not None:
        st.horizontal_alignment = HALIGN.get(al.horizontal)
        st.vertical_alignment = VALIGN.get(al.vertical)
        if al.wrap_text:
            st.text_control = 1
    st.top = border_of(cell.border.top)
    st.bottom = border_of(cell.border.bottom)
    st.left = border_of(cell.border.left)
    st.right = border_of(cell.border.right)
    nf = cell.number_format
    if nf and nf != "General":
        st.number_format = nf
    return st


MARKER_RE = re.compile(r"\{\{(.+?)\}\}")


def parse_marker(text: str, delims: Tuple[str, str]):
    """Return ('column'|'formula'|'text', payload) for a whole-cell marker, else None."""
    open_d, close_d = delims
    s = (text or "").strip()
    if not (s.startswith(open_d) and s.endswith(close_d)):
        return None
    inner = s[len(open_d):-len(close_d)].strip()
    if not inner:
        return None
    if inner.startswith("="):
        return ("formula", inner)
    if inner.startswith("text:"):
        return ("text", inner[5:])
    parts = [p.strip() for p in inner.split("|")]
    head = parts[0]
    if "." not in head:
        return None
    ds, col = head.split(".", 1)
    spec = {"ds": ds.strip(), "col": col.strip(), "expand": "down",
            "group": False, "aggregate": None}
    for opt in parts[1:]:
        low = opt.lower()
        if low in ("right", "横向", "h"):
            spec["expand"] = "right"
        elif low in ("down", "纵向", "v"):
            spec["expand"] = "down"
        elif low in ("group", "分组"):
            spec["group"] = True
        elif low in ("sum", "count", "avg", "max", "min"):
            spec["aggregate"] = low
        else:
            raise ValueError(f"无法识别的标记选项 {opt!r}（标记 {text!r}）")
    return ("column", spec)


# --------------------------------------------------------------------------- datasets
def build_datasets(cfg: Dict[str, Any], xls) -> List[frcpt.Dataset]:
    out: List[frcpt.Dataset] = []
    for spec in cfg.get("datasets", []):
        kind = (spec.get("type") or "sql").lower()
        name = spec.get("name") or f"ds{len(out) + 1}"
        if kind in ("sql", "db", "dbtabledata"):
            params = [frcpt.Parameter(p["name"], str(p.get("value", "")))
                      for p in spec.get("parameters", [])]
            out.append(frcpt.SqlDataset(
                name=name,
                connection=spec.get("connection", "FRDemo"),
                query=spec.get("query", ""),
                parameters=params,
                page_query=spec.get("page_query", ""),
                max_mem_row_count=int(spec.get("max_mem_row_count", -1)),
            ))
        elif kind in ("embedded", "inner", "内置", "embeddedtabledata"):
            out.append(_embedded_from_spec(name, spec, xls))
        elif kind in ("alias", "server", "引用"):
            out.append(frcpt.AliasDataset(name=name, target=spec.get("target", "")))
        else:
            raise ValueError(f"未知的数据集类型 {kind!r}（数据集 {name}）")
    return out


def _embedded_from_spec(name: str, spec: Dict[str, Any], xls) -> frcpt.EmbeddedDataset:
    columns = [(c["name"], c.get("type", "string")) for c in spec.get("columns", [])]
    rows: List[List[Any]] = [list(r) for r in spec.get("rows", [])]
    src = spec.get("from_excel")
    if src:
        if xls is None:
            raise ValueError("数据集用了 from_excel，但没有加载 Excel")
        ws = xls[src["sheet"]] if src.get("sheet") in xls.sheetnames else xls[xls.sheetnames[0]]
        header_row = int(src.get("header_row", 1))
        first = int(src.get("first_data_row", header_row + 1))
        cols = src.get("columns")  # e.g. "A:D"; default: used range
        if cols:
            m = re.match(r"([A-Z]+)\s*[:：]\s*([A-Z]+)", cols.upper())
            if not m:
                raise ValueError(f"from_excel.columns 格式应为 'A:D'，收到 {cols!r}")
            c1 = _col_index(m.group(1))
            c2 = _col_index(m.group(2))
        else:
            c1, c2 = 0, ws.max_column - 1
        if not columns:
            names = []
            for ci in range(c1, c2 + 1):
                v = ws.cell(row=header_row, column=ci + 1).value
                names.append(str(v).strip() if v not in (None, "") else f"col{ci + 1}")
            data = _read_rows(ws, header_row + 1, c1, c2)
            columns = [(n, _infer_type([r[i] for r in data])) for i, n in enumerate(names)]
        if not rows:
            data = _read_rows(ws, first, c1, c2)
            for r in data:
                rows.append([_coerce(v, columns[i][1]) if i < len(columns) else v
                             for i, v in enumerate(r)])
    return frcpt.EmbeddedDataset(name=name, columns=columns, rows=rows)


def _col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _read_rows(ws, start_row: int, c1: int, c2: int) -> List[List[Any]]:
    rows = []
    for r in range(start_row, ws.max_row + 1):
        vals = [ws.cell(row=r, column=ci + 1).value for ci in range(c1, c2 + 1)]
        if all(v in (None, "") for v in vals):
            continue
        rows.append(vals)
    return rows


def _infer_type(values) -> str:
    vals = [v for v in values if v not in (None, "")]
    if not vals:
        return "string"
    if all(isinstance(v, bool) for v in vals):
        return "boolean"
    if all(isinstance(v, int) and not isinstance(v, bool) for v in vals):
        return "integer"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        return "double"
    return "string"


def _coerce(value, typ: str):
    if value is None:
        return ""
    t = typ.lower()
    try:
        if t in ("integer", "int", "long"):
            return int(value)
        if t in ("double", "float", "decimal", "bigdecimal"):
            return float(value)
    except (TypeError, ValueError):
        return str(value)
    return value if isinstance(value, str) else str(value)


# --------------------------------------------------------------------------- sheet
def build_sheet(xls, cfg: Dict[str, Any], styles: frcpt.StyleTable,
                ds_map: Dict[str, frcpt.Dataset]) -> frcpt.Sheet:
    sheet_name = cfg.get("sheet") or xls.sheetnames[0]
    ws = xls[sheet_name] if sheet_name in xls.sheetnames else xls[xls.sheetnames[0]]
    delims = (cfg.get("markers", {}).get("open", "{{"),
              cfg.get("markers", {}).get("close", "}}"))
    defaults = cfg.get("defaults", {})

    sh = frcpt.Sheet(name=cfg.get("report_name") or "sheet1")

    # column widths: Excel characters -> px -> FU
    dflt_chars = float(ws.sheet_format.defaultColWidth or 8.43)
    sh.default_col_width = frcpt.px_to_fu(frcpt.char_width_to_px(dflt_chars))
    widths: Dict[int, int] = {}
    for key, dim in ws.column_dimensions.items():
        if not dim.width:
            continue
        try:
            lo = dim.min or _col_index(key) + 1
            hi = dim.max or lo
        except Exception:
            continue
        fu = frcpt.px_to_fu(frcpt.char_width_to_px(dim.width))
        for ci in range(lo - 1, hi):
            widths[ci] = fu
    mc = max([ws.max_column] + [c + 1 for c in widths] or [1]) - 1
    sh.col_widths = [widths.get(i, sh.default_col_width) for i in range(mc + 1)]

    # row heights: Excel points -> FU
    dflt_pt = float(ws.sheet_format.defaultRowHeight or 14.25)
    sh.default_row_height = frcpt.pt_to_fu(dflt_pt)
    heights: Dict[int, int] = {}
    for r, dim in ws.row_dimensions.items():
        if dim.height:
            heights[r - 1] = frcpt.pt_to_fu(dim.height)
    mr = max([ws.max_row] + [r + 1 for r in heights] or [1]) - 1
    sh.row_heights = [heights.get(i, sh.default_row_height) for i in range(mr + 1)]

    # merges -> cs/rs of the anchor cell
    span: Dict[Tuple[int, int], Tuple[int, int]] = {}
    covered = set()
    for rng in ws.merged_cells.ranges:
        span[(rng.min_col - 1, rng.min_row - 1)] = (rng.max_col - rng.min_col + 1,
                                                    rng.max_row - rng.min_row + 1)
        for rr in range(rng.min_row, rng.max_row + 1):
            for cc in range(rng.min_col, rng.max_col + 1):
                if (cc - 1, rr - 1) != (rng.min_col - 1, rng.min_row - 1):
                    covered.add((cc - 1, rr - 1))

    explicit = {}
    for b in cfg.get("bindings", []):
        if b.get("sheet") and b["sheet"] != sheet_name:
            continue
        ref = str(b["cell"]).upper()
        m = re.match(r"([A-Z]+)(\d+)", ref)
        if not m:
            raise ValueError(f"bindings 里的单元格引用非法: {ref!r}")
        explicit[(_col_index(m.group(1)), int(m.group(2)) - 1)] = b

    for r in range(mr + 1):
        for c in range(mc + 1):
            if (c, r) in covered:
                # cells under a merge do not exist in FineReport's model
                continue
            cell = ws.cell(row=r + 1, column=c + 1)
            ref = frcpt.cell_ref(c, r)
            value = _cell_value(cell, cfg, delims, ds_map, ref, explicit.get((c, r)))
            style = style_from_cell(cell, defaults)
            has_span = (c, r) in span
            if value is None and not has_span and cell.value in (None, "") and not _style_is_plain(style):
                value = frcpt.Blank()
            if value is None:
                continue
            cellobj = frcpt.Cell(c=c, r=r, value=value,
                                 style=styles.add(style) if not _style_is_plain(style) else None)
            if has_span:
                cellobj.cs, cellobj.rs = span[(c, r)]
            _apply_expand(cellobj, value)
            sh.add(cellobj)
    return sh


def _style_is_plain(st: frcpt.Style) -> bool:
    plain = frcpt.Style()
    return st.key() == plain.key()


def _cell_value(cell, cfg, delims, ds_map, ref, explicit) -> Optional[frcpt.CellValue]:
    # 1. explicit binding wins
    if explicit:
        kind = explicit.get("kind", "column")
        if kind == "column":
            return frcpt.DSColumn(ds_name=explicit["dataset"], column_name=explicit["column"],
                                  grouper="group" if explicit.get("group") else None,
                                  aggregate=explicit.get("aggregate"))
        if kind == "formula":
            return frcpt.Formula(explicit["expr"])
        if kind == "text":
            return frcpt.Text(str(explicit["text"]))
    raw = cell.value
    if raw is None or raw == "":
        return None
    # 2. marker in the cell text
    if isinstance(raw, str):
        marker = parse_marker(raw, delims)
        if marker:
            kind, payload = marker
            if kind == "formula":
                return frcpt.Formula(payload)
            if kind == "text":
                return frcpt.Text(payload)
            ds = payload["ds"]
            if ds not in ds_map:
                raise ValueError(f"{ref}: 标记引用了未定义的数据集 {ds!r}")
            return frcpt.DSColumn(ds_name=ds, column_name=payload["col"],
                                  grouper="group" if payload["group"] else None,
                                  aggregate=payload["aggregate"],
                                  expand_dir=1 if payload["expand"] == "right" else 0)
        if MARKER_RE.search(raw):
            raise ValueError(f"{ref}: 标记必须独占整个单元格，当前为 {raw!r}")
        if raw.startswith("=") and cfg.get("options", {}).get("keep_excel_formulas", True):
            return frcpt.Formula(raw)
        return frcpt.Text(raw)
    if isinstance(raw, bool):
        return frcpt.Number(1 if raw else 0)
    if isinstance(raw, (int, float)):
        return frcpt.Number(raw)
    return frcpt.Text(str(raw))


def _apply_expand(cell: frcpt.Cell, value) -> None:
    if isinstance(value, frcpt.DSColumn) and value.is_expandable:
        cell.expand = frcpt.Expand(direction=value.expand_dir)
    elif isinstance(value, frcpt.DSColumn):
        cell.expand = frcpt.Expand(direction=None)


# --------------------------------------------------------------------------- build
def _build_writeback(spec: Dict[str, Any], xls, cfg: Dict[str, Any]) -> Optional[frcpt.WriteBack]:
    """填报提交配置（一条提交规则 = 一个 SubmitVisitor / 一张目标表）。"""
    if not spec:
        return None
    wb = frcpt.WriteBack(
        name=spec.get("submitter_name") or spec.get("name") or "内置SQL1",
        ds_name=spec.get("connection") or spec.get("ds_name") or "FRDemo",
        table_schema=spec.get("schema", ""),
        table_name=spec.get("table", "") or spec.get("table_name", ""),
        update_attr=bool(spec.get("update_status", True)),
    )
    for m in spec.get("mappings", []):
        cm = frcpt.ColumnMapping(column_name=m.get("column", ""),
                                 is_key=bool(m.get("is_key", False)))
        # ① 单格 / 多格映射
        if m.get("cells"):
            for ref in m["cells"]:
                mm = re.match(r"([A-Z]+)(\d+)", str(ref).upper())
                if not mm:
                    raise ValueError(f"write_back.mappings.cells 里的引用非法: {ref!r}")
                cm.rows.append((_col_index(mm.group(1)), int(mm.group(2)) - 1))
        elif m.get("cell"):
            mm = re.match(r"([A-Z]+)(\d+)", str(m["cell"]).upper())
            if not mm:
                raise ValueError(f"write_back.mappings.cell 非法: {m['cell']!r}")
            cm.column, cm.row = _col_index(mm.group(1)), int(mm.group(2)) - 1
        # ② 直接给值公式（控件参数等）
        if m.get("formula"):
            cm.formula = m["formula"]
        # ③ 命名参数（提交时算出来的键，如"上季度末"）
        if m.get("parameter"):
            p = m["parameter"]
            cm.parameter = (p.get("name", ""), p.get("expr", ""))
        wb.mappings.append(cm)
    return wb


def _build_writebacks(spec: Any, xls, cfg: Dict[str, Any]) -> List[frcpt.WriteBack]:
    """支持单条（dict）或多条（list）提交规则——生产模板常有多张目标表。"""
    if not spec:
        return []
    specs = spec if isinstance(spec, list) else [spec]
    return [w for w in (_build_writeback(s, xls, cfg) for s in specs) if w is not None]


def apply_standard(wb: frcpt.Workbook, cfg: Dict[str, Any]) -> None:
    """按 6.2 规范刷样式/行高列宽/冻结/填报表条件属性。

    走了规范就不该再留着 Excel 自己的样式（那正是"重复配置"的来源），
    因此这里重建样式表：先摘掉所有单元格的旧样式下标，再按角色重新上样式。
    """
    entry = (cfg.get("report_kind") or "analysis").lower() in ("entry", "填报", "fill")
    tail = int(cfg.get("tail_blank_rows", 2))
    wb.styles = frcpt.StyleTable()
    for sh in wb.sheets:
        for cell in sh.cells:
            cell.style = None
    for sh, sheet_cfg in zip(wb.sheets, cfg.get("sheets") or [cfg]):
        roles, layout = zjky.infer_roles(sh, wb, entry)
        # 允许配置覆盖角色：{"A2": "上侧表头", "D3": "数字"}
        for ref, role in (cfg.get("roles") or {}).items():
            m = re.match(r"([A-Z]+)(\d+)", str(ref).upper())
            if not m:
                raise ValueError(f"roles 里的单元格引用非法: {ref!r}")
            roles[(_col_index(m.group(1)), int(m.group(2)) - 1)] = zjky._role_key(role)
        layout.tail_blank_rows = tail
        zjky.apply(sh, roles, layout, wb.styles, entry=entry)
        if entry:
            sh.write_backs = _build_writebacks(
                cfg.get("write_backs") or cfg.get("write_back"), None, cfg)


def build(cfg: Dict[str, Any], cfg_dir: str) -> frcpt.Workbook:
    xlsx_path = cfg.get("excel")
    xls = None
    if xlsx_path:
        p = xlsx_path if os.path.isabs(xlsx_path) else os.path.join(cfg_dir, xlsx_path)
        xls = load_workbook(p, data_only=False)
    datasets = build_datasets(cfg, xls)
    ds_map = {d.name: d for d in datasets}
    wb = frcpt.Workbook(
        datasets=datasets,
        xml_version=cfg.get("template", {}).get("xml_version", frcpt.XML_VERSION),
        release_version=cfg.get("template", {}).get("release_version", frcpt.RELEASE_VERSION),
    )
    if xls is not None:
        sheets_cfg = cfg.get("sheets") or [cfg]
        for sc in sheets_cfg:
            wb.sheets.append(build_sheet(xls, {**cfg, **sc}, wb.styles, ds_map))
        if (cfg.get("standard") or "").lower() in ("zjky", "紫金", "6.2"):
            apply_standard(wb, cfg)
    return wb


def main(argv=None):
    ap = argparse.ArgumentParser(description="Excel + dataset config -> FineReport .cpt")
    ap.add_argument("config")
    ap.add_argument("--out", help="override output path")
    ap.add_argument("--dry-run", action="store_true", help="build + validate, do not write")
    ap.add_argument("--adapt", action="store_true",
                    help="按 PG/GP 方言自动改写数据集 SQL（方括号/TOP/ISNULL 等）")
    a = ap.parse_args(argv)
    cfg_path = os.path.abspath(a.config)
    cfg = json.load(open(cfg_path, encoding="utf-8-sig"))
    cfg_dir = os.path.dirname(cfg_path)

    d = dialect.normalize(cfg.get("dialect") or "greenplum")
    if a.adapt:
        for spec in cfg.get("datasets", []):
            if (spec.get("type") or "sql").lower() in ("sql", "db", "dbtabledata") and spec.get("query"):
                spec["query"] = dialect.adapt(spec["query"], d)
    wb = build(cfg, cfg_dir)

    sql_issues = []
    for ds in wb.datasets:
        if isinstance(ds, frcpt.SqlDataset):
            sql_issues.extend(dialect.lint(ds.query, d))
    if any(isinstance(ds, frcpt.SqlDataset) for ds in wb.datasets):
        print(f"--- SQL 方言检查（目标 {d}）---")
        if sql_issues:
            for i in sql_issues:
                print(f"  [{i['level']}] {i['code']}: {i['message']} —— {i['suggestion']}")
        else:
            print("SQL 方言检查通过（PostgreSQL / Greenplum 兼容）。")

    issues = frcpt.validate(wb)
    print(frcpt.describe_issue_summary(issues))
    if (cfg.get("standard") or "").lower() in ("zjky", "紫金", "6.2"):
        entry = (cfg.get("report_kind") or "analysis").lower() in ("entry", "填报", "fill")
        zissues = zjky.check(wb, entry=entry)
        print("\n--- 6.2 规范自查 ---")
        print(frcpt.describe_issue_summary(zissues) if zissues else "符合 6.2 报表规范。")

    out = a.out or cfg.get("output") or "out/generated.cpt"
    out = out if os.path.isabs(out) else os.path.join(cfg_dir, out)
    if a.dry_run:
        print(f"[dry-run] 未写出。目标: {out}")
        return 0 if all(i.level != "error" for i in issues) else 1
    wb.save(out)
    size = os.path.getsize(out)
    print(f"已写出: {out} ({size} bytes)")
    print(f"数据集 {len(wb.datasets)} 个，sheet {len(wb.sheets)} 个，样式 {len(wb.styles.styles)} 条")
    return 0 if all(i.level != "error" for i in issues) else 1


if __name__ == "__main__":
    sys.exit(main())
