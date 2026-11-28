# -*- coding: utf-8 -*-
"""frcpt — FineReport 10.x .cpt (XML template) model, reader, writer and validator.

Every constant below is evidence-backed from the local FineReport 10.0 install
(D:\\Tools\\FineReport_10.0). Sources are noted per item so a later session can
re-verify instead of re-deriving:

  * Root element        WorkBook  (xmlVersion / releaseVersion attrs)      - 400/400 corpus files
  * Cell grid           <C c r cs rs s> with <O> value + <PrivilegeControl> + <Expand>
  * Row/column unit     FU: 1 pt = 50800 FU, 1 old-px = 38100 FU          - com.fr.stable.Constants
                            FU_PER_PT, FU_PER_OLD_PIX
                        defaults 723900 FU (19 px) x 2743200 FU (72 px)
  * Font size unit      attribute size = pt * 8                           - com.fr.base.FRFont
                            SCALE_TO_FRSIZE=8, FONT_SIZE_SCALE=1000
                            convert4TplFrSize(x)=x*125, convert2TplFrSize(x)=x/125
  * Alignment codes     CENTER=0 TOP=1 LEFT=2 BOTTOM=3 RIGHT=4            - com.fr.stable.Constants
  * Border line codes   LINE_NONE=0 LINE_THIN=1 LINE_MEDIUM=2 LINE_DASH=3
                        LINE_HAIR=4 LINE_THICK=5 LINE_DOUBLE=6 LINE_DOT=7 - com.fr.stable.Constants
  * Embedded dataset    <TableData class="com.fr.data.impl.EmbeddedTableData">
                        children Parameters, DSName, ColumnNames, ColumnTypes, RowData
                        ColumnNames separator is ",,.,," (not a comma)   - EmbeddedTableData.readXML
                        RowData = ascii85(raw deflate(UTF-8 row text))   - see frcodec.py
  * SQL dataset         <TableData class="com.fr.data.impl.DBTableData">
                        Parameters, Attributes(maxMemRowCount), Connection, Query, PageQuery
  * Connection          referenced by NAME only (NameDatabaseConnection/DatabaseName);
                        the connection itself lives on the platform, not in the .cpt
  * Data column cell    <O t="DSColumn"> Attributes(dsName,columnName) [Condition]
                        Complex [RG] [Result] Parameters
  * Formula cell        <O t="XMLable" class="com.fr.base.Formula"><Attributes>=expr</Attributes></O>
  * Number cell         <O t="I">int</O> (Integer) / <O t="D">float</O> (Double)
                        / <O t="BigDecimal">dec</O>
  * Text cell           <O><![CDATA[text]]></O>
  * Grouping            <RG class="com.fr.report.cell.cellattr.core.group.FunctionGrouper"/>  (group)
                        SummaryGrouper + <FN>com.fr.data.util.function.SumFunction</FN>       (aggregate)
  * Expansion           <Expand dir="0"/> vertical, <Expand dir="1"/> horizontal,
                        <Expand/> none; optional left/up parent, order, SortFormula child
"""
from __future__ import annotations

import datetime as _dt
import os
import uuid
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from lxml import etree

try:
    from . import frcodec
except ImportError:  # direct script use
    import frcodec

# --------------------------------------------------------------------------- units
FU_PER_PT = 50800        # com.fr.stable.Constants.FU_PER_PT
FU_PER_PX = 38100        # com.fr.stable.Constants.FU_PER_OLD_PIX  (1 px = 0.75 pt)
FONT_SIZE_PER_PT = 8     # com.fr.base.FRFont.SCALE_TO_FRSIZE

DEFAULT_ROW_HEIGHT_FU = 723900   # 19 px
DEFAULT_COL_WIDTH_FU = 2743200   # 72 px

# com.fr.stable.Constants
LINE_NONE, LINE_THIN, LINE_MEDIUM, LINE_DASH = 0, 1, 2, 3
LINE_HAIR, LINE_THICK, LINE_DOUBLE, LINE_DOT = 4, 5, 6, 7
ALIGN_CENTER, ALIGN_TOP, ALIGN_LEFT, ALIGN_BOTTOM, ALIGN_RIGHT = 0, 1, 2, 3, 4

XML_VERSION = "20211223"
RELEASE_VERSION = "10.0.0"

# java class names accepted in ColumnTypes / CLASS2NAME
COLUMN_TYPE_NAMES = {
    "string": "java.lang.String",
    "integer": "java.lang.Integer",
    "int": "java.lang.Integer",
    "long": "java.lang.Long",
    "double": "java.lang.Double",
    "float": "java.lang.Double",
    "decimal": "java.math.BigDecimal",
    "bigdecimal": "java.math.BigDecimal",
    "boolean": "java.lang.Boolean",
}

SUMFUNCS = {
    "sum": "com.fr.data.util.function.SumFunction",
    "count": "com.fr.data.util.function.CountFunction",
    "avg": "com.fr.data.util.function.AverageFunction",
    "max": "com.fr.data.util.function.MaxFunction",
    "min": "com.fr.data.util.function.MinFunction",
}


def pt_to_fu(pt: float) -> int:
    return int(round(float(pt) * FU_PER_PT))


def px_to_fu(px: float) -> int:
    return int(round(float(px) * FU_PER_PX))


def char_width_to_px(chars: float) -> int:
    """Excel column width (characters) -> pixels, Calibri 11 metric (MDW=7, padding=5)."""
    return int(round(float(chars) * 7 + 5))


def pt_to_font_size(pt: float) -> int:
    return int(round(float(pt) * FONT_SIZE_PER_PT))


def fr_color(value) -> int:
    """'FFRRGGBB' / '#RRGGBB' / 0xRRGGBB / int -> signed 32-bit ARGB as FR writes it."""
    if value is None:
        return -16777216
    if isinstance(value, int):
        n = value
    else:
        s = str(value).strip().lstrip("#")
        if len(s) == 8:
            n = int(s, 16)
        elif len(s) == 6:
            n = (0xFF << 24) | int(s, 16)
        else:
            return -16777216
    n &= 0xFFFFFFFF
    return n - 0x100000000 if n >= 0x80000000 else n


def cdata(text: str) -> Any:
    """CDATA section; FR escapes a literal ']]' as ']]A' (XMLEncodeUtils.cdataEncode)."""
    if text is None:
        text = ""
    return etree.CDATA(str(text).replace("]]", "]]A"))


def merge_children(default_order, built, extras):
    """按原始子节点顺序重建一个元素的内容，已知节点用新生成的，未知节点原样插回。

    ``built``   : {tag: element 或 [element…]}  —— 本模型会重新生成的节点（同名可多个）
    ``extras``  : [(orig_index, el)]            —— 原文件里本模型不认识的节点（深拷贝）
    保序的意义：帆软的读取端虽按标签分派，但设计器保存时顺序固定，人工 diff 时不至于
    整块漂移；更重要的是 ``Widget`` 之类节点位置写错会让设计器认不出来。
    """
    norm = {k: (list(v) if isinstance(v, (list, tuple)) else [v]) for k, v in built.items()}
    queues: Dict[str, List[Any]] = {}
    for _idx, el in extras:
        queues.setdefault(el.tag, []).append(el)
    out = []
    used = set()
    for tag in (default_order or []):
        if tag in norm and tag not in used:
            out.extend(norm[tag])
            used.add(tag)
        if queues.get(tag):
            out.extend(queues.pop(tag))
    for tag, els in norm.items():
        if tag not in used:
            out.extend(els)
    for _idx, el in sorted(extras, key=lambda x: x[0]):
        for tag, q in queues.items():
            if el in q:
                out.append(el)
                q.remove(el)
                break
    return out


# --------------------------------------------------------------------------- styles
@dataclass
class Border:
    style: int = LINE_NONE
    color: int = -16777216

    def key(self):
        return (self.style, self.color)


@dataclass
class Style:
    horizontal_alignment: Optional[int] = None
    vertical_alignment: Optional[int] = None
    font_name: str = "SimSun"
    font_style: int = 0            # java.awt.Font bitmask: 1=bold, 2=italic
    font_size: int = pt_to_font_size(9)
    foreground: int = -16777216
    underline: Optional[int] = None
    background: Optional[int] = None      # linear|None -> ColorBackground
    top: Border = field(default_factory=Border)
    bottom: Border = field(default_factory=Border)
    left: Border = field(default_factory=Border)
    right: Border = field(default_factory=Border)
    number_format: Optional[str] = None
    text_control: Optional[int] = None    # textStyle attr, com.fr.base.Style.TEXTSTYLE_*
    padding_left: Optional[int] = None    # paddingLeft  (unit: px @96dpi)
    padding_right: Optional[int] = None   # paddingRight (unit: px @96dpi)
    library_index: Optional[int] = None   # <Style index="N"/> — reference into the style library
    style_name: Optional[str] = None      # <Style style_name="..."> — named/shared style

    def key(self):
        return (
            self.horizontal_alignment, self.vertical_alignment, self.font_name,
            self.font_style, self.font_size, self.foreground, self.underline,
            self.background, self.top.key(), self.bottom.key(), self.left.key(),
            self.right.key(), self.number_format, self.text_control,
            self.padding_left, self.padding_right,
            self.library_index, self.style_name,
        )

    def to_element(self) -> etree._Element:
        st = etree.Element("Style")
        if self.library_index is not None:
            st.set("index", str(self.library_index))
        if self.style_name is not None:
            st.set("style_name", self.style_name)
        if self.library_index is not None and self.style_name is None and \
                self.horizontal_alignment is None and self.vertical_alignment is None and \
                self.foreground == -16777216 and self.background is None and \
                self.number_format is None and self.top.style == LINE_NONE and \
                self.bottom.style == LINE_NONE and self.left.style == LINE_NONE and \
                self.right.style == LINE_NONE:
            return st  # pure library reference, nothing else to emit
        if self.horizontal_alignment is not None:
            st.set("horizontal_alignment", str(self.horizontal_alignment))
        if self.vertical_alignment is not None:
            st.set("vertical_alignment", str(self.vertical_alignment))
        if self.text_control is not None:
            st.set("textStyle", str(self.text_control))
        if self.padding_left is not None:
            st.set("paddingLeft", str(self.padding_left))
        if self.padding_right is not None:
            st.set("paddingRight", str(self.padding_right))
        st.set("imageLayout", "1")
        if self.number_format:
            fmt = etree.SubElement(st, "Format")
            fmt.set("class", "com.fr.base.CoreDecimalFormat")
            fmt.text = cdata(self.number_format)
        font = etree.SubElement(st, "FRFont")
        font.set("name", self.font_name)
        font.set("style", str(self.font_style))
        font.set("size", str(self.font_size))
        if self.foreground != -16777216:
            font.set("foreground", str(self.foreground))
        if self.underline:
            font.set("underline", str(self.underline))
        bg = etree.SubElement(st, "Background")
        if self.background is None:
            bg.set("name", "NullBackground")
        else:
            bg.set("name", "ColorBackground")
            bg.set("color", str(self.background))
        border = etree.SubElement(st, "Border")
        for tag, b in (("Top", self.top), ("Bottom", self.bottom),
                       ("Left", self.left), ("Right", self.right)):
            if b.style == LINE_NONE:
                continue
            e = etree.SubElement(border, tag)
            e.set("style", str(b.style))
            if b.color != -16777216:
                e.set("color", str(b.color))
        return st


class StyleTable:
    """Deduplicating style table; index == the cell's s attribute."""

    def __init__(self):
        self.styles: List[Style] = []
        self._index: Dict[Any, int] = {}

    def add(self, style: Optional[Style]) -> Optional[int]:
        if style is None:
            return None
        k = style.key()
        if k in self._index:
            return self._index[k]
        idx = len(self.styles)
        self.styles.append(style)
        self._index[k] = idx
        return idx


# --------------------------------------------------------------------------- values
class CellValue:
    """Base class; each subclass knows how to emit its <O> element."""

    def to_element(self) -> Optional[etree._Element]:
        raise NotImplementedError

    @property
    def is_expandable(self) -> bool:
        return False


@dataclass
class Blank(CellValue):
    def to_element(self):
        return None


@dataclass
class Text(CellValue):
    text: str = ""

    def to_element(self):
        o = etree.Element("O")
        if self.text != "":
            o.text = cdata(self.text)
        return o


@dataclass
class Number(CellValue):
    value: Any = None

    def to_element(self):
        o = etree.Element("O")
        v = self.value
        if isinstance(v, bool):
            o.set("t", "I")
            o.text = cdata("1" if v else "0")
        elif isinstance(v, int):
            o.set("t", "I")
            o.text = cdata(str(v))
        elif isinstance(v, float):
            o.set("t", "D")
            o.text = cdata(repr(v))
        else:
            o.set("t", "BigDecimal")
            o.text = cdata(str(v))
        return o


@dataclass
class Formula(CellValue):
    expr: str = ""

    def to_element(self):
        o = etree.Element("O")
        o.set("t", "XMLable")
        o.set("class", "com.fr.base.Formula")
        attrs = etree.SubElement(o, "Attributes")
        expr = self.expr if self.expr.startswith("=") else "=" + self.expr
        attrs.text = cdata(expr)
        return o


@dataclass
class DSColumn(CellValue):
    """A cell bound to one column of a dataset (FineReport '数据列')."""
    ds_name: str = ""
    column_name: str = ""
    grouper: Optional[str] = None       # None -> list expansion, 'group' -> FunctionGrouper
    aggregate: Optional[str] = None     # sum/count/avg/max/min -> SummaryGrouper + FN
    condition: Optional[etree._Element] = None
    result: Optional[etree._Element] = None
    sort_formula: Optional[str] = None
    expand_dir: int = 0                 # 0 vertical (down), 1 horizontal (right)

    @property
    def is_expandable(self) -> bool:
        return not self.aggregate

    def to_element(self):
        o = etree.Element("O")
        o.set("t", "DSColumn")
        attrs = etree.SubElement(o, "Attributes")
        attrs.set("dsName", self.ds_name)
        attrs.set("columnName", self.column_name)
        if self.condition is not None:
            o.append(self.condition)
        etree.SubElement(o, "Complex")
        if self.aggregate:
            rg = etree.SubElement(o, "RG")
            rg.set("class", "com.fr.report.cell.cellattr.core.group.SummaryGrouper")
            fn = etree.SubElement(rg, "FN")
            fn.text = cdata(SUMFUNCS.get(self.aggregate, SUMFUNCS["sum"]))
        elif self.grouper == "group":
            rg = etree.SubElement(o, "RG")
            rg.set("class", "com.fr.report.cell.cellattr.core.group.FunctionGrouper")
        if self.result is not None:
            o.append(self.result)
        etree.SubElement(o, "Parameters")
        return o


# --------------------------------------------------------------------------- cells
@dataclass
class Expand:
    direction: Optional[int] = None      # 0 down, 1 right, None -> no expansion
    left: Optional[str] = None           # left parent cell, e.g. 'A2'
    up: Optional[str] = None             # up parent cell
    left_parent_default: bool = True
    up_parent_default: bool = True
    order: Optional[int] = None
    sort_formula: Optional[str] = None
    multi_number: Optional[int] = None

    def to_element(self) -> etree._Element:
        e = etree.Element("Expand")
        if self.direction is not None:
            e.set("dir", str(self.direction))
        if not self.left_parent_default:
            e.set("leftParentDefault", "false")
        if not self.up_parent_default:
            e.set("upParentDefault", "false")
        if self.left:
            e.set("left", self.left)
        if self.up:
            e.set("up", self.up)
        if self.order is not None:
            e.set("order", str(self.order))
        if self.multi_number is not None:
            e.set("multiNumber", str(self.multi_number))
        if self.sort_formula:
            sf = etree.SubElement(e, "SortFormula")
            expr = self.sort_formula if self.sort_formula.startswith("=") else "=" + self.sort_formula
            sf.text = cdata(expr)
        return e


@dataclass
class Highlight:
    """条件属性：<Highlight class="…DefaultHighlight"> Name / Condition / HighlightAction.

    Only the background action is modelled (the shape the 6.2 standard needs for the
    'analysis view reuses the entry report' trick: background → white when $op='view').
    """
    name: str = "条件属性1"
    formula: str = ""                 # FormulaCondition, e.g. "$op = 'view'"
    background: Optional[int] = -1    # BackgroundHighlightAction colour, None = no background action
    scope: int = 1                    # <Scope val="1"/>

    def to_element(self) -> etree._Element:
        hl = etree.Element("Highlight")
        hl.set("class", "com.fr.report.cell.cellattr.highlight.DefaultHighlight")
        n = etree.SubElement(hl, "Name")
        n.text = cdata(self.name)
        cond = etree.SubElement(hl, "Condition")
        cond.set("class", "com.fr.data.condition.FormulaCondition")
        f = etree.SubElement(cond, "Formula")
        f.text = cdata(self.formula)
        if self.background is not None:
            act = etree.SubElement(hl, "HighlightAction")
            act.set("class", "com.fr.report.cell.cellattr.highlight.BackgroundHighlightAction")
            scope = etree.SubElement(act, "Scope")
            scope.set("val", str(self.scope))
            bg = etree.SubElement(act, "Background")
            bg.set("name", "ColorBackground")
            bg.set("color", str(self.background))
        return hl


@dataclass
class Widget:
    """单元格填报控件（填报表的输入格）。

    生产模板里的实际形态（ROE分析填报.cpt，105 个）::

        <C c="5" r="4" s="6">
          <O …/><PrivilegeControl/><CellPageAttr/>
          <Widget class="com.fr.form.ui.TextEditor">
            <WidgetAttr aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">
              <MobileBookMark useBookMark="false" bookMarkName="" frozen="false" index="-1" oldWidgetName=""/>
              <PrivilegeControl/>
            </WidgetAttr>
            <TextAttr/><Reg class="com.fr.form.ui.reg.NoneReg"/>
            <widgetValue/><MobileScanCodeAttr scanCode="true" textInputMode="0"/>
          </Widget>
          <HighlightList/><Expand/>
        </C>
    """
    class_name: str = "com.fr.form.ui.TextEditor"
    name: str = ""
    description: str = ""
    regex: str = "com.fr.form.ui.reg.NoneReg"
    scan_code: bool = True
    text_input_mode: int = 0

    def to_element(self) -> etree._Element:
        w = etree.Element("Widget")
        w.set("class", self.class_name)
        attr = etree.SubElement(w, "WidgetAttr")
        attr.set("aspectRatioLocked", "false")
        attr.set("aspectRatioBackup", "-1.0")
        attr.set("description", self.description)
        mb = etree.SubElement(attr, "MobileBookMark")
        for k, v in (("useBookMark", "false"), ("bookMarkName", ""), ("frozen", "false"),
                     ("index", "-1"), ("oldWidgetName", self.name)):
            mb.set(k, v)
        etree.SubElement(attr, "PrivilegeControl")
        if self.name:
            wn = etree.Element("WidgetName")
            wn.set("name", self.name)
            w.insert(0, wn)
        etree.SubElement(w, "TextAttr")
        reg = etree.SubElement(w, "Reg")
        reg.set("class", self.regex)
        etree.SubElement(w, "widgetValue")
        scan = etree.SubElement(w, "MobileScanCodeAttr")
        scan.set("scanCode", "true" if self.scan_code else "false")
        scan.set("textInputMode", str(self.text_input_mode))
        return w


@dataclass
class Cell:
    c: int
    r: int
    value: CellValue = field(default_factory=Blank)
    style: Optional[int] = None
    cs: int = 1
    rs: int = 1
    expand: Expand = field(default_factory=Expand)
    privilege: bool = True
    highlights: List[Highlight] = field(default_factory=list)
    # 原样保留的 <HighlightList>（生产模板里的高亮动作远不止背景色：
    # RowHeightHighlightAction / ColWidthHighlightAction / ValueHighlightAction /
    # PresentHighlightAction / HyperlinkHighlightAction …，建模成本高且必须无损）
    highlight_raw: Optional[Any] = None
    widget: Optional[Widget] = None
    # 本模型不认识的 <C> 子节点（CellPageAttr / CellGUIAttr / NameJavaScriptGroup /
    # CellInsertPolicy / Present …）原样保留，(原始下标, 元素) 二元组
    extras: List[Tuple[int, Any]] = field(default_factory=list)
    child_order: Optional[List[str]] = None

    DEFAULT_ORDER = ["O", "PrivilegeControl", "CellPageAttr", "Widget",
                     "HighlightList", "Expand"]

    def has_view_highlight(self, param: str = "op", fill: int = -1) -> bool:
        """是否已带「$op='view' 时底色转白」的条件属性（填报表兼分析表的口径）。"""
        if self.highlight_raw is not None:
            xml = etree.tostring(self.highlight_raw, encoding="unicode")
            return f"${param}" in xml and f'color="{fill}"' in xml
        return any(param in (h.formula or "") and h.background == fill
                   for h in self.highlights)

    def to_element(self) -> etree._Element:
        e = etree.Element("C")
        e.set("c", str(self.c))
        e.set("r", str(self.r))
        if self.cs > 1:
            e.set("cs", str(self.cs))
        if self.rs > 1:
            e.set("rs", str(self.rs))
        if self.style is not None:
            e.set("s", str(self.style))
        built = {}
        o = self.value.to_element()
        if o is not None:
            built["O"] = o
        if self.privilege:
            built["PrivilegeControl"] = etree.Element("PrivilegeControl")
        if self.widget is not None:
            built["Widget"] = self.widget.to_element()
        if self.highlights:
            hl = etree.Element("HighlightList")
            for h in self.highlights:
                hl.append(h.to_element())
            built["HighlightList"] = hl
        elif self.highlight_raw is not None:
            built["HighlightList"] = etree.fromstring(etree.tostring(self.highlight_raw))
        built["Expand"] = self.expand.to_element()
        order = self.child_order or self.DEFAULT_ORDER
        for ch in merge_children(order, built, self.extras):
            e.append(ch)
        return e


# --------------------------------------------------------------------------- datasets
class Dataset:
    name: str = ""

    def to_element(self) -> etree._Element:
        raise NotImplementedError

    def describe(self) -> str:
        return f"{self.name}"


@dataclass
class Parameter:
    name: str
    value: str = ""

    def to_element(self) -> etree._Element:
        p = etree.Element("Parameter")
        attrs = etree.SubElement(p, "Attributes")
        attrs.set("name", self.name)
        o = etree.SubElement(p, "O")
        o.text = cdata(self.value)
        return p


@dataclass
class SqlDataset(Dataset):
    """com.fr.data.impl.DBTableData — SQL on a named platform connection.

    ``columns`` is *declared schema* (name, java type) supplied by the caller; the CPT
    format does not store a SQL dataset's column types, so this is metadata used for
    validation and for deciding 数字 vs 文字 when applying the 6.2 style profile.
    """
    name: str = "ds1"
    connection: str = "FRDemo"
    query: str = ""
    parameters: List[Parameter] = field(default_factory=list)
    page_query: str = ""
    max_mem_row_count: int = -1
    columns: List[Tuple[str, str]] = field(default_factory=list)

    def to_element(self):
        td = etree.Element("TableData")
        td.set("name", self.name)
        td.set("class", "com.fr.data.impl.DBTableData")
        params = etree.SubElement(td, "Parameters")
        for p in self.parameters:
            params.append(p.to_element())
        attrs = etree.SubElement(td, "Attributes")
        attrs.set("maxMemRowCount", str(self.max_mem_row_count))
        conn = etree.SubElement(td, "Connection")
        conn.set("class", "com.fr.data.impl.NameDatabaseConnection")
        db = etree.SubElement(conn, "DatabaseName")
        db.text = cdata(self.connection)
        q = etree.SubElement(td, "Query")
        q.text = cdata(self.query)
        pq = etree.SubElement(td, "PageQuery")
        pq.text = cdata(self.page_query)
        return td

    def describe(self):
        return f"{self.name}: SQL on '{self.connection}' -> {self.query[:60]!r}"


@dataclass
class EmbeddedDataset(Dataset):
    """com.fr.data.impl.EmbeddedTableData — the in-template ('内置') dataset."""
    name: str = "ds1"
    columns: List[Tuple[str, str]] = field(default_factory=list)   # (name, java type key)
    rows: List[Sequence[Any]] = field(default_factory=list)
    parameters: List[Parameter] = field(default_factory=list)
    ds_name: str = ""

    def column_type_names(self) -> List[str]:
        return [COLUMN_TYPE_NAMES.get(t.lower(), t) for _, t in self.columns]

    def to_element(self):
        td = etree.Element("TableData")
        td.set("name", self.name)
        td.set("class", "com.fr.data.impl.EmbeddedTableData")
        params = etree.SubElement(td, "Parameters")
        for p in self.parameters:
            params.append(p.to_element())
        dsname = etree.SubElement(td, "DSName")
        dsname.text = cdata(self.ds_name)
        names = etree.SubElement(td, "ColumnNames")
        names.text = cdata(",,.,,".join(name for name, _ in self.columns))
        types = etree.SubElement(td, "ColumnTypes")
        types.text = cdata(",".join(self.column_type_names()))
        rowdata = etree.SubElement(td, "RowData")
        rowdata.set("ColumnTypes", ",".join(self.column_type_names()))
        rowdata.text = cdata(self.encode_rows())
        return td

    def encode_rows(self) -> str:
        """Row text -> FineReport blob (see frcodec); deterministic for a given input."""
        return frcodec.encode_row_blob(self.rows)

    def decode_rows_text(self) -> List[List[str]]:
        return frcodec.text_to_rows(frcodec.decode_string_as_bytes(self.encode_rows()).decode("utf-8"))

    def describe(self):
        cols = ", ".join(f"{n}:{t}" for n, t in self.columns)
        return f"{self.name}: embedded [{cols}] rows={len(self.rows)}"


@dataclass
class AliasDataset(Dataset):
    """com.fr.data.impl.NameTableData — reference to a server-side dataset by name.

    Note (unverified by the corpus): FineReport's own writer emits these map entries
    WITHOUT a name attribute, e.g.
        <TableData class="com.fr.data.impl.NameTableData"><Name>Embedded1</Name></TableData>
    We keep the name attribute when the caller supplies one, because the map is keyed
    by it; validate the generated file in Designer before relying on this node type.
    """
    name: str = ""
    target: str = ""

    def to_element(self):
        td = etree.Element("TableData")
        if self.name:
            td.set("name", self.name)
        td.set("class", "com.fr.data.impl.NameTableData")
        n = etree.SubElement(td, "Name")
        n.text = cdata(self.target)
        return td

    def describe(self):
        return f"{self.name}: alias of server dataset '{self.target}'"


# --------------------------------------------------------------------------- sheets
@dataclass
class ColumnMapping:
    """DMLConfig 里的一条 ColumnConfig：数据库列 ← 单元格 / 公式 / 参数。

    生产模板（ROE分析填报.cpt）里三种形态都出现过：
      * 单元格映射：``<ColumnRow column="5" row="4"/>``；同名列对应多个格子时包一层
        ``<ColumnRowGroup>``（40+ 个 ColumnRow）
      * 公式：``<O t="XMLable" class="com.fr.base.Formula"><Attributes>=$comboBox0_companyA``
      * 参数：``<Parameter><Attributes name="prevQuarterEndDate"/><O …公式…/></Parameter>``
    """
    column_name: str = ""
    is_key: bool = False
    column: Optional[int] = None      # 0-based sheet column
    row: Optional[int] = None         # 0-based sheet row
    rows: List[Tuple[int, int]] = field(default_factory=list)   # 多格映射 → ColumnRowGroup
    formula: str = ""                 # 直接取值公式（控件参数等）
    parameter: Optional[Tuple[str, str]] = None   # (参数名, 公式)

    def all_rows(self) -> List[Tuple[int, int]]:
        if self.rows:
            return list(self.rows)
        if self.column is not None and self.row is not None:
            return [(self.column, self.row)]
        return []

    def to_element(self) -> etree._Element:
        cc = etree.Element("ColumnConfig")
        cc.set("name", self.column_name)
        cc.set("isKey", "true" if self.is_key else "false")
        cc.set("skipUnmodified", "false")
        if self.formula:
            cc.append(Formula(expr=self.formula).to_element())
        elif self.parameter:
            pname, pexpr = self.parameter
            p = etree.SubElement(cc, "Parameter")
            attrs = etree.SubElement(p, "Attributes")
            attrs.set("name", pname)
            p.append(Formula(expr=pexpr).to_element())
        rows = self.all_rows()
        if len(rows) == 1:
            cr = etree.SubElement(cc, "ColumnRow")
            cr.set("column", str(rows[0][0]))
            cr.set("row", str(rows[0][1]))
        elif rows:
            grp = etree.SubElement(cc, "ColumnRowGroup")
            for col, row in rows:
                cr = etree.SubElement(grp, "ColumnRow")
                cr.set("column", str(col))
                cr.set("row", str(row))
        return cc


@dataclass
class WriteBack:
    """<ReportWriteAttr>/<SubmitVisitor class="com.fr.report.write.BuiltInSQLSubmiter">."""
    name: str = "内置SQL1"
    ds_name: str = "FRDemo"
    table_schema: str = ""
    table_name: str = ""
    mappings: List[ColumnMapping] = field(default_factory=list)
    update_attr: bool = True

    def to_submit_element(self) -> etree._Element:
        """<SubmitVisitor> 本身（Sheet 负责把它包进 ReportWriteAttr）。"""
        sv = etree.Element("SubmitVisitor")
        sv.set("class", "com.fr.report.write.BuiltInSQLSubmiter")
        n = etree.SubElement(sv, "Name")
        n.text = cdata(self.name)
        attrs = etree.SubElement(sv, "Attributes")
        attrs.set("dsName", self.ds_name)
        dml = etree.SubElement(sv, "DMLConfig")
        dml.set("class", "com.fr.write.config.IntelliDMLConfig")
        tbl = etree.SubElement(dml, "Table")
        tbl.set("schema", self.table_schema)
        tbl.set("name", self.table_name)
        for m in self.mappings:
            dml.append(m.to_element())
        etree.SubElement(dml, "Condition").set("class", "com.fr.data.condition.ListCondition")
        if self.update_attr:
            ua = etree.SubElement(dml, "UpdateAttr")
            ua.set("updateStatus", "true")
        return sv

    def to_element(self) -> etree._Element:
        rwa = etree.Element("ReportWriteAttr")
        rwa.append(self.to_submit_element())
        return rwa


@dataclass
class Sheet:
    name: str = "sheet1"
    cells: List[Cell] = field(default_factory=list)
    row_heights: List[int] = field(default_factory=list)
    col_widths: List[int] = field(default_factory=list)
    default_row_height: int = DEFAULT_ROW_HEIGHT_FU
    default_col_width: int = DEFAULT_COL_WIDTH_FU
    background: int = -1                      # white
    frozen: Optional[str] = None              # <FrozenColumnRow columnrow="A2"/>
    write_backs: List["WriteBack"] = field(default_factory=list)
    # Report 下未建模的子节点（FloatElementList / ReportFitAttr …）原样保留
    extras: List[Tuple[int, Any]] = field(default_factory=list)
    child_order: Optional[List[str]] = None

    @property
    def write_back(self) -> Optional["WriteBack"]:
        return self.write_backs[0] if self.write_backs else None

    @write_back.setter
    def write_back(self, value: Optional["WriteBack"]) -> None:
        self.write_backs = [value] if value is not None else []

    # -- helpers -----------------------------------------------------------
    def cell_map(self) -> Dict[Tuple[int, int], Cell]:
        return {(c.c, c.r): c for c in self.cells}

    def extent(self) -> Tuple[int, int]:
        """(max_col_index, max_row_index) incl. colspan/rowspan, or (-1,-1)."""
        if not self.cells:
            return (-1, -1)
        mc = max(c.c + c.cs - 1 for c in self.cells)
        mr = max(c.r + c.rs - 1 for c in self.cells)
        return (mc, mr)

    def add(self, cell: Cell) -> Cell:
        self.cells.append(cell)
        return cell

    def padded_row_heights(self) -> List[int]:
        """Row height array. Never truncates: the array length is the sheet's row count,
        and the 6.2 standard relies on trailing rows existing beyond the last populated one."""
        mc, mr = self.extent()
        out = list(self.row_heights)
        while len(out) < mr + 1:
            out.append(self.default_row_height)
        return out

    def padded_col_widths(self) -> List[int]:
        mc, mr = self.extent()
        out = list(self.col_widths)
        while len(out) < mc + 1:
            out.append(self.default_col_width)
        return out

    def to_element(self) -> etree._Element:
        rep = etree.Element("Report")
        rep.set("class", "com.fr.report.worksheet.WorkSheet")
        rep.set("name", self.name)
        page = etree.SubElement(rep, "ReportPageAttr")
        for tag in ("HR", "FR", "HC", "FC"):
            etree.SubElement(page, tag)
        etree.SubElement(rep, "ColumnPrivilegeControl")
        etree.SubElement(rep, "RowPrivilegeControl")
        rh = etree.SubElement(rep, "RowHeight")
        rh.set("defaultValue", str(self.default_row_height))
        heights = self.padded_row_heights()
        rh.text = cdata(",".join(str(h) for h in heights) if heights else "")
        cw = etree.SubElement(rep, "ColumnWidth")
        cw.set("defaultValue", str(self.default_col_width))
        widths = self.padded_col_widths()
        cw.text = cdata(",".join(str(w) for w in widths) if widths else "")
        cel = etree.SubElement(rep, "CellElementList")
        for cell in sorted(self.cells, key=lambda x: (x.r, x.c)):
            cel.append(cell.to_element())
        ras = etree.SubElement(rep, "ReportAttrSet")
        rs = etree.SubElement(ras, "ReportSettings")
        rs.set("headerHeight", "0")
        rs.set("footerHeight", "0")
        etree.SubElement(rs, "PaperSetting")
        bg = etree.SubElement(rs, "Background")
        bg.set("name", "ColorBackground")
        bg.set("color", str(self.background))
        if self.frozen:
            fz = etree.SubElement(rs, "FrozenColumnRow")
            fz.set("columnrow", self.frozen)
        rep.append(etree.Element("PrivilegeControl"))
        # ReportWriteAttr（可多条 SubmitVisitor）排在 ReportAttrSet 之后、PrivilegeControl 之前
        if self.write_backs:
            rwa = etree.Element("ReportWriteAttr")
            for w in self.write_backs:
                rwa.append(w.to_submit_element())
            rep.insert(len(rep) - 1, rwa)
        # 未建模的 Report 子节点原样插回
        if self.extras:
            ordered = merge_children(self.child_order or [], {}, self.extras)
            rep.extend(ordered)
        return rep


# --------------------------------------------------------------------------- workbook
@dataclass
class Workbook:
    sheets: List[Sheet] = field(default_factory=list)
    datasets: List[Dataset] = field(default_factory=list)
    styles: StyleTable = field(default_factory=StyleTable)
    xml_version: str = XML_VERSION
    release_version: str = RELEASE_VERSION
    template_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    write_mobile_attr: bool = True
    write_web_attr: bool = False
    write_parameter_attr: bool = True
    write_template_id: bool = True
    # 整块原样保留：参数面板（控件/字典/布局）与网页属性（工具栏）一旦建模不全就会
    # 把生产模板的查询栏、提交/校验按钮全部丢掉，所以读进来一律原样存、原样写。
    parameter_attr_raw: Optional[Any] = None
    web_attr_raw: Optional[Any] = None
    mobile_attr_raw: Optional[Any] = None
    # 根级未建模节点（StrategyConfigsAttr / ExcelImportTemplateAttr / ReportFitAttr /
    # ReportExportAttr / TemplateCloudInfoAttrMark / TemplateID …）原样保留
    extras: List[Tuple[int, Any]] = field(default_factory=list)
    child_order: Optional[List[str]] = None

    # -- assembly ----------------------------------------------------------
    def to_element(self) -> etree._Element:
        wb = etree.Element("WorkBook")
        wb.set("xmlVersion", self.xml_version)
        wb.set("releaseVersion", self.release_version)

        seq: Dict[str, Any] = {}

        if self.datasets:
            tdm = etree.Element("TableDataMap")
            for ds in self.datasets:
                tdm.append(ds.to_element())
            seq["TableDataMap"] = tdm

        if self.web_attr_raw is not None:
            seq["ReportWebAttr"] = etree.fromstring(etree.tostring(self.web_attr_raw))
        elif self.write_web_attr:
            wa = etree.Element("ReportWebAttr")
            etree.SubElement(wa, "ServerPrinter")
            wpc = etree.SubElement(wa, "WebPageContent")
            page = etree.SubElement(wpc, "WebPage")
            page.set("isPage", "false")
            page.set("showAsImage", "false")
            page.set("autoScale", "false")
            seq["ReportWebAttr"] = wa

        if self.mobile_attr_raw is not None:
            seq["ElementCaseMobileAttr"] = etree.fromstring(etree.tostring(self.mobile_attr_raw))
        elif self.write_mobile_attr:
            mob = etree.Element("ElementCaseMobileAttr")
            p = etree.SubElement(mob, "ElementCaseMobileAttrProvider")
            for k, v in (("horizontal", "1"), ("vertical", "1"), ("zoom", "true"),
                         ("refresh", "false"), ("isUseHTML", "false"),
                         ("isMobileCanvasSize", "false"), ("appearRefresh", "false"),
                         ("allowFullScreen", "false")):
                p.set(k, v)
            seq["ElementCaseMobileAttr"] = mob

        seq["Report"] = [sh.to_element() for sh in self.sheets]

        if self.parameter_attr_raw is not None:
            seq["ReportParameterAttr"] = etree.fromstring(etree.tostring(self.parameter_attr_raw))
        elif self.write_parameter_attr:
            rpa = etree.Element("ReportParameterAttr")
            attrs = etree.SubElement(rpa, "Attributes")
            attrs.set("showWindow", "true")
            attrs.set("delayPlaying", "true")
            attrs.set("windowPosition", "1")
            attrs.set("align", "1")
            attrs.set("useParamsTemplate", "false")
            t = etree.SubElement(rpa, "PWTitle")
            t.text = cdata("参数")
            seq["ReportParameterAttr"] = rpa

        sl = etree.Element("StyleList")
        for st in self.styles.styles:
            sl.append(st.to_element())
        seq["StyleList"] = sl

        dv = etree.Element("DesignerVersion")
        dv.set("DesignerVersion", "KAA")
        seq["DesignerVersion"] = dv
        pv = etree.Element("PreviewType")
        pv.set("PreviewType", "0")
        seq["PreviewType"] = pv

        if self.write_template_id:
            mark = etree.Element("TemplateIdAttMark")
            mark.set("class", "com.fr.base.iofile.attr.TemplateIdAttrMark")
            inner = etree.SubElement(mark, "TemplateIdAttMark")
            inner.set("TemplateId", self.template_id)
            seq["TemplateIdAttMark"] = mark

        default_order = ["TableDataMap", "ReportWebAttr", "ElementCaseMobileAttr", "Report",
                         "ReportParameterAttr", "StyleList", "DesignerVersion",
                         "PreviewType", "TemplateIdAttMark"]
        for ch in merge_children(self.child_order or default_order, seq, self.extras):
            wb.append(ch)
        return wb

    def to_bytes(self) -> bytes:
        return etree.tostring(self.to_element(), xml_declaration=True,
                              encoding="UTF-8", pretty_print=True)

    def save(self, path: str) -> str:
        data = self.to_bytes()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path


# --------------------------------------------------------------------------- reader
KNOWN_REPORT_TAGS = {"ReportPageAttr", "ColumnPrivilegeControl", "RowPrivilegeControl",
                     "RowHeight", "ColumnWidth", "CellElementList", "ReportAttrSet",
                     "ReportWriteAttr", "PrivilegeControl"}
KNOWN_ROOT_TAGS = {"TableDataMap", "ReportWebAttr", "ElementCaseMobileAttr", "Report",
                   "ReportParameterAttr", "StyleList", "DesignerVersion", "PreviewType",
                   "TemplateIdAttMark"}
KNOWN_CELL_TAGS = {"O", "PrivilegeControl", "HighlightList", "Expand", "Widget"}


def _parse_sheet(rep: etree._Element) -> Sheet:
    sh = Sheet(name=rep.get("name") or "sheet1")
    sh.child_order = [c.tag for c in rep if isinstance(c.tag, str)]
    for i, ch in enumerate(rep):
        if isinstance(ch.tag, str) and ch.tag not in KNOWN_REPORT_TAGS:
            sh.extras.append((i, etree.fromstring(etree.tostring(ch))))
    rh = rep.find("RowHeight")
    if rh is not None:
        if rh.get("defaultValue"):
            sh.default_row_height = int(rh.get("defaultValue"))
        if rh.text:
            sh.row_heights = [int(x) for x in rh.text.split(",") if x.strip()]
    cw = rep.find("ColumnWidth")
    if cw is not None:
        if cw.get("defaultValue"):
            sh.default_col_width = int(cw.get("defaultValue"))
        if cw.text:
            sh.col_widths = [int(x) for x in cw.text.split(",") if x.strip()]
    for cel in rep.findall("CellElementList/C"):
        cell = Cell(c=int(cel.get("c", 0)), r=int(cel.get("r", 0)))
        if cel.get("cs"):
            cell.cs = int(cel.get("cs"))
        if cel.get("rs"):
            cell.rs = int(cel.get("rs"))
        if cel.get("s"):
            cell.style = int(cel.get("s"))
        cell.child_order = [k.tag for k in cel if isinstance(k.tag, str)]
        for i, ch in enumerate(cel):
            if isinstance(ch.tag, str) and ch.tag not in KNOWN_CELL_TAGS:
                cell.extras.append((i, etree.fromstring(etree.tostring(ch))))
        o = cel.find("O")
        cell.value = _parse_value(o)
        ex = cel.find("Expand")
        if ex is not None:
            cell.expand = _parse_expand(ex)
        for hl in cel.findall("HighlightList/Highlight"):
            # 只做"读得懂"的解析用于展示；写回一律用 highlight_raw，避免把
            # RowHeight/ColWidth/Value/Present/Hyperlink 这些动作类型改坏。
            cell.highlights.append(_parse_highlight(hl))
        hll = cel.find("HighlightList")
        if hll is not None:
            cell.highlight_raw = etree.fromstring(etree.tostring(hll))
            # 有原始块时不走生成器路径，否则动作类型会被简化成背景色
            cell.highlights = []
        w = cel.find("Widget")
        if w is not None:
            cell.widget = _parse_widget(w)
        sh.cells.append(cell)
    rs = rep.find("ReportAttrSet/ReportSettings")
    if rs is not None:
        fz = rs.find("FrozenColumnRow")
        if fz is not None:
            sh.frozen = fz.get("columnrow")
    for sv in rep.findall("ReportWriteAttr/SubmitVisitor"):
        sh.write_backs.append(_parse_writeback(sv))
    return sh


def _parse_widget(w: etree._Element) -> Widget:
    wid = Widget(class_name=w.get("class") or "com.fr.form.ui.TextEditor")
    name = w.find("WidgetName")
    if name is not None:
        wid.name = name.get("name", "")
    attr = w.find("WidgetAttr")
    if attr is not None:
        wid.description = attr.get("description", "")
    reg = w.find("Reg")
    if reg is not None and reg.get("class"):
        wid.regex = reg.get("class")
    scan = w.find("MobileScanCodeAttr")
    if scan is not None:
        wid.scan_code = scan.get("scanCode") != "false"
        wid.text_input_mode = int(scan.get("textInputMode", "0") or 0)
    return wid


def _parse_highlight(hl: etree._Element) -> Highlight:
    h = Highlight()
    h.name = _text_of(hl.find("Name")).strip() or "条件属性1"
    h.formula = _text_of(hl.find("Condition/Formula")).strip()
    act = hl.find("HighlightAction")
    if act is not None:
        scope = act.find("Scope")
        if scope is not None and scope.get("val"):
            h.scope = int(scope.get("val"))
        bg = act.find("Background")
        h.background = int(bg.get("color", "-1")) if bg is not None else None
    else:
        h.background = None
    return h


def _parse_writeback(sv: etree._Element) -> WriteBack:
    wb = WriteBack()
    wb.name = _text_of(sv.find("Name")).strip() or "内置SQL1"
    attrs = sv.find("Attributes")
    wb.ds_name = attrs.get("dsName", "") if attrs is not None else ""
    dml = sv.find("DMLConfig")
    if dml is not None:
        tbl = dml.find("Table")
        if tbl is not None:
            wb.table_schema = tbl.get("schema", "")
            wb.table_name = tbl.get("name", "")
        for cc in dml.findall("ColumnConfig"):
            m = ColumnMapping(column_name=cc.get("name", ""),
                              is_key=(cc.get("isKey") == "true"))
            grp = cc.find("ColumnRowGroup")
            if grp is not None:
                m.rows = [(int(cr.get("column", "0")), int(cr.get("row", "0")))
                          for cr in grp.findall("ColumnRow")]
            else:
                cr = cc.find("ColumnRow")
                if cr is not None:
                    m.column = int(cr.get("column", "0"))
                    m.row = int(cr.get("row", "0"))
            par = cc.find("Parameter")
            if par is not None:
                nm = par.find("Attributes")
                f = par.find("O")
                expr = _parse_value(f).expr if f is not None else ""
                m.parameter = (nm.get("name", "") if nm is not None else "", expr)
            f = cc.find("O")
            if f is not None:
                v = _parse_value(f)
                m.formula = v.expr if isinstance(v, Formula) else ""
            wb.mappings.append(m)
        wb.update_attr = dml.find("UpdateAttr") is not None
    return wb


def _text_of(el, strip_newlines_only=True) -> str:
    """Text of a node.

    FineReport writes text as `<Tag>\\n<![CDATA[value]]></Tag>`, so the raw .text
    carries a formatting newline. Strip CR/LF (never spaces: a cell value may
    legitimately begin with a space).
    """
    if el is None:
        return ""
    t = el.text or ""
    return t.strip("\r\n") if strip_newlines_only else t.strip()


def _parse_value(o: Optional[etree._Element]) -> CellValue:
    if o is None:
        return Blank()
    t = o.get("t")
    cls = o.get("class")
    if t == "DSColumn":
        attrs = o.find("Attributes")
        v = DSColumn(ds_name=attrs.get("dsName", "") if attrs is not None else "",
                     column_name=attrs.get("columnName", "") if attrs is not None else "")
        rg = o.find("RG")
        if rg is not None:
            rcls = (rg.get("class") or "")
            if rcls.endswith("SummaryGrouper"):
                fn = _text_of(rg.find("FN")).strip()
                for k, name in SUMFUNCS.items():
                    if name == fn:
                        v.aggregate = k
                v.aggregate = v.aggregate or "sum"
            elif rcls.endswith("FunctionGrouper"):
                v.grouper = "group"
        v.condition = o.find("Condition")
        v.result = o.find("Result")
        return v
    if (t == "XMLable" and cls and cls.endswith("Formula")) or t == "Formula":
        return Formula(expr=_text_of(o.find("Attributes")).strip())
    if t == "I":
        try:
            return Number(int(_text_of(o).strip() or "0"))
        except ValueError:
            return Text(text=_text_of(o))
    if t == "D":
        try:
            return Number(float(_text_of(o).strip() or "0"))
        except ValueError:
            return Text(text=_text_of(o))
    if t == "BigDecimal":
        return Number(_text_of(o).strip() or "0")
    if t == "CC":
        return Text(text="<chart>")
    if t == "BiasTextPainter":
        return Text(text=_text_of(o) or "<斜线表头>")
    return Text(text=_text_of(o))


def _parse_expand(ex: etree._Element) -> Expand:
    e = Expand()
    if ex.get("dir") is not None:
        e.direction = int(ex.get("dir"))
    e.left = ex.get("left")
    e.up = ex.get("up")
    if ex.get("leftParentDefault") == "false":
        e.left_parent_default = False
    if ex.get("upParentDefault") == "false":
        e.up_parent_default = False
    if ex.get("order") is not None:
        e.order = int(ex.get("order"))
    if ex.get("multiNumber") is not None:
        e.multi_number = int(ex.get("multiNumber"))
    sf = ex.findtext("SortFormula")
    if sf:
        e.sort_formula = sf.strip()
    return e


def _parse_dataset(td: etree._Element) -> Dataset:
    cls = td.get("class") or ""
    name = td.get("name") or ""
    params = []
    for p in td.findall("Parameters/Parameter"):
        a = p.find("Attributes")
        o = p.find("O")
        params.append(Parameter(name=a.get("name", "") if a is not None else "",
                                value=_text_of(o)))
    if cls.endswith("DBTableData"):
        conn = td.find("Connection/DatabaseName")
        return SqlDataset(name=name,
                          connection=_text_of(conn).strip(),
                          query=_text_of(td.find("Query")).strip(),
                          page_query=_text_of(td.find("PageQuery")).strip(),
                          parameters=params,
                          max_mem_row_count=int(td.find("Attributes").get("maxMemRowCount", "-1"))
                          if td.find("Attributes") is not None else -1)
    if cls.endswith("EmbeddedTableData"):
        names = _text_of(td.find("ColumnNames"))
        types = _text_of(td.find("ColumnTypes"))
        rd = td.find("RowData")
        rows: List[List[str]] = []
        if rd is not None and (rd.text or "").strip():
            try:
                rows = frcodec.text_to_rows(
                    frcodec.decode_string_as_bytes(rd.text).decode("utf-8"))
            except Exception:
                rows = []
        col_names = names.split(",,.,,") if names else []
        col_types = types.split(",") if types else []
        return EmbeddedDataset(name=name,
                               columns=[(n, (col_types[i] if i < len(col_types) else "java.lang.String"))
                                        for i, n in enumerate(col_names)],
                               rows=rows,
                               parameters=params,
                               ds_name=_text_of(td.find("DSName")))
    if cls.endswith("NameTableData"):
        return AliasDataset(name=name, target=_text_of(td.find("Name")).strip())
    return AliasDataset(name=name, target=f"<unsupported {cls}>")


def read_cpt(path: str, encoding: str = "utf-8") -> Workbook:
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            inner = next((n for n in names if n.lower().endswith(".cpt")), names[0])
            raw = z.read(inner)
    root = etree.fromstring(raw)
    wb = Workbook(xml_version=root.get("xmlVersion") or XML_VERSION,
                  release_version=root.get("releaseVersion") or RELEASE_VERSION)
    wb.child_order = [c.tag for c in root if isinstance(c.tag, str)]
    for i, ch in enumerate(root):
        if isinstance(ch.tag, str) and ch.tag not in KNOWN_ROOT_TAGS:
            wb.extras.append((i, etree.fromstring(etree.tostring(ch))))
    wb.write_mobile_attr = root.find("ElementCaseMobileAttr") is not None
    wb.write_web_attr = root.find("ReportWebAttr") is not None
    wb.write_parameter_attr = root.find("ReportParameterAttr") is not None
    for tag, attr in (("ReportWebAttr", "web_attr_raw"),
                      ("ReportParameterAttr", "parameter_attr_raw"),
                      ("ElementCaseMobileAttr", "mobile_attr_raw")):
        el = root.find(tag)
        if el is not None:
            setattr(wb, attr, etree.fromstring(etree.tostring(el)))
    for rep in root.findall("Report"):
        wb.sheets.append(_parse_sheet(rep))
    for td in root.findall("TableDataMap/TableData"):
        wb.datasets.append(_parse_dataset(td))
    for st in root.findall("StyleList/Style"):
        font = st.find("FRFont")
        bg = st.find("Background")
        border = st.find("Border")
        s = Style()
        if st.get("index") is not None:
            s.library_index = int(st.get("index"))
        if st.get("style_name"):
            s.style_name = st.get("style_name")
        if st.get("horizontal_alignment"):
            s.horizontal_alignment = int(st.get("horizontal_alignment"))
        if st.get("vertical_alignment"):
            s.vertical_alignment = int(st.get("vertical_alignment"))
        if st.get("textStyle"):
            s.text_control = int(st.get("textStyle"))
        if st.get("paddingLeft") is not None:
            s.padding_left = int(st.get("paddingLeft"))
        if st.get("paddingRight") is not None:
            s.padding_right = int(st.get("paddingRight"))
        if font is not None:
            s.font_name = font.get("name", "SimSun")
            s.font_style = int(font.get("style", 0))
            s.font_size = int(font.get("size", pt_to_font_size(9)))
            s.foreground = int(font.get("foreground", "-16777216"))
            if font.get("underline"):
                s.underline = int(font.get("underline"))
        if bg is not None and bg.get("name") == "ColorBackground":
            s.background = int(bg.get("color", "-1"))
        if border is not None:
            for tag, attr in (("Top", "top"), ("Bottom", "bottom"),
                              ("Left", "left"), ("Right", "right")):
                e = border.find(tag)
                if e is not None:
                    setattr(s, attr, Border(int(e.get("style", 1)), int(e.get("color", "-16777216"))))
        fmt = st.find("Format")
        if fmt is not None and fmt.get("class", "").endswith("CoreDecimalFormat"):
            s.number_format = (fmt.text or "").strip()
        # read side must NOT deduplicate: the cell's s attribute is a positional index
        wb.styles.styles.append(s)
        wb.styles._index[s.key()] = len(wb.styles.styles) - 1
    return wb


# --------------------------------------------------------------------------- validator
@dataclass
class Issue:
    level: str      # error | warning | info
    code: str
    message: str
    where: str = ""

    def __str__(self):
        loc = f" [{self.where}]" if self.where else ""
        return f"{self.level.upper():7} {self.code}: {self.message}{loc}"


def cell_ref(c: int, r: int) -> str:
    letters = ""
    n = c + 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return f"{letters}{r + 1}"


def validate(wb: Workbook) -> List[Issue]:
    out: List[Issue] = []

    # datasets
    names = [d.name for d in wb.datasets]
    dup = {n for n in names if names.count(n) > 1}
    for n in sorted(dup):
        out.append(Issue("error", "DS_DUPLICATE", f"数据集名重复: {n}", "TableDataMap"))
    for ds in wb.datasets:
        if not ds.name and not isinstance(ds, AliasDataset):
            out.append(Issue("error", "DS_NO_NAME", "数据集缺少 name 属性", "TableDataMap"))
        if isinstance(ds, SqlDataset):
            if not ds.query.strip():
                out.append(Issue("error", "SQL_EMPTY", f"SQL 数据集 {ds.name} 的 Query 为空", ds.name))
            if not ds.connection.strip():
                out.append(Issue("error", "SQL_NOCONN", f"SQL 数据集 {ds.name} 未指定连接名", ds.name))
            if "${" in ds.query and not ds.parameters:
                out.append(Issue("warning", "SQL_PARAM_UNDECLARED",
                                 f"{ds.name} 的 SQL 使用了 ${{...}} 但未声明 Parameters", ds.name))
            for p in ds.parameters:
                if "${" + p.name + "}" not in ds.query:
                    out.append(Issue("warning", "SQL_PARAM_UNUSED",
                                     f"{ds.name} 声明了参数 {p.name} 但 SQL 未引用", ds.name))
        if isinstance(ds, EmbeddedDataset):
            n_col = len(ds.columns)
            if n_col == 0:
                out.append(Issue("error", "EMB_NO_COLUMNS", f"内置数据集 {ds.name} 没有列定义", ds.name))
            seen = set()
            for cname, _ in ds.columns:
                if not cname:
                    out.append(Issue("error", "EMB_EMPTY_COL", f"{ds.name} 存在空列名", ds.name))
                if cname in seen:
                    out.append(Issue("error", "EMB_DUP_COL", f"{ds.name} 列名重复: {cname}", ds.name))
                seen.add(cname)
                if ",,.,," in cname or "," in cname:
                    out.append(Issue("warning", "EMB_COL_DELIM",
                                     f"{ds.name} 列名 {cname!r} 含逗号——列名分隔符是 ',,.,,'，"
                                     "但 ColumnTypes 用 ','，命名请避开逗号", ds.name))
            for i, row in enumerate(ds.rows):
                if len(row) != n_col:
                    out.append(Issue("warning", "EMB_ROW_ARITY",
                                     f"{ds.name} 第 {i + 1} 行有 {len(row)} 个值，列定义是 {n_col} 个",
                                     ds.name))
            try:
                frcodec.decode_string_as_bytes(ds.encode_rows())
            except Exception as e:  # pragma: no cover - guard
                out.append(Issue("error", "EMB_BLOB", f"{ds.name} RowData 编码不可回读: {e}", ds.name))
    # styles
    n_styles = len(wb.styles.styles)
    # sheets
    sh_names = [s.name for s in wb.sheets]
    if not wb.sheets:
        out.append(Issue("error", "NO_SHEET", "模板没有任何 Report(sheet)", "WorkBook"))
    for n in sorted({n for n in sh_names if sh_names.count(n) > 1}):
        out.append(Issue("error", "SHEET_DUP", f"sheet 名重复: {n}", "WorkBook"))
    for sh in wb.sheets:
        if sh.name != "sheet1" and not sh.name:
            out.append(Issue("error", "SHEET_NO_NAME", "sheet 缺少 name", "Report"))
        occupied: Dict[Tuple[int, int], str] = {}
        for cell in sh.cells:
            ref = cell_ref(cell.c, cell.r)
            if cell.c < 0 or cell.r < 0:
                out.append(Issue("error", "CELL_NEG", f"单元格坐标为负: {ref}", sh.name))
            if cell.cs < 1 or cell.rs < 1:
                out.append(Issue("error", "CELL_SPAN", f"{ref} 合并跨度为 0", sh.name))
            for dc in range(cell.cs):
                for dr in range(cell.rs):
                    key = (cell.c + dc, cell.r + dr)
                    if key in occupied and (dc, dr) != (0, 0):
                        out.append(Issue("error", "CELL_OVERLAP",
                                         f"{ref} 的合并区域与 {occupied[key]} 重叠", sh.name))
                    occupied.setdefault(key, ref)
            if cell.style is not None and not (0 <= cell.style < n_styles):
                out.append(Issue("error", "STYLE_INDEX",
                                 f"{ref} 引用样式 {cell.style}，但 StyleList 只有 {n_styles} 项", sh.name))
            v = cell.value
            if isinstance(v, DSColumn):
                if v.ds_name not in names:
                    out.append(Issue(
                        "warning", "DS_NOT_LOCAL",
                        f"{ref} 绑定的数据集 {v.ds_name!r} 未在模板内定义 —— "
                        "FineReport 允许引用平台级『服务器数据集』，只要服务器上存在同名数据集即可；"
                        "若服务器上没有，运行时会报数据集不存在", sh.name))
                else:
                    ds = next(d for d in wb.datasets if d.name == v.ds_name)
                    known = None
                    if isinstance(ds, EmbeddedDataset):
                        known = [c for c, _ in ds.columns]
                    elif isinstance(ds, SqlDataset) and ds.columns:
                        known = [c for c, _ in ds.columns]
                    if known is not None and v.column_name not in known:
                        out.append(Issue("error", "DS_COLUMN_MISSING",
                                         f"{ref} 绑定列 {v.column_name!r} 不在 {v.ds_name} 中"
                                         f"（现有: {', '.join(known)}）", sh.name))
                if v.is_expandable and cell.expand.direction is None:
                    out.append(Issue("warning", "EXPAND_MISSING",
                                     f"{ref} 是可扩展数据列但 Expand 未设方向，将不会扩展", sh.name))
                if v.aggregate and cell.expand.direction is not None:
                    out.append(Issue("warning", "EXPAND_ON_SUMMARY",
                                     f"{ref} 是汇总单元格却设置了扩展方向", sh.name))
            if isinstance(v, Formula):
                if not v.expr.strip().startswith("="):
                    out.append(Issue("warning", "FORMULA_EQ",
                                     f"{ref} 公式缺少前导 '='", sh.name))
            if isinstance(v, Text) and "{{" in v.text and "}}" in v.text:
                out.append(Issue("warning", "MARKER_LEFT",
                                 f"{ref} 仍有未解析的占位符: {v.text[:40]!r}", sh.name))
        # parent cell references
        cmap = {cell_ref(c.c, c.r): c for c in sh.cells}
        for cell in sh.cells:
            for attr in ("left", "up"):
                ref = getattr(cell.expand, attr)
                if ref and ref not in cmap:
                    out.append(Issue("warning", "PARENT_MISSING",
                                     f"{cell_ref(cell.c, cell.r)} 的 {attr} 父格 {ref} 不存在", sh.name))
    return out


def describe_issue_summary(issues: Iterable[Issue]) -> str:
    issues = list(issues)
    if not issues:
        return "校验通过：未发现问题。"
    n_err = sum(1 for i in issues if i.level == "error")
    n_warn = sum(1 for i in issues if i.level == "warning")
    head = f"校验结果：{n_err} 个错误，{n_warn} 个警告。"
    return head + "\n" + "\n".join(str(i) for i in issues)


__all__ = [
    "Workbook", "Sheet", "Cell", "CellValue", "Text", "Number", "Formula", "DSColumn",
    "Blank", "Expand", "Style", "Border", "StyleTable", "SqlDataset", "EmbeddedDataset",
    "AliasDataset", "Parameter", "Dataset", "Issue", "read_cpt", "validate",
    "pt_to_fu", "px_to_fu", "pt_to_font_size", "fr_color", "cell_ref",
    "describe_issue_summary", "FU_PER_PT", "FU_PER_PX", "DEFAULT_ROW_HEIGHT_FU",
    "DEFAULT_COL_WIDTH_FU", "ALIGN_LEFT", "ALIGN_CENTER", "ALIGN_RIGHT",
    "ALIGN_TOP", "ALIGN_BOTTOM", "LINE_THIN", "LINE_NONE",
]
