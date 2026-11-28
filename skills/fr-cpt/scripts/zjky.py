# -*- coding: utf-8 -*-
"""ZJKY 报表规范（《紫金矿业大数据平台数据开发规范 v1.18》6.2 报表规范）的可执行编码。

规范原文是一张样式表 + 若干条文字规则。本模块把它变成三样东西：

  1. ``styles()``   —— 角色 → Style 的工厂（上侧表头 / 左侧表头 / 正文数字 / 正文文字 / 填报表取数与公式）
  2. ``apply()``    —— 把角色映射刷进一个 Sheet（行高 7mm、列宽 28mm、冻结、底部两行空行、
                       填报表的 E3F1F1 底色 + $op='view' 条件属性）
  3. ``check()``    —— 反向校验：逐单元格比对角色应有的样式，输出带单元格坐标的问题清单

量纲换算依据（见 references/protocol.md）：
  1 mm = 144000 FU（com.fr.stable.Constants.FU_PER_MM）
  字号属性 = 磅 × 8（FRFont.SCALE_TO_FRSIZE）
  颜色 = 有符号 32 位 ARGB

一处推断，已在 check() 里做成可覆盖项：规范表的"缩进 3"没写单位，按同行"行高 7mm / 列宽 28mm"
的上下文取毫米，落到 CPT 的 paddingLeft/paddingRight（单位 px @96dpi，见 Style 默认值 2）时
换算为 11。若贵司实际是按 px 填的 3，把 ``INDENT_MM`` 改成 ``None`` 并令 ``INDENT_PX = 3``。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import frcpt

# ---------------------------------------------------------------- 规范常量
FU_PER_MM = 144000        # com.fr.stable.Constants.FU_PER_MM
PX_PER_MM = 96 / 25.4     # 96dpi

ROW_HEIGHT_MM = 7.0
COL_WIDTH_MM = 28.0
INDENT_MM: Optional[float] = 3.0
INDENT_PX: int = round(INDENT_MM * PX_PER_MM) if INDENT_MM is not None else 3

# 规范样式表（颜色取自 6.2 表格，字体统一微软雅黑）
C_UPPER_FILL = "1D9390"
C_UPPER_BORDER = "FFFFFF"
C_UPPER_FONT = "FFFFFF"
C_LEFT_FILL = "BAE4E3"
C_LEFT_BORDER = "F1FDFD"
C_LEFT_FONT = "06171F"
C_BODY_FILL = "FFFFFF"
C_BODY_BORDER = "A0D0CF"
C_BODY_FONT = "000000"
C_FORMULA_FILL = "E3F1F1"
C_WHITE = "FFFFFF"

FONT_NAME = "微软雅黑"
SIZE_HEADER_PT = 11
SIZE_BODY_PT = 10

TITLE = "上侧表头"
LEFT_HEADER = "左侧表头"
BODY_NUM = "正文数字"
BODY_TEXT = "正文文字"
BODY_FORMULA = "正文取数与公式"

# 角色名 → 中文（用于报告与对话）
ROLE_LABEL = {
    TITLE: "标题/上侧表头",
    LEFT_HEADER: "左侧表头",
    BODY_NUM: "正文-数字",
    BODY_TEXT: "正文-文字",
    BODY_FORMULA: "正文-取数与公式",
}

# 对话里常见的说法 → 规范角色
ALIASES = {
    "上侧表头": TITLE, "标题": TITLE, "表头": TITLE, "title": TITLE, "header": TITLE,
    "左侧表头": LEFT_HEADER, "左表头": LEFT_HEADER, "行表头": LEFT_HEADER,
    "数字": BODY_NUM, "正文数字": BODY_NUM, "正文-数字": BODY_NUM, "num": BODY_NUM,
    "文字": BODY_TEXT, "正文文字": BODY_TEXT, "正文-文字": BODY_TEXT, "text": BODY_TEXT,
    "取数": BODY_FORMULA, "公式": BODY_FORMULA, "正文取数与公式": BODY_FORMULA,
    "正文-取数与公式": BODY_FORMULA, "formula": BODY_FORMULA,
}


def _role_key(role: str) -> str:
    """把中文/英文别名收敛到规范角色名。"""
    r = (role or "").strip()
    return ALIASES.get(r, ALIASES.get(r.lower(), r))

# com.fr.base.Style.TEXTSTYLE_*
TEXTSTYLE_WRAPTEXT = 0
TEXTSTYLE_SINGLELINE = 1


def mm_to_fu(mm: float) -> int:
    return int(round(mm * FU_PER_MM))


ROW_HEIGHT_FU = mm_to_fu(ROW_HEIGHT_MM)
COL_WIDTH_FU = mm_to_fu(COL_WIDTH_MM)


def _border(color: str) -> Dict[str, frcpt.Border]:
    c = frcpt.fr_color(color)
    return {k: frcpt.Border(frcpt.LINE_THIN, c)
            for k in ("top", "bottom", "left", "right")}


def style_for(role: str) -> frcpt.Style:
    """角色 → 规范样式。返回值可直接交给 StyleTable 去重。"""
    if role in (TITLE, "标题"):
        return frcpt.Style(
            horizontal_alignment=frcpt.ALIGN_CENTER,
            vertical_alignment=frcpt.ALIGN_CENTER,
            font_name=FONT_NAME, font_style=1,                      # bold
            font_size=frcpt.pt_to_font_size(SIZE_HEADER_PT),
            foreground=frcpt.fr_color(C_UPPER_FONT),
            background=frcpt.fr_color(C_UPPER_FILL),
            padding_left=INDENT_PX, padding_right=INDENT_PX,
            **_border(C_UPPER_BORDER),
        )
    if role in (LEFT_HEADER, "左表头"):
        return frcpt.Style(
            horizontal_alignment=frcpt.ALIGN_CENTER,
            vertical_alignment=frcpt.ALIGN_CENTER,
            font_name=FONT_NAME, font_style=1,
            font_size=frcpt.pt_to_font_size(SIZE_HEADER_PT),
            foreground=frcpt.fr_color(C_LEFT_FONT),
            background=frcpt.fr_color(C_LEFT_FILL),
            padding_left=INDENT_PX, padding_right=INDENT_PX,
            **_border(C_LEFT_BORDER),
        )
    if role in (BODY_NUM, "数字"):
        return frcpt.Style(
            horizontal_alignment=frcpt.ALIGN_RIGHT,
            vertical_alignment=frcpt.ALIGN_CENTER,
            font_name=FONT_NAME, font_style=0,
            font_size=frcpt.pt_to_font_size(SIZE_BODY_PT),
            foreground=frcpt.fr_color(C_BODY_FONT),
            background=frcpt.fr_color(C_BODY_FILL),
            padding_left=0, padding_right=INDENT_PX,
            text_control=TEXTSTYLE_SINGLELINE,                     # 数字不换行
            **_border(C_BODY_BORDER),
        )
    if role in (BODY_FORMULA, "公式", "取数"):
        return frcpt.Style(
            horizontal_alignment=frcpt.ALIGN_RIGHT,
            vertical_alignment=frcpt.ALIGN_CENTER,
            font_name=FONT_NAME, font_style=0,
            font_size=frcpt.pt_to_font_size(SIZE_BODY_PT),
            foreground=frcpt.fr_color(C_BODY_FONT),
            background=frcpt.fr_color(C_FORMULA_FILL),             # 填报表取数/公式底色
            padding_left=0, padding_right=INDENT_PX,
            text_control=TEXTSTYLE_SINGLELINE,
            **_border(C_BODY_BORDER),
        )
    # BODY_TEXT and anything unknown
    return frcpt.Style(
        horizontal_alignment=frcpt.ALIGN_CENTER,
        vertical_alignment=frcpt.ALIGN_CENTER,
        font_name=FONT_NAME, font_style=0,
        font_size=frcpt.pt_to_font_size(SIZE_BODY_PT),
        foreground=frcpt.fr_color(C_BODY_FONT),
        background=frcpt.fr_color(C_BODY_FILL),
        padding_left=INDENT_PX, padding_right=INDENT_PX,
        **_border(C_BODY_BORDER),
    )


def styles() -> Dict[str, frcpt.Style]:
    return {r: style_for(r) for r in (TITLE, LEFT_HEADER, BODY_NUM, BODY_TEXT, BODY_FORMULA)}


# ---------------------------------------------------------------- 分析表 / 填报表
@dataclass
class Layout:
    """一张报表的骨架信息，生成与校验都用它对齐规范。"""
    header_rows: int = 1          # 上侧表头占几行
    has_left_header: bool = False
    tail_blank_rows: int = 2      # 规范：底部预留两行空行


def freeze_cell(layout: Layout) -> str:
    """冻结锚点：表头行/列之外的第一格（A2 / B2 / B3 …）。"""
    col = 1 if layout.has_left_header else 0
    row = max(layout.header_rows, 1)
    return frcpt.cell_ref(col, row)


def view_highlight(name: str = "分析表视图") -> frcpt.Highlight:
    """规范最后一条：填报表兼分析表时，$op='view' 下底色转白，一套表两用。"""
    return frcpt.Highlight(name=name, formula="$op = 'view'",
                           background=frcpt.fr_color(C_WHITE), scope=1)


def apply(sheet: frcpt.Sheet, roles: Dict[Tuple[int, int], str], layout: Layout,
          styles_table: frcpt.StyleTable, entry: bool = False) -> frcpt.Sheet:
    """把角色刷成规范样式，并补齐行高/列宽/冻结/底部空行/条件属性。"""
    role_styles = styles()
    for cell in sheet.cells:
        role = roles.get((cell.c, cell.r))
        if role:
            cell.style = styles_table.add(role_styles[role])
        if entry and role == BODY_FORMULA and not cell.has_view_highlight():
            # 规范：填报表兼分析表时，取数/公式格在 $op='view' 下底色转白，一套表两用
            if cell.highlight_raw is not None:
                cell.highlight_raw.append(view_highlight().to_element())
            else:
                cell.highlights.append(view_highlight())
        if entry and isinstance(cell.value, frcpt.DSColumn) and cell.widget is None:
            # 填报表的取数格同时是录入格：挂一个文本控件，否则打开只能看不能填
            cell.widget = frcpt.Widget()
    # 行高/列宽统一
    mc, mr = sheet.extent()
    sheet.default_row_height = ROW_HEIGHT_FU
    sheet.default_col_width = COL_WIDTH_FU
    total_rows = mr + 1 + layout.tail_blank_rows
    sheet.row_heights = [ROW_HEIGHT_FU] * total_rows
    sheet.col_widths = [COL_WIDTH_FU] * (mc + 1)
    sheet.frozen = freeze_cell(layout)
    return sheet


# ---------------------------------------------------------------- 校验
def _style_of(wb: frcpt.Workbook, cell: frcpt.Cell) -> Optional[frcpt.Style]:
    if cell.style is None or not (0 <= cell.style < len(wb.styles.styles)):
        return None
    return wb.styles.styles[cell.style]


def _cmp(expected: frcpt.Style, actual: frcpt.Style) -> List[str]:
    diffs = []

    def chk(label, a, b, fmt=lambda v: v):
        if a != b:
            diffs.append(f"{label} 应为 {fmt(a)}，实际 {fmt(b)}")

    chk("字体", expected.font_name, actual.font_name)
    chk("字号(pt)", expected.font_size / frcpt.FONT_SIZE_PER_PT,
        actual.font_size / frcpt.FONT_SIZE_PER_PT, lambda v: f"{v:g}")
    chk("加粗", bool(expected.font_style & 1), bool(actual.font_style & 1))
    chk("字体颜色", expected.foreground, actual.foreground, lambda v: f"{v & 0xFFFFFF:06X}")
    chk("填充色", expected.background, actual.background,
        lambda v: "无" if v is None else f"{v & 0xFFFFFF:06X}")
    chk("水平对齐", expected.horizontal_alignment, actual.horizontal_alignment,
        lambda v: {0: "居中", 2: "左", 4: "右", None: "默认"}.get(v, v))
    chk("右缩进(px)", expected.padding_right, actual.padding_right)
    chk("左缩进(px)", expected.padding_left, actual.padding_left)
    for side in ("top", "bottom", "left", "right"):
        e, a = getattr(expected, side), getattr(actual, side)
        if e.style != a.style:
            diffs.append(f"{side} 边框应为 {e.style}，实际 {a.style}")
        elif e.style != frcpt.LINE_NONE and e.color != a.color:
            diffs.append(f"{side} 边框色应为 {e.color & 0xFFFFFF:06X}，"
                         f"实际 {a.color & 0xFFFFFF:06X}")
    if expected.text_control != actual.text_control:
        diffs.append(f"文本控制应为 {expected.text_control}（1=不换行），实际 {actual.text_control}")
    return diffs


_SQL_AGG_RE = re.compile(
    r"\b(sum|count|avg|max|min)\s*\(([^)]*)\)\s*(?:as\s+)?([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)?",
    re.I)


def sql_numeric_columns(query: str) -> set:
    """从 SQL 里猜数值列：聚合函数的别名（或聚合的内层列）视为数值。

    只是为了血缘图/SQL 还原更贴近语义，不参与生成决策，解析失败就返回空集。
    """
    out = set()
    try:
        for m in _SQL_AGG_RE.finditer(query or ""):
            alias = (m.group(3) or "").strip()
            inner = (m.group(2) or "").split(",")[-1].strip()
            inner = inner.split(".")[-1].strip(" []\"'`")
            if alias and alias.lower() not in ("from", "where", "group", "order", "by"):
                out.add(alias)
            elif inner:
                out.add(inner)
    except Exception:
        return set()
    return out


def _column_kind(wb: Optional[frcpt.Workbook], ds_name: str, column_name: str) -> str:
    """'num' | 'text' —— 按数据集列类型判断正文角色。未知按 text 处理（更安全）。"""
    if wb is None:
        return "text"
    for ds in wb.datasets:
        if ds.name != ds_name:
            continue
        if isinstance(ds, frcpt.EmbeddedDataset):
            for cname, ctype in ds.columns:
                if cname == column_name:
                    t = (ctype or "").lower()
                    if "int" in t or "double" in t or "long" in t or "decimal" in t or "float" in t:
                        return "num"
                    return "text"
        if isinstance(ds, frcpt.SqlDataset):
            # 1) 调用方声明的字段类型优先（SQL 数据集的类型本来就存不进 CPT）
            for cname, ctype in (ds.columns or []):
                if cname == column_name:
                    t = (ctype or "").lower()
                    if "int" in t or "double" in t or "long" in t or "decimal" in t or "float" in t:
                        return "num"
                    return "text"
            # 2) 退而求其次：从 SQL 的聚合别名猜
            return "num" if column_name in sql_numeric_columns(ds.query) else "text"
    return "text"


def infer_roles(sheet: frcpt.Sheet, wb: Optional[frcpt.Workbook] = None,
                entry: bool = False) -> Tuple[Dict[Tuple[int, int], str], Layout]:
    """从结构猜角色：数据列/扩展格之上 = 上侧表头，其左 = 左侧表头，其余是正文。

    正文字符串列 → 居中；数值列/公式 → 右对齐；填报表的公式/取数 → 取数底色。
    """
    data_rows = sorted({c.r for c in sheet.cells
                        if isinstance(c.value, frcpt.DSColumn)
                        or (c.expand.direction is not None and not isinstance(c.value, frcpt.Text))})
    header_rows = data_rows[0] if data_rows else 1
    data_cols = sorted({c.c for c in sheet.cells if isinstance(c.value, frcpt.DSColumn)})
    has_left = False
    if data_cols:
        first_data_col = data_cols[0]
        if first_data_col > 0:
            left_cols = set(range(0, first_data_col))
            body_rows = [c for c in sheet.cells if c.r >= header_rows]
            has_left = any(c.c in left_cols and isinstance(c.value, frcpt.Text) for c in body_rows)
    roles: Dict[Tuple[int, int], str] = {}
    for c in sheet.cells:
        if c.r < header_rows:
            roles[(c.c, c.r)] = TITLE
        elif has_left and c.c == 0:
            roles[(c.c, c.r)] = LEFT_HEADER
        elif isinstance(c.value, frcpt.DSColumn):
            if entry:
                # 填报表里由数据集带出来的格子属于"取数"，按规范给 E3F1F1
                roles[(c.c, c.r)] = BODY_FORMULA
            else:
                kind = _column_kind(wb, c.value.ds_name, c.value.column_name)
                roles[(c.c, c.r)] = BODY_NUM if kind == "num" else BODY_TEXT
        elif isinstance(c.value, frcpt.Formula):
            roles[(c.c, c.r)] = BODY_FORMULA if entry else BODY_NUM
        elif isinstance(c.value, frcpt.Number):
            roles[(c.c, c.r)] = BODY_NUM
        else:
            roles[(c.c, c.r)] = BODY_TEXT
    return roles, Layout(header_rows=max(header_rows, 1), has_left_header=has_left)


def check(wb: frcpt.Workbook, entry: bool = False) -> List[frcpt.Issue]:
    """按 6.2 逐条检查；返回带单元格坐标的问题清单。"""
    from frcpt import Issue
    out: List[Issue] = []
    for sh in wb.sheets:
        roles, layout = infer_roles(sh, wb, entry)
        expected = styles()

        for cell in sh.cells:
            role = roles.get((cell.c, cell.r))
            if role is None:
                continue
            ref = frcpt.cell_ref(cell.c, cell.r)
            st = _style_of(wb, cell)
            if st is None:
                out.append(Issue("error", "ZJ-STYLE-MISSING",
                                 f"{ref}（{ROLE_LABEL[role]}）没有样式，应为规范样式", sh.name))
                continue
            diffs = _cmp(expected[role], st)
            if diffs:
                out.append(Issue("warning", "ZJ-STYLE",
                                 f"{ref}（{ROLE_LABEL[role]}）偏离规范：" + "；".join(diffs[:4]),
                                 sh.name))
            if entry and isinstance(cell.value, frcpt.Formula):
                if not cell.has_view_highlight():
                    out.append(Issue("warning", "ZJ-VIEW-HIGHLIGHT",
                                     f"{ref} 是填报表公式格，缺少 $op='view' 底色转白条件属性",
                                     sh.name))
            if isinstance(cell.value, frcpt.Text) and cell.value.text.strip() == "--":
                if st.horizontal_alignment != frcpt.ALIGN_CENTER:
                    out.append(Issue("warning", "ZJ-DASH-ALIGN",
                                     f"{ref} 的【--】应居中对齐", sh.name))
                if st.background is not None and st.background != frcpt.fr_color(C_BODY_FILL):
                    out.append(Issue("warning", "ZJ-DASH-FILL",
                                     f"{ref} 的【--】应无填充底色", sh.name))

        # 行高 / 列宽
        mc, mr = sh.extent()
        for r in range(mr + 1):
            h = sh.row_heights[r] if r < len(sh.row_heights) else sh.default_row_height
            if h != ROW_HEIGHT_FU:
                out.append(Issue("warning", "ZJ-ROW-HEIGHT",
                                 f"第 {r + 1} 行行高 {h / FU_PER_MM:.2f}mm，规范为 {ROW_HEIGHT_MM}mm",
                                 sh.name))
                break
        for c in range(mc + 1):
            w = sh.col_widths[c] if c < len(sh.col_widths) else sh.default_col_width
            if w != COL_WIDTH_FU:
                out.append(Issue("warning", "ZJ-COL-WIDTH",
                                 f"第 {frcpt.cell_ref(c, 0)[:-1]} 列列宽 {w / FU_PER_MM:.2f}mm，"
                                 f"规范为 {COL_WIDTH_MM}mm", sh.name))
                break
        if not sh.frozen:
            out.append(Issue("warning", "ZJ-FREEZE",
                             f"未设置标题行列冻结，应为 {freeze_cell(layout)}", sh.name))
        # 底部两行空行：报表高度（row_heights 长度）要比最后一行有内容的行多出 N 行
        mc, mr = sh.extent()
        used_bottom = 0
        for r in range(mr, -1, -1):
            if any(c.r == r for c in sh.cells):
                used_bottom = r
                break
        spare = len(sh.row_heights) - (used_bottom + 1)
        if spare < layout.tail_blank_rows:
            out.append(Issue("warning", "ZJ-TAIL-BLANK",
                             f"底部只有 {max(spare, 0)} 行空行，规范要求预留 {layout.tail_blank_rows} 行",
                             sh.name))
        # 公司列头文案
        for cell in sh.cells:
            if isinstance(cell.value, frcpt.Text) and cell.r < layout.header_rows:
                t = cell.value.text.strip()
                if t in ("公司", "公司名称", "企业", "单位"):
                    out.append(Issue("info", "ZJ-COMPANY-HEADER",
                                     f"{frcpt.cell_ref(cell.c, cell.r)} 列头建议统一为【企业名称】",
                                     sh.name))
    return out


def standard_table_markdown() -> str:
    """把规范样式表渲染成 Markdown，供文档与对话引用。"""
    rows = [
        ("上侧表头", "", C_UPPER_FILL, C_UPPER_BORDER, C_UPPER_FONT, SIZE_HEADER_PT, "是", "居中", f"左右 {INDENT_MM}"),
        ("左侧表头", "", C_LEFT_FILL, C_LEFT_BORDER, C_LEFT_FONT, SIZE_HEADER_PT, "是", "居中", f"左右 {INDENT_MM}"),
        ("正文", "数字", C_BODY_FILL, C_BODY_BORDER, C_BODY_FONT, SIZE_BODY_PT, "否", "右对齐", f"右 {INDENT_MM}"),
        ("正文", "非数字", C_BODY_FILL, C_BODY_BORDER, C_BODY_FONT, SIZE_BODY_PT, "否", "居中", f"左右 {INDENT_MM}"),
        ("正文", "填报表取数与公式", C_FORMULA_FILL, C_BODY_BORDER, C_BODY_FONT, SIZE_BODY_PT, "否", "右对齐", f"右 {INDENT_MM}"),
        ("鼠标悬浮", "", C_LEFT_FILL, "", "", "", "", "", ""),
        ("超链接", "", "226D6D", "", "", "", "", "", ""),
    ]
    head = "| 分类 | 细类 | 填充 | 边框 | 字体色 | 字号 | 加粗 | 对齐 | 缩进 |"
    sep = "|---|---|---|---|---|---|---|---|---|"
    body = "\n".join("| " + " | ".join(str(x) for x in r) + " |" for r in rows)
    return f"{head}\n{sep}\n{body}\n\n字体：{FONT_NAME}；行高 {ROW_HEIGHT_MM}mm（{ROW_HEIGHT_FU} FU）；" \
           f"列宽 {COL_WIDTH_MM}mm（{COL_WIDTH_FU} FU）；缩进 {INDENT_MM}mm → {INDENT_PX} px"
