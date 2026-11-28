# -*- coding: utf-8 -*-
"""cpt_patch — 对话式修改 CPT 的执行引擎。

设计原则：自然语言由模型翻译成**一份有限的、可审计的操作列表**（JSON ops），
本工具只做确定性执行 + 变更清单 + 规范校验。这样"改了什么"永远说得清，
而模型幻觉成不了一次无法回滚的二进制改动。

用法：
    python tools/cpt_patch.py 目标.cpt ops.json [--out 输出.cpt] [--plan] [--in-place]
    python tools/cpt_patch.py 目标.cpt --show-selectors        # 看当前可用的目标选择器

操作（按顺序执行，每条都产出变更记录）：

    {"op":"set_style","target":"role:上侧表头","style":{"fill":"1D9390","bold":true}}
    {"op":"set_style","target":"A1:D2","role":"标题"}
    {"op":"set_value","target":"A1","value":"2024年销量"}
    {"op":"set_formula","target":"D4","expr":"=sum(D3)"}
    {"op":"bind","target":"A3","dataset":"ds1","column":"地区","mode":"group","expand":"down"}
    {"op":"unbind","target":"A3"}
    {"op":"merge","range":"A1:D1"}  /  {"op":"unmerge","target":"A1"}
    {"op":"resize","rows":"1-4","height_mm":7}  /  {"op":"resize","cols":"A-D","width_mm":28}
    {"op":"freeze","cell":"A3"}  /  {"op":"freeze","cell":null}
    {"op":"add_tail_rows","count":2}
    {"op":"highlight","target":"D3:D100","formula":"$op = 'view'","fill":"FFFFFF"}
    {"op":"add_dataset","dataset":{...}}      # 与 xlsx2cpt 的数据集配置同构
    {"op":"update_dataset","name":"ds1","query":"SELECT ..."}
    {"op":"delete_dataset","name":"ds2"}
    {"op":"writeback","spec":{...}}           # 填报表提交配置
    {"op":"apply_standard","kind":"analysis","tail_blank_rows":2}
    {"op":"rename_sheet","name":"sales_detail"}
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

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

STYLE_ALIGN = {"left": frcpt.ALIGN_LEFT, "center": frcpt.ALIGN_CENTER,
               "right": frcpt.ALIGN_RIGHT, "左": frcpt.ALIGN_LEFT,
               "中": frcpt.ALIGN_CENTER, "居中": frcpt.ALIGN_CENTER,
               "右": frcpt.ALIGN_RIGHT}
STYLE_VALIGN = {"top": frcpt.ALIGN_TOP, "center": frcpt.ALIGN_CENTER,
                "bottom": frcpt.ALIGN_BOTTOM, "上": frcpt.ALIGN_TOP,
                "中": frcpt.ALIGN_CENTER, "下": frcpt.ALIGN_BOTTOM}
LINE_NAMES = {"none": frcpt.LINE_NONE, "thin": frcpt.LINE_THIN, "solid": frcpt.LINE_THIN,
              "medium": frcpt.LINE_MEDIUM, "dash": frcpt.LINE_DASH, "dashed": frcpt.LINE_DASH,
              "hair": frcpt.LINE_HAIR, "thick": frcpt.LINE_THICK,
              "double": frcpt.LINE_DOUBLE, "dot": frcpt.LINE_DOT, "dotted": frcpt.LINE_DOT}


class PatchError(Exception):
    pass


# --------------------------------------------------------------------------- selectors
def _col_index(letters: str) -> int:
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _ref_col(ref: str) -> str:
    return re.match(r"([A-Z]+)", ref.upper()).group(1)


def parse_ref(ref: str) -> Tuple[int, int]:
    m = re.match(r"^([A-Z]+)(\d+)$", ref.strip().upper())
    if not m:
        raise PatchError(f"单元格引用非法: {ref!r}（应形如 A1）")
    return _col_index(m.group(1)), int(m.group(2)) - 1


def parse_selector(sel: str) -> Tuple[str, Any]:
    s = (sel or "all").strip()
    low = s.lower()
    if low in ("all", "全部"):
        return ("all", None)
    if low in ("formula", "formulas", "公式格"):
        return ("kind", "formula")
    if low in ("number", "numbers", "数字格"):
        return ("kind", "number")
    if low in ("bound", "data", "数据列"):
        return ("kind", "bound")
    if low in ("text", "文字格"):
        return ("kind", "text")
    if ":" in s:
        head, _, rest = s.partition(":")
        h = head.strip().lower()
        if h in ("role", "角色"):
            return ("role", zjky._role_key(rest))
        if h in ("row", "rows", "行"):
            return ("rows", rest.strip())
        if h in ("col", "cols", "列"):
            return ("cols", rest.strip())
        if h in ("kind",):
            return ("kind", rest.strip().lower())
        raise PatchError(f"不认识的选择器前缀: {head!r}")
    m = re.match(r"^([A-Z]+)(\d+):([A-Z]+)(\d+)$", s.upper())
    if m:
        c1, r1 = _col_index(m.group(1)), int(m.group(2)) - 1
        c2, r2 = _col_index(m.group(3)), int(m.group(4)) - 1
        return ("range", (min(c1, c2), min(r1, r2), max(c1, c2), max(r1, r2)))
    if re.match(r"^[A-Z]+\d+$", s.upper()):
        return ("cell", parse_ref(s))
    raise PatchError(f"无法解析的目标: {sel!r}")


def _span_set(spec: str) -> List[int]:
    spec = spec.strip()
    m = re.match(r"^(\d+)-(\d+)$", spec)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return list(range(min(a, b) - 1, max(a, b)))
    if re.match(r"^\d+$", spec):
        return [int(spec) - 1]
    return []


def _col_span(spec: str) -> List[int]:
    spec = spec.strip().upper()
    m = re.match(r"^([A-Z]+)-([A-Z]+)$", spec)
    if m:
        a, b = _col_index(m.group(1)), _col_index(m.group(2))
        return list(range(min(a, b), max(a, b) + 1))
    if re.match(r"^[A-Z]+$", spec):
        return [_col_index(spec)]
    return []


def select_cells(wb: frcpt.Workbook, sheet: frcpt.Sheet, selector: str) -> List[frcpt.Cell]:
    kind, arg = parse_selector(selector)
    cells = list(sheet.cells)
    if kind == "all":
        return cells
    if kind == "cell":
        c, r = arg
        return [x for x in cells if x.c == c and x.r == r]
    if kind == "range":
        c1, r1, c2, r2 = arg
        return [x for x in cells if c1 <= x.c <= c2 and r1 <= x.r <= r2]
    if kind == "rows":
        want = set(_span_set(arg))
        return [x for x in cells if x.r in want]
    if kind == "cols":
        want = set(_col_span(arg))
        return [x for x in cells if x.c in want]
    if kind == "kind":
        if arg == "formula":
            return [x for x in cells if isinstance(x.value, frcpt.Formula)]
        if arg == "number":
            return [x for x in cells if isinstance(x.value, frcpt.Number)]
        if arg == "bound":
            return [x for x in cells if isinstance(x.value, frcpt.DSColumn)]
        return [x for x in cells if isinstance(x.value, frcpt.Text)]
    if kind == "role":
        roles, _ = zjky.infer_roles(sheet, wb)
        want = zjky._role_key(arg)
        return [x for x in cells if roles.get((x.c, x.r)) == want]
    raise PatchError(f"未实现的选择器: {selector!r}")


# --------------------------------------------------------------------------- style helpers
def current_style(wb: frcpt.Workbook, cell: frcpt.Cell) -> frcpt.Style:
    if cell.style is not None and 0 <= cell.style < len(wb.styles.styles):
        return wb.styles.styles[cell.style]
    return frcpt.Style()


def apply_style_overrides(st: frcpt.Style, ov: Dict[str, Any]) -> frcpt.Style:
    s = frcpt.Style(**{k: getattr(st, k) for k in st.__dataclass_fields__})
    for k, v in ov.items():
        key = k.strip()
        if key in ("font", "font_name", "字体"):
            s.font_name = str(v)
        elif key in ("font_size", "size", "字号"):
            s.font_size = frcpt.pt_to_font_size(float(v))
        elif key in ("bold", "加粗"):
            s.font_style = (s.font_style | 1) if v else (s.font_style & ~1)
        elif key in ("italic", "斜体"):
            s.font_style = (s.font_style | 2) if v else (s.font_style & ~2)
        elif key in ("color", "font_color", "字色", "字体颜色"):
            s.foreground = frcpt.fr_color(v)
        elif key in ("fill", "background", "底色", "填充"):
            s.background = None if v in (None, "none", "无") else frcpt.fr_color(v)
        elif key in ("align", "horizontal_alignment", "对齐"):
            s.horizontal_alignment = STYLE_ALIGN.get(str(v).lower(), STYLE_ALIGN.get(str(v)))
        elif key in ("valign", "vertical_alignment", "垂直对齐"):
            s.vertical_alignment = STYLE_VALIGN.get(str(v).lower(), STYLE_VALIGN.get(str(v)))
        elif key in ("wrap", "换行"):
            s.text_control = None if v else 1
        elif key in ("no_wrap", "不换行"):
            s.text_control = 1 if v else None
        elif key in ("number_format", "数字格式"):
            s.number_format = str(v) if v not in (None, "") else None
        elif key in ("padding_left", "左缩进"):
            s.padding_left = int(v)
        elif key in ("padding_right", "右缩进"):
            s.padding_right = int(v)
        elif key in ("border", "边框"):
            if v in (None, "none", "无"):
                for side in ("top", "bottom", "left", "right"):
                    setattr(s, side, frcpt.Border(frcpt.LINE_NONE))
            else:
                line = LINE_NAMES.get(str(v).lower(), frcpt.LINE_THIN) if not isinstance(v, int) else v
                for side in ("top", "bottom", "left", "right"):
                    b = getattr(s, side)
                    setattr(s, side, frcpt.Border(line, b.color))
        elif key in ("border_color", "边框颜色"):
            col = frcpt.fr_color(v)
            for side in ("top", "bottom", "left", "right"):
                b = getattr(s, side)
                setattr(s, side, frcpt.Border(b.style or frcpt.LINE_THIN, col))
        elif key in ("border_style", "边框线型"):
            line = LINE_NAMES.get(str(v).lower(), frcpt.LINE_THIN) if not isinstance(v, int) else v
            for side in ("top", "bottom", "left", "right"):
                b = getattr(s, side)
                setattr(s, side, frcpt.Border(line, b.color))
        else:
            raise PatchError(f"不认识的样式属性: {key!r}")
    return s


# --------------------------------------------------------------------------- ops
class Patcher:
    def __init__(self, wb: frcpt.Workbook):
        self.wb = wb
        self.log: List[str] = []

    # -- reporting -------------------------------------------------------
    def _note(self, msg: str) -> None:
        self.log.append(msg)

    def _sheet(self, name: Optional[str]) -> frcpt.Sheet:
        if not self.wb.sheets:
            raise PatchError("模板里没有 sheet")
        if not name:
            return self.wb.sheets[0]
        for sh in self.wb.sheets:
            if sh.name == name:
                return sh
        raise PatchError(f"找不到 sheet {name!r}（现有: {', '.join(s.name for s in self.wb.sheets)}）")

    # -- dispatch --------------------------------------------------------
    def run(self, ops: List[Dict[str, Any]], plan: bool = False) -> List[Dict[str, Any]]:
        records = []
        for i, op in enumerate(ops):
            name = (op.get("op") or "").strip()
            handler = getattr(self, f"op_{name}", None)
            if handler is None:
                raise PatchError(f"第 {i + 1} 条操作未知: {name!r}"
                                 f"（可用: {', '.join(x[3:] for x in dir(self) if x.startswith('op_'))}）")
            before = len(self.log)
            affected = handler(op) or 0
            records.append({
                "index": i + 1, "op": name, "affected": affected,
                "notes": self.log[before:],
            })
        return records

    # -- individual ops --------------------------------------------------
    def op_set_style(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cells = select_cells(self.wb, sh, op.get("target", "all"))
        ov = dict(op.get("style") or {})
        role = op.get("role")
        for cell in cells:
            ref = frcpt.cell_ref(cell.c, cell.r)
            old = current_style(self.wb, cell)
            if role:
                new = zjky.style_for(zjky._role_key(role))
                if ov:
                    new = apply_style_overrides(new, ov)
                self._note(f"{ref} 样式 → 角色「{zjky.ROLE_LABEL.get(zjky._role_key(role), role)}」")
            else:
                new = apply_style_overrides(old, ov)
                self._note(f"{ref} 样式调整: {', '.join(ov)}")
            cell.style = self.wb.styles.add(new)
        return len(cells)

    def op_set_value(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cells = select_cells(self.wb, sh, op.get("target"))
        value = op.get("value")
        if isinstance(value, bool):
            new = frcpt.Number(1 if value else 0)
        elif isinstance(value, (int, float)):
            new = frcpt.Number(value)
        else:
            new = frcpt.Text("" if value is None else str(value))
        for cell in cells:
            ref = frcpt.cell_ref(cell.c, cell.r)
            self._note(f"{ref} 值 {self._brief(cell.value)} → {self._brief(new)}")
            cell.value = new
            cell.expand = frcpt.Expand()
        return len(cells)

    def op_set_formula(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cells = select_cells(self.wb, sh, op.get("target"))
        expr = op.get("expr") or op.get("formula") or ""
        for cell in cells:
            ref = frcpt.cell_ref(cell.c, cell.r)
            self._note(f"{ref} 公式 {self._brief(cell.value)} → ={expr.lstrip('=')}")
            cell.value = frcpt.Formula(expr)
        return len(cells)

    def op_bind(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cells = select_cells(self.wb, sh, op.get("target"))
        ds = op.get("dataset")
        col = op.get("column")
        if not ds or not col:
            raise PatchError("bind 需要 dataset 与 column")
        if ds not in [d.name for d in self.wb.datasets]:
            raise PatchError(f"数据集 {ds!r} 不存在（现有: {', '.join(d.name for d in self.wb.datasets)}）")
        mode = (op.get("mode") or "list").lower()
        agg = op.get("aggregate")
        if mode in ("sum", "count", "avg", "max", "min"):
            agg, mode = mode, "summary"
        direction = 1 if (op.get("expand") or "").lower() in ("right", "横向", "h") else 0
        for cell in cells:
            ref = frcpt.cell_ref(cell.c, cell.r)
            cell.value = frcpt.DSColumn(
                ds_name=ds, column_name=col,
                grouper="group" if mode in ("group", "分组") else None,
                aggregate=agg,
                expand_dir=direction,
            )
            if agg:
                cell.expand = frcpt.Expand()
            else:
                cell.expand = frcpt.Expand(direction=direction)
            self._note(f"{ref} 绑定 → {ds}.{col}"
                       f"{'（分组）' if mode in ('group', '分组') else ''}"
                       f"{'（汇总 ' + agg + '）' if agg else ''}")
        return len(cells)

    def op_unbind(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cells = select_cells(self.wb, sh, op.get("target"))
        for cell in cells:
            if not isinstance(cell.value, frcpt.DSColumn):
                continue
            ref = frcpt.cell_ref(cell.c, cell.r)
            self._note(f"{ref} 解除绑定 {cell.value.ds_name}.{cell.value.column_name}")
            cell.value = frcpt.Blank()
            cell.expand = frcpt.Expand()
        return len(cells)

    def op_merge(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        rng = op.get("range") or op.get("target")
        kind, arg = parse_selector(rng)
        if kind != "range":
            raise PatchError(f"merge 需要 A1:D1 形式的范围，收到 {rng!r}")
        c1, r1, c2, r2 = arg
        anchor = next((c for c in sh.cells if c.c == c1 and c.r == r1), None)
        if anchor is None:
            anchor = frcpt.Cell(c=c1, r=r1, value=frcpt.Blank())
            sh.cells.append(anchor)
        anchor.cs, anchor.rs = c2 - c1 + 1, r2 - r1 + 1
        sh.cells = [c for c in sh.cells
                    if c is anchor or not (c1 <= c.c <= c2 and r1 <= c.r <= r2)]
        self._note(f"合并 {rng}（{anchor.cs}×{anchor.rs}），被覆盖的格子已移除")
        return 1

    def op_unmerge(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cells = select_cells(self.wb, sh, op.get("target"))
        n = 0
        for cell in cells:
            if cell.cs > 1 or cell.rs > 1:
                self._note(f"{frcpt.cell_ref(cell.c, cell.r)} 取消合并 {cell.cs}×{cell.rs}")
                cell.cs = cell.rs = 1
                n += 1
        return n

    def op_resize(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        n = 0
        if op.get("rows") is not None:
            fu = zjky.mm_to_fu(float(op["height_mm"])) if op.get("height_mm") is not None else \
                int(op.get("height_fu", frcpt.DEFAULT_ROW_HEIGHT_FU))
            rows = _span_set(str(op["rows"]))
            for r in rows:
                while len(sh.row_heights) <= r:
                    sh.row_heights.append(sh.default_row_height)
                sh.row_heights[r] = fu
                n += 1
            self._note(f"行 {op['rows']} 行高 → {fu} FU（{fu / zjky.FU_PER_MM:.2f}mm）")
        if op.get("cols") is not None:
            fu = zjky.mm_to_fu(float(op["width_mm"])) if op.get("width_mm") is not None else \
                int(op.get("width_fu", frcpt.DEFAULT_COL_WIDTH_FU))
            cols = _col_span(str(op["cols"]))
            for c in cols:
                while len(sh.col_widths) <= c:
                    sh.col_widths.append(sh.default_col_width)
                sh.col_widths[c] = fu
                n += 1
            self._note(f"列 {op['cols']} 列宽 → {fu} FU（{fu / zjky.FU_PER_MM:.2f}mm）")
        return n

    def op_freeze(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cell = op.get("cell")
        if cell:
            c, r = parse_ref(cell)
            sh.frozen = frcpt.cell_ref(c, r)
            self._note(f"冻结锚点 → {sh.frozen}（左上方行/列冻结）")
        else:
            sh.frozen = None
            self._note("取消冻结")
        return 1

    def op_add_tail_rows(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        count = int(op.get("count", 2))
        fu = zjky.mm_to_fu(float(op["height_mm"])) if op.get("height_mm") else sh.default_row_height
        mc, mr = sh.extent()
        while len(sh.row_heights) < mr + 1:
            sh.row_heights.append(sh.default_row_height)
        sh.row_heights.extend([fu] * count)
        self._note(f"底部追加 {count} 个空行（{fu / zjky.FU_PER_MM:.2f}mm），总行数 {len(sh.row_heights)}")
        return count

    def op_highlight(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        cells = select_cells(self.wb, sh, op.get("target"))
        formula = op.get("formula") or op.get("condition") or ""
        fill = frcpt.fr_color(op.get("fill", "FFFFFF"))
        name = op.get("name") or "条件属性1"
        for cell in cells:
            cell.highlights.append(frcpt.Highlight(name=name, formula=formula,
                                                   background=fill, scope=1))
            self._note(f"{frcpt.cell_ref(cell.c, cell.r)} 增加条件属性 {formula!r} → 底色 "
                       f"{fill & 0xFFFFFF:06X}")
        return len(cells)

    def op_add_dataset(self, op) -> int:
        import xlsx2cpt
        spec = op.get("dataset") or {}
        ds = xlsx2cpt.build_datasets({"datasets": [spec]}, None)[0]
        if ds.name in [d.name for d in self.wb.datasets]:
            raise PatchError(f"数据集 {ds.name!r} 已存在")
        self.wb.datasets.append(ds)
        self._note(f"新增数据集 {ds.describe()}")
        return 1

    def op_update_dataset(self, op) -> int:
        name = op.get("name")
        for ds in self.wb.datasets:
            if ds.name != name:
                continue
            if isinstance(ds, frcpt.SqlDataset):
                if "query" in op:
                    self._note(f"{name} SQL: {ds.query[:40]!r} → {str(op['query'])[:40]!r}")
                    ds.query = op["query"]
                if "connection" in op:
                    ds.connection = op["connection"]
                if "parameters" in op:
                    ds.parameters = [frcpt.Parameter(p["name"], str(p.get("value", "")))
                                     for p in op["parameters"]]
            elif isinstance(ds, frcpt.EmbeddedDataset):
                if "columns" in op:
                    ds.columns = [(c["name"], c.get("type", "string")) for c in op["columns"]]
                if "rows" in op:
                    ds.rows = [list(r) for r in op["rows"]]
            self._note(f"更新数据集 {name}")
            return 1
        raise PatchError(f"数据集 {name!r} 不存在")

    def op_delete_dataset(self, op) -> int:
        name = op.get("name")
        before = len(self.wb.datasets)
        self.wb.datasets = [d for d in self.wb.datasets if d.name != name]
        if len(self.wb.datasets) == before:
            raise PatchError(f"数据集 {name!r} 不存在")
        self._note(f"删除数据集 {name}")
        return 1

    def op_writeback(self, op) -> int:
        import xlsx2cpt
        sh = self._sheet(op.get("sheet"))
        sh.write_back = xlsx2cpt._build_writeback(op.get("spec") or {}, None, {})
        self._note(f"填报提交：表 {sh.write_back.table_name}，{len(sh.write_back.mappings)} 个字段映射")
        return 1

    def op_apply_standard(self, op) -> int:
        import xlsx2cpt
        entry = (op.get("kind") or "analysis").lower() in ("entry", "填报", "fill")
        cfg = {"standard": "zjky", "report_kind": op.get("kind", "analysis"),
               "tail_blank_rows": op.get("tail_blank_rows", 2),
               "roles": op.get("roles") or {}}
        xlsx2cpt.apply_standard(self.wb, cfg)
        self._note(f"按 6.2 规范重刷（{'填报表' if entry else '分析表'}）")
        return len(self.wb.sheets)

    def op_rename_sheet(self, op) -> int:
        sh = self._sheet(op.get("sheet"))
        old = sh.name
        sh.name = op.get("name") or old
        self._note(f"sheet 改名 {old} → {sh.name}")
        return 1

    # -- utils -----------------------------------------------------------
    @staticmethod
    def _brief(v) -> str:
        if isinstance(v, frcpt.Text):
            return f"文字{v.text!r}"
        if isinstance(v, frcpt.Number):
            return f"数字{v.value!r}"
        if isinstance(v, frcpt.Formula):
            return f"公式{v.expr!r}"
        if isinstance(v, frcpt.DSColumn):
            return f"数据列{v.ds_name}.{v.column_name}"
        return "空"


def main(argv=None):
    ap = argparse.ArgumentParser(description="对话式修改 CPT（操作列表执行器）")
    ap.add_argument("file")
    ap.add_argument("ops", nargs="?", help="ops JSON 文件；省略则配合 --show-selectors")
    ap.add_argument("--out")
    ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--plan", action="store_true", help="只报告变更，不写文件")
    ap.add_argument("--entry", action="store_true", help="按填报表口径做 6.2 校验")
    ap.add_argument("--show-selectors", action="store_true")
    a = ap.parse_args(argv)

    wb = frcpt.read_cpt(a.file)
    if a.show_selectors:
        print("可用目标选择器：")
        print("  A1 / A1:D5            单元格或区域")
        print("  row:2 / rows:2-4      整行")
        print("  col:A / cols:A-D      整列")
        print("  role:上侧表头         按 6.2 角色（上侧表头/左侧表头/数字/文字/取数与公式）")
        print("  formula / number / bound / text   按值类型")
        print("  all                   全部")
        for sh in wb.sheets:
            roles, layout = zjky.infer_roles(sh, wb, a.entry)
            print(f"\nsheet {sh.name}: header_rows={layout.header_rows} "
                  f"left_header={layout.has_left_header} frozen={sh.frozen}")
            counts = {}
            for (c, r), role in roles.items():
                counts[role] = counts.get(role, 0) + 1
            for role, n in sorted(counts.items()):
                print(f"  {zjky.ROLE_LABEL.get(role, role):<12} {n} 个单元格")
        return 0

    if not a.ops:
        ap.error("需要 ops.json 或 --show-selectors")
    ops = json.load(open(a.ops, encoding="utf-8-sig"))
    if isinstance(ops, dict):
        ops = ops.get("ops", [])
    patcher = Patcher(wb)

    print(f"=== 目标: {os.path.basename(a.file)} ===")
    records = patcher.run(ops, plan=a.plan)
    for rec in records:
        print(f"\n[{rec['index']}] {rec['op']}  影响 {rec['affected']} 处")
        for note in rec["notes"][:12]:
            print("    ·", note)
        if len(rec["notes"]) > 12:
            print(f"    · … 另外 {len(rec['notes']) - 12} 条")

    issues = frcpt.validate(wb)
    zissues = zjky.check(wb, entry=a.entry)
    print("\n--- 结构校验 ---")
    print(frcpt.describe_issue_summary(issues))
    print("\n--- 6.2 规范自查 ---")
    print(frcpt.describe_issue_summary(zissues) if zissues else "符合 6.2 报表规范。")

    if a.plan:
        print("\n[plan] 未写文件。")
        return 0
    out = a.file if a.in_place else (a.out or re.sub(r"\.cpt$", ".patched.cpt", a.file))
    wb.save(out)
    print(f"\n已写出: {out} ({os.path.getsize(out)} bytes)")
    return 0 if not [i for i in issues if i.level == "error"] else 1


if __name__ == "__main__":
    sys.exit(main())
