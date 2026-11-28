# -*- coding: utf-8 -*-
"""cpt_dump — inspect a FineReport .cpt: structure, datasets (blob decoded), cells, issues.

Usage:
  python tools/cpt_dump.py FILE.cpt [--rows 10] [--json out.json] [--no-validate]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import frcpt  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def value_repr(v, wb):
    if isinstance(v, frcpt.DSColumn):
        bits = [f"ds={v.ds_name}", f"col={v.column_name}"]
        if v.grouper:
            bits.append("group")
        if v.aggregate:
            bits.append(f"agg={v.aggregate}")
        if v.condition is not None:
            bits.append("filter")
        return "DSColumn(" + ", ".join(bits) + ")"
    if isinstance(v, frcpt.Formula):
        return f"Formula({v.expr})"
    if isinstance(v, frcpt.Number):
        return f"Number({v.value!r})"
    if isinstance(v, frcpt.Text):
        t = v.text.replace("\n", "\\n")
        return f"Text({t!r})" if len(t) <= 40 else f"Text({t[:40]!r}…)"
    return "Blank"


def dump(path, max_rows=10, do_validate=True, opts=None):
    opts = opts or {}
    raw = open(path, "rb").read()
    wb = frcpt.read_cpt(path)
    root = etree.fromstring(raw)

    print(f"=== {os.path.basename(path)} ===")
    print(f"size          : {len(raw)} bytes")
    print(f"xmlVersion    : {wb.xml_version}")
    print(f"releaseVersion: {wb.release_version}")
    print(f"root children : {', '.join(c.tag for c in root if isinstance(c.tag, str))}")
    print(f"sheets        : {len(wb.sheets)}")
    print(f"datasets      : {len(wb.datasets)}")
    print(f"styles        : {len(wb.styles.styles)}")

    if wb.datasets:
        print("\n--- 数据集 ---")
        all_names = [d.name for d in wb.datasets]
        for ds in wb.datasets:
            print(f"* {ds.describe()}")
            if isinstance(ds, frcpt.SqlDataset):
                for p in ds.parameters:
                    print(f"    参数 {p.name} = {p.value!r}")
                if ds.page_query:
                    print(f"    PageQuery: {ds.page_query[:80]!r}")
                print(f"    maxMemRowCount={ds.max_mem_row_count}")
            if isinstance(ds, frcpt.EmbeddedDataset):
                print(f"    列: {', '.join(n for n, _ in ds.columns)}")
                print(f"    类型: {', '.join(t for _, t in ds.columns)}")
                for i, row in enumerate(ds.rows[:max_rows]):
                    print(f"    row[{i}] = {list(row)}")
                if len(ds.rows) > max_rows:
                    print(f"    … 共 {len(ds.rows)} 行")
                blob = ds.encode_rows()
                print(f"    RowData 摘要: {blob[:48]!r}{'…' if len(blob) > 48 else ''} (len={len(blob)})")
        refs = set()
        for sh in wb.sheets:
            for c in sh.cells:
                if isinstance(c.value, frcpt.DSColumn):
                    refs.add(c.value.ds_name)
        orphan = [n for n in all_names if n not in refs]
        if orphan:
            print(f"\n  (未被任何单元格引用的数据集: {', '.join(orphan)})")

    for sh in wb.sheets:
        mc, mr = sh.extent()
        print(f"\n--- sheet '{sh.name}' ---")
        print(f"grid: {mc + 1} cols x {mr + 1} rows   "
              f"default row={sh.default_row_height} FU col={sh.default_col_width} FU")
        cells = sh.cell_map()
        header = "      " + "".join(f"{frcpt.cell_ref(c, 0)[:-1]:>18}" for c in range(mc + 1))
        print(header)
        for r in range(mr + 1):
            line = f"r{r + 1:<3} "
            for c in range(mc + 1):
                cell = cells.get((c, r))
                if cell is None:
                    line += f"{'·':>18}"
                else:
                    txt = value_repr(cell.value, wb)
                    if cell.cs > 1 or cell.rs > 1:
                        txt = f"[{cell.cs}x{cell.rs}]" + txt
                    line += f"{txt[:18]:>18}"
            print(line)
        # expand details
        for cell in sh.cells:
            if cell.expand.direction is not None or cell.expand.left or cell.expand.up:
                e = cell.expand
                bits = []
                if e.direction is not None:
                    bits.append("横向扩展" if e.direction == 1 else "纵向扩展")
                if e.left:
                    bits.append(f"左父格={e.left}")
                if e.up:
                    bits.append(f"上父格={e.up}")
                if e.order is not None:
                    bits.append(f"排序={e.order}")
                if e.sort_formula:
                    bits.append(f"排序公式={e.sort_formula}")
                print(f"  {frcpt.cell_ref(cell.c, cell.r)}: {', '.join(bits) or '默认扩展'}")

    if do_validate:
        issues = frcpt.validate(wb)
        print("\n--- 校验 ---")
        print(frcpt.describe_issue_summary(issues))
        if opts.get("standard"):
            try:
                import zjky
                zissues = zjky.check(wb, entry=opts.get("entry", False))
                print("\n--- 6.2 规范自查 ---")
                print(frcpt.describe_issue_summary(zissues) if zissues else "符合 6.2 报表规范。")
            except Exception as e:  # pragma: no cover
                print("\n--- 6.2 规范自查 ---\n跳过:", e)
    return wb


def main():
    ap = argparse.ArgumentParser(description="Dump a FineReport .cpt template")
    ap.add_argument("file")
    ap.add_argument("--rows", type=int, default=10)
    ap.add_argument("--no-validate", action="store_true")
    ap.add_argument("--standard", action="store_true", help="同时按紫金 6.2 报表规范自查")
    ap.add_argument("--entry", action="store_true", help="按填报表口径做 6.2 自查")
    ap.add_argument("--json", help="also write a JSON model dump here")
    a = ap.parse_args()
    wb = dump(a.file, a.rows, not a.no_validate,
              opts={"standard": a.standard, "entry": a.entry})
    if a.json:
        payload = {
            "xmlVersion": wb.xml_version,
            "releaseVersion": wb.release_version,
            "datasets": [
                {"name": d.name, "class": type(d).__name__,
                 **({"connection": getattr(d, "connection", None),
                     "query": getattr(d, "query", None)} if isinstance(d, frcpt.SqlDataset) else {}),
                 **({"_columns": [list(c) for c in d.columns],
                     "_rows": [list(r) for r in d.rows]} if isinstance(d, frcpt.EmbeddedDataset) else {})}
                for d in wb.datasets
            ],
            "sheets": [
                {"name": sh.name,
                 "cells": [{"ref": frcpt.cell_ref(c.c, c.r), "c": c.c, "r": c.r,
                            "cs": c.cs, "rs": c.rs, "style": c.style,
                            "value": value_repr(c.value, wb),
                            "expand": c.expand.direction}
                           for c in sh.cells]}
                for sh in wb.sheets
            ],
        }
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"\nJSON model -> {a.json}")


if __name__ == "__main__":
    main()
