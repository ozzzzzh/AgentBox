# -*- coding: utf-8 -*-
"""Faithful port of com.fr.stable.Ascii85OutputStream + XMLEncodeUtils byte-string codec.

Verified byte-exact against FineReport 10.0 (see tools/verify_codec.py, which runs the
Java oracle shipped in tools/oracle/Oracle.java).
"""
import zlib

A85_FIRST = 33   # '!'
A85_LAST = 117   # 'u'
MAXLINE = 72
TERMINATOR = "~"


class Ascii85Stream:
    """Mirror of com.fr.stable.Ascii85OutputStream (line_break / count / flushed)."""

    def __init__(self):
        self.out = []
        self.maxline = MAXLINE
        self.line_break = MAXLINE
        self.count = 0
        self.indata = [0, 0, 0, 0]
        self.outdata = [0] * 5
        self.flushed = False
        self.terminator = TERMINATOR

    # -- internal -----------------------------------------------------
    def _tuple(self):
        d = self.indata
        value = (((d[0] << 8) | (d[1] & 0xFF)) << 16) | ((d[2] & 0xFF) << 8) | (d[3] & 0xFF)
        value &= 0xFFFFFFFF
        if value == 0:
            self.outdata = [ord("z"), 0, 0, 0, 0]
            return
        rem = value
        o = self.outdata
        q = rem // 52200625; o[0] = q + A85_FIRST; rem -= q * 52200625
        q = rem // 614125;  o[1] = q + A85_FIRST; rem -= q * 614125
        q = rem // 7225;    o[2] = q + A85_FIRST; rem -= q * 7225
        q = rem // 85;      o[3] = q + A85_FIRST; rem -= q * 85
        o[4] = rem + A85_FIRST

    def _emit(self, byte):
        self.out.append(chr(byte))
        self.line_break -= 1
        if self.line_break == 0:
            self.out.append("\n")
            self.line_break = self.maxline

    # -- public -------------------------------------------------------
    def write_byte(self, b):
        self.flushed = False
        self.indata[self.count] = b & 0xFF
        self.count += 1
        if self.count < 4:
            return
        self._tuple()
        for i in range(5):
            if self.outdata[i] == 0:
                break
            self._emit(self.outdata[i])
        self.count = 0

    def write(self, data: bytes):
        i = 0
        n = len(data)
        while i < n:
            if self.count < 3:
                self.indata[self.count] = data[i]
                self.count += 1
            else:
                self.write_byte(data[i])
            i += 1

    def flush(self):
        if self.flushed:
            return
        if self.count > 0:
            i = self.count
            while i < 4:
                self.indata[i] = 0
                i += 1
            self._tuple()
            if self.outdata[0] == ord("z"):
                for i in range(5):
                    self.outdata[i] = A85_FIRST
            i = 0
            while i < self.count + 1:
                self.out.append(chr(self.outdata[i]))
                self.line_break -= 1
                if self.line_break == 0:
                    self.out.append("\n")
                    self.line_break = self.maxline
                i += 1
        self.line_break -= 1
        if self.line_break == 0:
            self.out.append("\n")
        self.out.append(self.terminator)
        self.out.append("\n")
        self.count = 0
        self.line_break = self.maxline
        self.flushed = True

    def getvalue(self) -> str:
        return "".join(self.out)


def zip_deflate(data: bytes) -> bytes:
    """java.util.zip.Deflater(level=9, nowrap=true) via DeflaterOutputStream."""
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    return co.compress(data) + co.flush()


def zip_inflate(data: bytes) -> bytes:
    """java.util.zip.Inflater(nowrap=true)."""
    return zlib.decompress(data, -15)


def encode_bytes_as_string(data: bytes) -> str:
    stream = Ascii85Stream()
    stream.write(zip_deflate(data))
    stream.flush()
    return stream.getvalue()


def decode_string_as_bytes(text: str) -> bytes:
    out = bytearray()
    group = []
    for ch in text:
        if ch in " \t\r\n\f\v":
            continue
        if ch == TERMINATOR:
            break
        if ch == "z" and not group:
            out.extend(b"\x00\x00\x00\x00")
            continue
        group.append(ord(ch) - A85_FIRST)
        if len(group) == 5:
            value = 0
            for d in group:
                value = value * 85 + d
            out.extend((value & 0xFFFFFFFF).to_bytes(4, "big"))
            group = []
    if group:
        pad = 5 - len(group)
        group.extend([84] * pad)
        value = 0
        for d in group:
            value = value * 85 + d
        out.extend((value & 0xFFFFFFFF).to_bytes(4, "big")[:4 - pad])
    return zip_inflate(bytes(out))


# ------------------------------------------------------------------ row text layer
def rows_to_text(rows, escape=True) -> str:
    """RowDataHelper.writeRowData: rows '\\n', fields '\\t', value tab/newline -> '&t;' / '&n;'."""
    lines = []
    for row in rows:
        cells = []
        for v in row:
            s = "" if v is None else str(v)
            if escape:
                s = s.replace("\t", "&t;").replace("\n", "&n;").replace("\r", "&r;")
            cells.append(s)
        lines.append("\t".join(cells))
    return "\n".join(lines)


def text_to_rows(text, unescape=True):
    if text == "":
        return []
    rows = []
    for line in text.split("\n"):
        cells = [] if line == "" else line.split("\t")
        if unescape:
            cells = [c.replace("&t;", "\t").replace("&n;", "\n").replace("&r;", "\r") for c in cells]
        rows.append(cells)
    return rows


def encode_row_blob(rows) -> str:
    return encode_bytes_as_string(rows_to_text(rows).encode("utf-8"))


def decode_row_blob(text: str):
    return text_to_rows(decode_string_as_bytes(text).decode("utf-8"))
