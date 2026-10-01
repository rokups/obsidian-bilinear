#!/usr/bin/env python3
"""bilinear: command-line client for Bilinear trackers.

A tracker is a folder of Markdown notes: one index note (frontmatter
``bilinear: tracker``), one note per issue and an ``archive/`` subfolder.
The format is specified in spec/FORMAT.md; the Obsidian plugin works on the
same files.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

VERSION = "0.1.0"

PRIORITIES = ["none", "low", "medium", "high", "urgent"]
DEFAULT_STATES = ["backlog", "todo", "in-progress", "in-review", "done", "canceled"]
DEFAULT_CLOSED = ["done", "canceled"]
ISSUES = "Issues"
ARCHIVE = "Archive"
COMMENTS = "Comments"
ISSUES_DIR = "issues"
ARCHIVE_DIR = "archive"
# Where a note can be: the folder for open issues, the archive, or directly in
# the tracker folder (the layout before issues/ existed; still read).
IN_ISSUES, IN_ARCHIVE, IN_ROOT = "issues", "archive", "root"
LOCATIONS = (IN_ISSUES, IN_ARCHIVE, IN_ROOT)
COLOR_NAMES = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"]
LIST_KEYS = ("labels", "blocked-by")
RETRIES = 3
LOCK_TIMEOUT = 10.0  # seconds; override with BILINEAR_LOCK_TIMEOUT
LOCK_FILE = ".bilinear.lock"  # only where a folder cannot be locked itself

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_LINT = 2
EXIT_CONFLICT = 3


class UsageError(Exception):
    """Bad arguments, unknown issue, invalid tracker. Exit code 1."""


class ConflictError(Exception):
    """A file kept changing underneath us. Exit code 3."""


# --------------------------------------------------------------------------
# Lines


def split_lines(text: str) -> list[str]:
    """Split into lines, each keeping its own terminator."""
    return re.findall(r"[^\n]*\n|[^\n]+", text)


def chomp(line: str) -> str:
    if line.endswith("\r\n"):
        return line[:-2]
    if line.endswith("\n"):
        return line[:-1]
    return line


def has_eol(line: str) -> bool:
    return line.endswith("\n")


def detect_eol(text: str) -> str:
    i = text.find("\n")
    return "\r\n" if i > 0 and text[i - 1] == "\r" else "\n"


def is_blank(line: str) -> bool:
    return chomp(line).strip(" \t") == ""


# --------------------------------------------------------------------------
# YAML subset: scalars

_PLAIN_BAD_START = set("!&*-?[]{}|>@`\"'#%,:")
_NUMBER_RE = re.compile(
    r"^[-+]?(\.[0-9]+|[0-9][0-9_]*(\.[0-9_]*)?)([eE][-+]?[0-9]+)?$"
    r"|^0x[0-9a-fA-F]+$|^0o[0-7]+$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$"
)
_RESERVED = {"true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"}
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/"}


def needs_quote(s: str, flow: bool = False) -> bool:
    if s == "":
        return True
    if s[0] in " \t" or s[-1] in " \t":
        return True
    if s[0] in _PLAIN_BAD_START:
        return True
    if ": " in s or " #" in s or s.endswith(":"):
        return True
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in s):
        return True
    if _NUMBER_RE.match(s) or s.lower() in _RESERVED:
        return True
    if flow and any(c in s for c in ",[]{}"):
        return True
    return False


def quote(s: str) -> str:
    out = ['"']
    for c in s:
        if c == "\\":
            out.append("\\\\")
        elif c == '"':
            out.append('\\"')
        elif c == "\n":
            out.append("\\n")
        elif c == "\t":
            out.append("\\t")
        elif c == "\r":
            out.append("\\r")
        elif ord(c) < 0x20 or ord(c) == 0x7F:
            out.append("\\x%02x" % ord(c))
        else:
            out.append(c)
    out.append('"')
    return "".join(out)


def format_scalar(s: str, flow: bool = False) -> str:
    return quote(s) if needs_quote(s, flow) else s


def _scan_double(raw: str) -> tuple[str, int] | None:
    """Parse a double-quoted scalar at raw[0]. Returns (value, end index)."""
    out = []
    i = 1
    while i < len(raw):
        c = raw[i]
        if c == '"':
            return "".join(out), i + 1
        if c == "\\" and i + 1 < len(raw):
            e = raw[i + 1]
            if e == "x" and re.match(r"[0-9a-fA-F]{2}", raw[i + 2:i + 4] or ""):
                out.append(chr(int(raw[i + 2:i + 4], 16)))
                i += 4
                continue
            if e == "u" and re.match(r"[0-9a-fA-F]{4}", raw[i + 2:i + 6] or ""):
                out.append(chr(int(raw[i + 2:i + 6], 16)))
                i += 6
                continue
            out.append(_ESCAPES.get(e, e))
            i += 2
            continue
        out.append(c)
        i += 1
    return None


def _scan_single(raw: str) -> tuple[str, int] | None:
    out = []
    i = 1
    while i < len(raw):
        c = raw[i]
        if c == "'":
            if raw[i + 1:i + 2] == "'":
                out.append("'")
                i += 2
                continue
            return "".join(out), i + 1
        out.append(c)
        i += 1
    return None


_TRAILER_RE = re.compile(r"^[ \t]*(?:[ \t]#.*)?$")
_BARE_LINK_RE = re.compile(r"^\[\[[^\[\]]*\]\]$")


def parse_scalar(raw: str) -> tuple[str | None, str | None]:
    """Parse one scalar. Returns (value, problem). An empty value is None."""
    raw = raw.strip(" \t")
    if raw == "":
        return None, None
    if raw[0] == '"' or raw[0] == "'":
        res = _scan_double(raw) if raw[0] == '"' else _scan_single(raw)
        if res is None:
            return raw, "unterminated quoted scalar"
        value, end = res
        if not _TRAILER_RE.match(raw[end:]):
            return value, "unexpected text after quoted scalar"
        return value, None
    if raw[0] == "#":
        return None, None
    m = re.search(r"[ \t]#", raw)
    if m:
        raw = raw[:m.start()].rstrip(" \t")
    if _BARE_LINK_RE.match(raw):
        return raw, "unquoted wikilink"
    if raw[0] in "&*!|>{%@`":
        return raw, "unsupported YAML syntax"
    if raw[0] == "[":
        return raw, "unsupported YAML syntax"
    if ": " in raw or raw.endswith(":"):
        return raw, "unsupported YAML syntax"
    if raw in ("null", "~"):
        return None, None
    return raw, None


def parse_flow_list(raw: str) -> tuple[list[str], str | None]:
    """Parse ``[a, "b", c]``. raw starts with ``[``."""
    raw = raw.strip(" \t")
    m = re.search(r"\][ \t]*(?:[ \t]#.*)?$", raw)
    if not m:
        return [], "unterminated inline list"
    inner = raw[1:m.start()]
    parts: list[str] = []
    cur: list[str] = []
    depth = 0
    quote_ch = None
    i = 0
    while i < len(inner):
        c = inner[i]
        if quote_ch:
            cur.append(c)
            if quote_ch == '"' and c == "\\" and i + 1 < len(inner):
                cur.append(inner[i + 1])
                i += 2
                continue
            if c == quote_ch:
                if quote_ch == "'" and inner[i + 1:i + 2] == "'":
                    cur.append("'")
                    i += 2
                    continue
                quote_ch = None
        elif c in "\"'" and "".join(cur).strip(" \t") == "":
            quote_ch = c
            cur.append(c)
        elif c in "[{":
            depth += 1
            cur.append(c)
        elif c in "]}":
            depth -= 1
            cur.append(c)
        elif c == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    if quote_ch or depth != 0:
        return [], "malformed inline list"
    parts.append("".join(cur))
    if len(parts) == 1 and parts[0].strip(" \t") == "":
        return [], None
    values: list[str] = []
    problem = None
    for part in parts:
        value, prob = parse_scalar(part)
        if prob:
            problem = problem or prob
        if value is not None:
            values.append(value)
    return values, problem


# --------------------------------------------------------------------------
# YAML subset: frontmatter document

_KEY_RE = re.compile(r"^([^\s:#\-\[\]{}\"'!&*|>%@`,?][^:]*?)[ \t]*:(?:[ \t]+(.*))?$")
_ITEM_RE = re.compile(r"^([ \t]*)-(?:[ \t]+(.*))?$")
_FENCE_LINE_RE = re.compile(r"^---[ \t]*$")


class Entry:
    """One frontmatter key with the raw lines it occupies."""

    def __init__(self, key: str | None, lines: list[str]):
        self.key = key
        self.lines = lines
        self.value: str | list[str] | None = None
        self.style = "raw"  # raw | scalar | flow | block
        self.indent = "  "
        self.problems: list[str] = []


class Doc:
    """A note: optional frontmatter plus body, editable key by key.

    ``text()`` reproduces the input exactly unless a key was changed.
    """

    def __init__(self, text: str):
        self.bom = text.startswith("﻿")
        if self.bom:
            text = text[1:]
        self.eol = detect_eol(text)
        self.has_fm = False
        self.broken = False
        self.open_line = ""
        self.close_line = ""
        self.entries: list[Entry] = []
        self.body = text
        lines = split_lines(text)
        if not lines or not _FENCE_LINE_RE.match(chomp(lines[0])):
            return
        close = None
        for i in range(1, len(lines)):
            if _FENCE_LINE_RE.match(chomp(lines[i])):
                close = i
                break
        if close is None:
            self.broken = True
            return
        self.has_fm = True
        self.open_line = lines[0]
        self.close_line = lines[close]
        self.body = "".join(lines[close + 1:])
        self._parse(lines[1:close])

    def _parse(self, lines: list[str]) -> None:
        i = 0
        while i < len(lines):
            s = chomp(lines[i])
            stripped = s.strip(" \t")
            if stripped == "" or stripped.startswith("#"):
                self.entries.append(Entry(None, [lines[i]]))
                i += 1
                continue
            m = _KEY_RE.match(s)
            if not m:
                e = Entry(None, [lines[i]])
                e.problems.append("unsupported YAML line: " + stripped)
                self.entries.append(e)
                i += 1
                continue
            e = Entry(m.group(1), [lines[i]])
            rest = (m.group(2) or "").strip(" \t")
            i += 1
            if rest == "" or rest.startswith("#"):
                items: list[str] = []
                while i < len(lines):
                    im = _ITEM_RE.match(chomp(lines[i]))
                    if not im:
                        break
                    if not items and e.style != "block":
                        e.indent = im.group(1)
                    e.style = "block"
                    value, prob = parse_scalar(im.group(2) or "")
                    if prob:
                        e.problems.append(prob)
                    if value is not None:
                        items.append(value)
                    e.lines.append(lines[i])
                    i += 1
                if e.style == "block":
                    e.value = items
                else:
                    e.style = "scalar"
                    e.value = None
            elif rest.startswith("[") and not _BARE_LINK_RE.match(rest):
                e.style = "flow"
                e.value, prob = parse_flow_list(rest)
                if prob:
                    e.problems.append(prob)
            else:
                e.style = "scalar"
                e.value, prob = parse_scalar(rest)
                if prob:
                    e.problems.append(prob)
            # Indented continuation lines are outside the subset; keep them
            # attached so that edits never split them from their key.
            while i < len(lines):
                c = chomp(lines[i])
                if c[:1] in (" ", "\t") and c.strip(" \t") != "":
                    e.lines.append(lines[i])
                    e.problems.append("nested or multi-line value")
                    i += 1
                else:
                    break
            if self.find(e.key) is not None:
                e.problems.append("duplicate key")
            self.entries.append(e)

    # -- reading

    def find(self, key: str) -> Entry | None:
        for e in self.entries:
            if e.key == key:
                return e
        return None

    def get(self, key: str) -> str | list[str] | None:
        e = self.find(key)
        return e.value if e else None

    def get_str(self, key: str) -> str | None:
        v = self.get(key)
        if isinstance(v, list):
            return v[0] if v else None
        return v

    def get_list(self, key: str) -> list[str]:
        v = self.get(key)
        if v is None:
            return []
        return v if isinstance(v, list) else [v]

    def keys(self) -> list[str]:
        return [e.key for e in self.entries if e.key is not None]

    def problems(self) -> list[str]:
        out = []
        if self.broken:
            out.append("frontmatter is not terminated")
        for e in self.entries:
            if e.problems:  # one report per key is enough
                out.append(f"{e.key}: {e.problems[0]}" if e.key else e.problems[0])
        return out

    # -- editing

    def _format(self, key: str, value: str | list[str], block: bool, indent: str) -> list[str]:
        if isinstance(value, list):
            if block and value:
                out = [f"{key}:{self.eol}"]
                out += [f"{indent}- {format_scalar(v)}{self.eol}" for v in value]
                return out
            inner = ", ".join(format_scalar(v, flow=True) for v in value)
            return [f"{key}: [{inner}]{self.eol}"]
        return [f"{key}: {format_scalar(value)}{self.eol}"]

    def set(self, key: str, value: str | list[str] | None, raw: bool = False) -> None:
        """Set or (value None) remove a key. raw=True writes the scalar unquoted."""
        if self.broken:
            raise UsageError("frontmatter is not terminated; fix the note by hand")
        e = self.find(key)
        if value is None:
            if e:
                self.entries.remove(e)
            return
        if e and not e.problems and e.value == value and not raw:
            return
        if not self.has_fm:
            self.has_fm = True
            self.open_line = "---" + self.eol
            self.close_line = "---" + self.eol
        if raw:
            lines = [f"{key}: {value}{self.eol}"]
        else:
            lines = self._format(key, value, bool(e and e.style == "block"), e.indent if e else "  ")
        if e:
            e.lines = lines
            e.value = value
            e.problems = []
            if not isinstance(value, list):
                e.style = "scalar"
            elif e.style != "block" or not value:
                e.style = "flow"
        else:
            ne = Entry(key, lines)
            ne.value = value
            ne.style = "flow" if isinstance(value, list) else "scalar"
            self.entries.append(ne)

    def text(self) -> str:
        out = ["﻿"] if self.bom else []
        if self.has_fm:
            out.append(self.open_line)
            for e in self.entries:
                out.extend(e.lines)
            close = self.close_line
            if self.body and not has_eol(close):
                close += self.eol
            out.append(close)
        out.append(self.body)
        return "".join(out)


# --------------------------------------------------------------------------
# Markdown structure

_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$")
_CODE_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def classify(lines: list[str]) -> list[tuple]:
    """Per line: ('code',), ('heading', level, name) or ('text',)."""
    out: list[tuple] = []
    fence = None
    for line in lines:
        s = chomp(line)
        if fence:
            t = s.strip(" \t")
            if t and len(t) >= len(fence) and set(t) == {fence[0]}:
                fence = None
            out.append(("code",))
            continue
        m = _CODE_FENCE_RE.match(s)
        if m:
            fence = m.group(1)
            out.append(("code",))
            continue
        m = _HEADING_RE.match(s)
        if m:
            out.append(("heading", len(m.group(1)), m.group(2).strip(" \t")))
        else:
            out.append(("text",))
    return out


def find_sections(lines: list[str], names: tuple[str, ...]) -> tuple[dict, list[str], list[tuple]]:
    """Locate level-2 sections. Returns ({name: (heading, end)}, duplicates, kinds).

    A section runs from its heading to the next heading of level 1 or 2.
    Only the first heading with a given name counts.
    """
    kinds = classify(lines)
    sections: dict[str, tuple[int, int]] = {}
    dups: list[str] = []
    cur = None
    for i, k in enumerate(kinds):
        if k[0] == "heading" and k[1] <= 2:
            if cur:
                sections[cur] = (sections[cur][0], i)
                cur = None
            if k[1] == 2 and k[2] in names:
                if k[2] in sections:
                    dups.append(k[2])
                else:
                    sections[k[2]] = (i, len(lines))
                    cur = k[2]
    return sections, dups, kinds


# --------------------------------------------------------------------------
# IDs and links

ID_RE = re.compile(r"^([A-Z][A-Z0-9]*)-([0-9]+)$")
PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9]*$")
_LINK_RE = re.compile(r"^\[\[([^\[\]]*)\]\]$")
_LIST_LINE_RE = re.compile(r"^[ \t]*[-*+][ \t]+\[\[([^\[\]]*)\]\](?:[ \t]+(.*?))?[ \t]*$")


def link_target(inner: str) -> str:
    """Reduce a wikilink body (``path/RB-4.md#h|alias``) to its note name."""
    inner = re.split(r"[|#]", inner, maxsplit=1)[0].strip(" \t")
    inner = inner.rsplit("/", 1)[-1]
    if inner.endswith(".md"):
        inner = inner[:-3]
    return inner


def link_id(value: str | None) -> str | None:
    """Issue ID named by a property value: ``[[RB-9]]`` or a bare ``RB-9``."""
    if not value:
        return None
    value = value.strip(" \t")
    m = _LINK_RE.match(value)
    if m:
        value = link_target(m.group(1))
    return value if ID_RE.match(value) else None


def make_link(issue_id: str) -> str:
    return f"[[{issue_id}]]"


def id_number(issue_id: str, prefix: str | None) -> int | None:
    m = ID_RE.match(issue_id)
    if m and (prefix is None or m.group(1) == prefix):
        return int(m.group(2))
    return None


def clean_title(title: str | None) -> str:
    return re.sub(r"\s+", " ", title or "").strip()


def format_line(issue_id: str, title: str) -> str:
    return f"- [[{issue_id}]] {title}" if title else f"- [[{issue_id}]]"


_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def normalize_color(color: str) -> str | None:
    """A colour name from COLOR_NAMES (any letter case) or #rgb / #rrggbb; else None."""
    color = color.strip(" \t")
    if color.lower() in COLOR_NAMES:
        return color.lower()
    return color if _HEX_COLOR_RE.match(color) else None


def parse_label_color(entry: str) -> tuple[str, str] | None:
    """Split a `name=color` entry at its last `=`."""
    name, sep, color = entry.rpartition("=")
    name = name.strip(" \t")
    normalized = normalize_color(color)
    if not sep or not name or normalized is None:
        return None
    return name, normalized


def valid_date(s: str | None) -> bool:
    if not s or not re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", s):
        return False
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        return False
    return True


# --------------------------------------------------------------------------
# Index note


class Item:
    def __init__(self, line: int, section: str, issue_id: str, title: str, canonical: bool):
        self.line = line
        self.section = section
        self.id = issue_id
        self.title = title
        self.canonical = canonical

    @property
    def archived(self) -> bool:
        return self.section == ARCHIVE


class Index:
    def __init__(self, text: str):
        self.doc = Doc(text)
        self.eol = self.doc.eol
        self.lines = split_lines(self.doc.body)
        self.scan()

    def scan(self) -> None:
        self.sections, self.dup_sections, kinds = find_sections(self.lines, (ISSUES, ARCHIVE))
        self.items: list[Item] = []
        for name, (start, end) in self.sections.items():
            for i in range(start + 1, end):
                if kinds[i][0] != "text":
                    continue
                s = chomp(self.lines[i])
                m = _LIST_LINE_RE.match(s)
                if not m:
                    continue
                issue_id = link_target(m.group(1))
                if not ID_RE.match(issue_id):
                    continue
                title = m.group(2) or ""
                self.items.append(Item(i, name, issue_id, title, s == format_line(issue_id, title)))
        self.items.sort(key=lambda it: it.line)

    def text(self) -> str:
        self.doc.body = "".join(self.lines)
        return self.doc.text()

    # -- frontmatter

    def is_tracker(self) -> bool:
        return self.doc.get_str("bilinear") == "tracker"

    @property
    def prefix(self) -> str | None:
        p = self.doc.get_str("prefix")
        return p if p and PREFIX_RE.match(p) else None

    @property
    def next(self) -> int | None:
        v = self.doc.get_str("next")
        return int(v) if v and re.match(r"^[0-9]+$", v) else None

    @property
    def states(self) -> list[str]:
        return self.doc.get_list("states")

    @property
    def closed_states(self) -> list[str]:
        return self.doc.get_list("closed-states")

    @property
    def labels(self) -> list[str]:
        return self.doc.get_list("labels")

    @property
    def label_colors(self) -> dict[str, str]:
        """Colours given to labels by `label-colors: [name=color, ...]`."""
        out: dict[str, str] = {}
        for entry in self.doc.get_list("label-colors"):
            parsed = parse_label_color(entry)
            if parsed:
                out[parsed[0]] = parsed[1]
        return out

    def label_color_problems(self) -> list[str]:
        return [
            f"label-colors entry '{entry}' is not of the form name=color"
            for entry in self.doc.get_list("label-colors") if parse_label_color(entry) is None
        ]

    def add_label(self, name: str) -> None:
        if name not in self.labels:
            self.doc.set("labels", self.labels + [name])

    def set_label_color(self, name: str, color: str | None) -> None:
        """Set or (color None) clear a label's colour. Other entries are kept as they are."""
        entries = []
        done = False
        for entry in self.doc.get_list("label-colors"):
            parsed = parse_label_color(entry)
            if parsed and parsed[0] == name:
                if color is not None and not done:
                    entries.append(f"{name}={color}")
                done = True
            else:
                entries.append(entry)
        if color is not None and not done:
            entries.append(f"{name}={color}")
        self.doc.set("label-colors", entries or None)

    def set_next(self, n: int) -> None:
        if self.next != n:
            self.doc.set("next", str(n), raw=True)

    def key_problems(self) -> list[str]:
        out = []
        if self.prefix is None:
            out.append("prefix is missing or not of the form [A-Z][A-Z0-9]*")
        if self.next is None or self.next < 1:
            out.append("next is missing or not a positive integer")
        if not self.states:
            out.append("states is missing or empty")
        for s in self.closed_states:
            if s not in self.states:
                out.append(f"closed-states entry '{s}' is not in states")
        return out

    # -- items

    def unique(self) -> list[Item]:
        seen = set()
        out = []
        for it in self.items:
            if it.id not in seen:
                seen.add(it.id)
                out.append(it)
        return out

    def find(self, issue_id: str) -> Item | None:
        for it in self.items:
            if it.id == issue_id:
                return it
        return None

    def in_section(self, section: str) -> list[Item]:
        return [it for it in self.unique() if it.section == section]

    def highest(self) -> int:
        nums = [id_number(it.id, self.prefix) for it in self.items]
        return max([n for n in nums if n is not None], default=0)

    # -- editing

    def _insert(self, pos: int, text: str) -> None:
        if pos > 0 and not has_eol(self.lines[pos - 1]):
            self.lines[pos - 1] += self.eol
        self.lines.insert(pos, text + self.eol)
        self.scan()

    def _ensure_section(self, name: str) -> None:
        if name in self.sections:
            return
        if name == ISSUES and ARCHIVE in self.sections:
            pos = self.sections[ARCHIVE][0]
            if pos > 0 and not has_eol(self.lines[pos - 1]):
                self.lines[pos - 1] += self.eol
            new = [f"## {name}{self.eol}", self.eol]
            if pos > 0 and not is_blank(self.lines[pos - 1]):
                new.insert(0, self.eol)
            self.lines[pos:pos] = new
        else:
            if self.lines and not has_eol(self.lines[-1]):
                self.lines[-1] += self.eol
            if self.lines and not is_blank(self.lines[-1]):
                self.lines.append(self.eol)
            self.lines.append(f"## {name}{self.eol}")
        self.scan()

    def add(self, issue_id: str, title: str, section: str = ISSUES, top: bool = False) -> None:
        self._ensure_section(section)
        items = [it for it in self.items if it.section == section]
        if items:
            pos = items[0].line if top else items[-1].line + 1
        else:
            pos = self.sections[section][0] + 1
        self._insert(pos, format_line(issue_id, title))

    def remove_line(self, item: Item) -> None:
        del self.lines[item.line]
        self.scan()

    def remove(self, issue_id: str) -> None:
        """Remove every line for an ID."""
        while (it := self.find(issue_id)) is not None:
            self.remove_line(it)

    def rewrite(self, item: Item, title: str) -> None:
        line = self.lines[item.line]
        eol = line[len(chomp(line)):]
        self.lines[item.line] = format_line(item.id, title) + eol
        self.scan()

    def move_to_section(self, issue_id: str, section: str) -> None:
        it = self.find(issue_id)
        title = it.title if it else ""
        self.remove(issue_id)
        self.add(issue_id, title, section)

    def move(self, issue_id: str, where: str, anchor: str | None = None) -> None:
        """Reorder within ``## Issues``. where: before | after | top | bottom."""
        it = self.find(issue_id)
        title = it.title
        self.remove(issue_id)
        if where in ("top", "bottom"):
            self.add(issue_id, title, ISSUES, top=(where == "top"))
            return
        target = self.find(anchor)
        pos = target.line if where == "before" else target.line + 1
        self._insert(pos, format_line(issue_id, title))

    def sync_titles(self, titles: dict[str, str]) -> None:
        """The title property wins over the copy kept on the index line."""
        for it in self.unique():
            t = titles.get(it.id)
            if t and t != it.title:
                self.rewrite(self.find(it.id), t)


def new_index_text(prefix: str) -> str:
    return (
        "---\n"
        "bilinear: tracker\n"
        f"prefix: {prefix}\n"
        "next: 1\n"
        f"states: [{', '.join(DEFAULT_STATES)}]\n"
        f"closed-states: [{', '.join(DEFAULT_CLOSED)}]\n"
        "labels: []\n"
        "---\n"
        "\n"
        f"## {ISSUES}\n"
        "\n"
        f"## {ARCHIVE}\n"
    )


# --------------------------------------------------------------------------
# Issue note

NOTE_KEY_ORDER = ["title", "status", "priority", "labels", "assignee", "due", "parent", "blocked-by", "created"]


def new_note_text(props: dict) -> str:
    doc = Doc("")
    for key in NOTE_KEY_ORDER:
        value = props.get(key)
        if value is None or value == []:
            continue
        doc.set(key, value)
    return doc.text()


def add_comment(text: str, date: str, author: str, comment: str) -> str:
    doc = Doc(text)
    eol = doc.eol
    lines = split_lines(doc.body)
    entry = f"- {date} {author}: {clean_title(comment)}{eol}"
    sections, _, _ = find_sections(lines, (COMMENTS,))
    if COMMENTS in sections:
        start, end = sections[COMMENTS]
        pos = start + 1
        for i in range(start + 1, end):
            if not is_blank(lines[i]):
                pos = i + 1
        if not has_eol(lines[pos - 1]):
            lines[pos - 1] += eol
        lines.insert(pos, entry)
    else:
        if lines and not has_eol(lines[-1]):
            lines[-1] += eol
        if (lines and not is_blank(lines[-1])) or (not lines and doc.has_fm):
            lines.append(eol)
        lines.append(f"## {COMMENTS}{eol}")
        lines.append(entry)
    doc.body = "".join(lines)
    return doc.text()


# --------------------------------------------------------------------------
# Files

_before_write_hook = None  # tests: called with the path just before the re-read

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None


class TrackerLock:
    """Exclusive lock on a tracker folder, held for one whole command.

    Every command that writes takes it first, so two CLI processes never
    interleave: the second waits for the first to finish and then works on
    what the first left behind. The lock is advisory and only binds other
    `bilinear` processes; Obsidian and sync tools are covered by the hash
    check in update_file instead.

    On POSIX the folder itself is locked with flock, which leaves no file
    behind and is released by the kernel if the process dies. Where that is
    not possible a `.bilinear.lock` file in the folder is locked instead.
    """

    def __init__(self, folder: Path, timeout: float | None = None):
        self.folder = folder
        if timeout is None:
            try:
                timeout = float(os.environ.get("BILINEAR_LOCK_TIMEOUT", LOCK_TIMEOUT))
            except ValueError:
                timeout = LOCK_TIMEOUT
        self.timeout = timeout
        self.fd: int | None = None

    def _try(self) -> bool:
        try:
            if fcntl is not None:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True

    def __enter__(self) -> "TrackerLock":
        if fcntl is not None:
            self.fd = os.open(self.folder, os.O_RDONLY)
        else:
            self.fd = os.open(self.folder / LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o644)
        deadline = time.monotonic() + self.timeout
        delay = 0.005
        while not self._try():
            if time.monotonic() >= deadline:
                os.close(self.fd)
                self.fd = None
                raise ConflictError(
                    f"{self.folder} is locked by another bilinear process; gave up after {self.timeout:g}s")
            time.sleep(delay)
            delay = min(delay * 2, 0.1)
        return self

    def __exit__(self, *exc) -> None:
        if self.fd is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            else:
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
        finally:
            os.close(self.fd)
            self.fd = None


def _sync_dir(folder: Path) -> None:
    """Make a rename in this folder durable. Not possible on Windows."""
    try:
        fd = os.open(folder, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _digest(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def replace_file(src: Path | str, dst: Path) -> None:
    """os.replace, patient with Windows.

    There a rename fails while another process has the destination open,
    which a reader (a `list`, a virus scanner, a sync client) can do for a
    moment at any time. Try again briefly before giving up.
    """
    delay = 0.01
    for attempt in range(8):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 7:
                raise
            time.sleep(delay)
            delay *= 2


def atomic_write(path: Path, data: bytes) -> None:
    """Replace a file's contents in one step: readers see the old or the new, never a mix."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        except FileNotFoundError:
            os.chmod(tmp, 0o644)
        replace_file(tmp, path)
        _sync_dir(path.parent)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def update_file(path: Path, fn) -> bool:
    """Read, transform, and write back unless the file changed meanwhile.

    fn(text) returns the new text, or None to leave the file alone. The
    whole operation is redone on a fresh read if the file changed between
    read and write; after three attempts ConflictError is raised.

    Other bilinear processes are kept out by TrackerLock. This check is for
    writers that do not take the lock (Obsidian, sync): it catches a change
    made while fn ran, but not one landing in the instant between the
    re-read and the rename.
    """
    for _ in range(RETRIES):
        old = path.read_bytes()
        seen = _digest(old)
        new = fn(old.decode("utf-8"))
        if new is None:
            return False
        data = new.encode("utf-8")
        if _before_write_hook:
            _before_write_hook(path)
        if _digest(path.read_bytes()) != seen:
            continue
        if data != old:
            atomic_write(path, data)
        return True
    raise ConflictError(f"{path} kept changing; gave up after {RETRIES} attempts")


def read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


def is_index_note(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            head = f.read(4096).decode("utf-8", errors="replace")
    except OSError:
        return False
    if not head.lstrip("﻿").startswith("---"):
        return False
    return Doc(head if "\n---" in head[3:] else read_text(path)).get_str("bilinear") == "tracker"


def index_notes(folder: Path) -> list[Path]:
    try:
        names = sorted(p for p in folder.iterdir() if p.suffix == ".md" and p.is_file())
    except OSError:
        return []
    found = [p for p in names if is_index_note(p)]
    # The note named after the folder comes first.
    found.sort(key=lambda p: p.stem != folder.name)
    return found


class Tracker:
    def __init__(self, index_path: Path):
        self.index_path = index_path
        self.dir = index_path.parent

    # -- discovery

    @staticmethod
    def open(path: str | None) -> "Tracker":
        if path:
            p = Path(path)
            if p.is_file():
                if not is_index_note(p):
                    raise UsageError(f"{p} is not a tracker index note")
                return Tracker(p.resolve())
            found = index_notes(p)
            if not found:
                raise UsageError(f"no tracker index note in {p}")
            return Tracker(found[0].resolve())
        d = Path.cwd().resolve()
        for folder in [d, *d.parents]:
            found = index_notes(folder)
            if found:
                return Tracker(found[0])
        raise UsageError("no tracker found; use --tracker, BILINEAR_TRACKER or run inside a tracker folder")

    # -- paths

    def folder(self, where: str) -> Path:
        return {IN_ISSUES: self.dir / ISSUES_DIR, IN_ARCHIVE: self.dir / ARCHIVE_DIR, IN_ROOT: self.dir}[where]

    def path_in(self, issue_id: str, where: str) -> Path:
        return self.folder(where) / f"{issue_id}.md"

    def note_path(self, issue_id: str, archived: bool) -> Path:
        """Where the note belongs: issues/ for an open issue, archive/ for an archived one."""
        return self.path_in(issue_id, place(archived))

    def found(self, issue_id: str) -> list[str]:
        """The locations that hold a note for this ID."""
        return [w for w in LOCATIONS if self.path_in(issue_id, w).is_file()]

    def resolve(self, item: Item) -> Path | None:
        """The note for an index line: where its section says, then the other
        folder, then the tracker folder itself."""
        for where in (place(item.archived), place(not item.archived), IN_ROOT):
            p = self.path_in(item.id, where)
            if p.is_file():
                return p
        return None

    def note_ids(self, where: str) -> list[str]:
        folder = self.folder(where)
        try:
            names = [p.stem for p in folder.iterdir() if p.suffix == ".md" and p.is_file()]
        except OSError:
            return []
        return sorted((n for n in names if ID_RE.match(n)), key=lambda n: (n.split("-")[0], int(n.split("-")[1])))

    def vault_root(self) -> Path | None:
        for folder in [self.dir, *self.dir.parents]:
            if (folder / ".obsidian").is_dir():
                return folder
        return None

    # -- index

    def read_index(self) -> Index:
        idx = Index(read_text(self.index_path))
        problems = idx.key_problems()
        if idx.doc.broken or problems:
            raise UsageError(f"{self.index_path.name}: " + "; ".join(problems or idx.doc.problems()))
        return idx

    def titles(self, idx: Index) -> dict[str, str]:
        out = {}
        for it in idx.unique():
            p = self.resolve(it)
            if p:
                t = clean_title(Doc(read_text(p)).get_str("title"))
                if t:
                    out[it.id] = t
        return out

    def update_index(self, fn) -> None:
        """Apply fn(index) and write the index: the commit point of an operation."""
        def transform(text: str) -> str:
            idx = Index(text)
            fn(idx)
            idx.sync_titles(self.titles(idx))
            return idx.text()
        update_file(self.index_path, transform)

    def require(self, idx: Index, issue_id: str) -> Item:
        it = idx.find(issue_id)
        if it is None:
            raise UsageError(f"{issue_id}: no such issue in {self.index_path.name}")
        return it

    def move_note(self, issue_id: str, to_archive: bool) -> None:
        """Put the note where it belongs, from wherever it is."""
        target = place(to_archive)
        here = self.found(issue_id)
        elsewhere = [w for w in here if w != target]
        if not elsewhere:
            return
        if len(here) > 1:
            raise UsageError(f"{issue_id}: note exists in more than one place ({describe(here)})")
        dst = self.path_in(issue_id, target)
        dst.parent.mkdir(exist_ok=True)
        replace_file(self.path_in(issue_id, elsewhere[0]), dst)


def place(archived: bool) -> str:
    return IN_ARCHIVE if archived else IN_ISSUES


def describe(where: list[str] | str) -> str:
    names = {IN_ISSUES: f"{ISSUES_DIR}/", IN_ARCHIVE: f"{ARCHIVE_DIR}/", IN_ROOT: "the tracker folder"}
    if isinstance(where, str):
        return names[where]
    return ", ".join(names[w] for w in where)


# --------------------------------------------------------------------------
# Issue records


def issue_record(t: Tracker, item: Item) -> dict:
    path = t.resolve(item)
    rec = {
        "id": item.id,
        "title": item.title,
        "status": None,
        "priority": "none",
        "labels": [],
        "assignee": None,
        "due": None,
        "parent": None,
        "blocked-by": [],
        "created": None,
        "archived": item.archived,
        "missing": path is None,
    }
    if path is None:
        return rec
    doc = Doc(read_text(path))
    rec["title"] = clean_title(doc.get_str("title")) or item.title
    rec["status"] = doc.get_str("status")
    rec["priority"] = doc.get_str("priority") or "none"
    rec["labels"] = doc.get_list("labels")
    rec["assignee"] = doc.get_str("assignee")
    rec["due"] = doc.get_str("due")
    rec["parent"] = link_id(doc.get_str("parent"))
    rec["blocked-by"] = [i for i in (link_id(v) for v in doc.get_list("blocked-by")) if i]
    rec["created"] = doc.get_str("created")
    return rec


def today() -> str:
    return os.environ.get("BILINEAR_TODAY") or datetime.date.today().isoformat()


def csv_values(values: list[str] | None) -> list[str]:
    out = []
    for v in values or []:
        out += [p.strip() for p in v.split(",") if p.strip()]
    return out


def warn(msg: str) -> None:
    print(f"bilinear: {msg}", file=sys.stderr)


# --------------------------------------------------------------------------
# Commands


def cmd_init(args) -> int:
    prefix = args.prefix
    if not PREFIX_RE.match(prefix):
        raise UsageError("--prefix must be of the form [A-Z][A-Z0-9]*")
    folder = Path(args.folder)
    if index_notes(folder):
        raise UsageError(f"{folder} already contains a tracker")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ISSUES_DIR).mkdir(exist_ok=True)
    (folder / ARCHIVE_DIR).mkdir(exist_ok=True)
    index = folder / f"{folder.resolve().name}.md"
    try:
        with open(index, "x", encoding="utf-8", newline="") as f:
            f.write(new_index_text(prefix))
    except FileExistsError:
        raise UsageError(f"{index} already exists and is not a tracker index") from None
    print(index)
    return EXIT_OK


def check_props(idx: Index, props: dict, self_id: str | None = None) -> None:
    """Validate values about to be written. Unknown labels only warn."""
    if "title" in props and not props["title"]:
        raise UsageError("title must not be empty")
    if props.get("status") is not None and props["status"] not in idx.states:
        raise UsageError(f"unknown status '{props['status']}' (states: {', '.join(idx.states)})")
    if props.get("priority") is not None and props["priority"] not in PRIORITIES:
        raise UsageError(f"unknown priority '{props['priority']}' (one of: {', '.join(PRIORITIES)})")
    for key in ("due", "created"):
        if props.get(key) is not None and not valid_date(props[key]):
            raise UsageError(f"{key} must be a date in the form YYYY-MM-DD")
    for label in props.get("labels") or []:
        if label not in idx.labels:
            warn(f"warning: label '{label}' is not in the tracker's labels")
    links = list(props.get("blocked-by") or [])
    if props.get("parent") is not None:
        links.append(props["parent"])
    for link in links:
        target = link_id(link)
        if target is None:
            raise UsageError(f"'{link}' is not an issue ID")
        if target == self_id:
            raise UsageError(f"{target}: an issue cannot refer to itself")
        if idx.find(target) is None:
            raise UsageError(f"{target}: no such issue")


def cmd_new(t: Tracker, args) -> int:
    idx = t.read_index()
    props = {
        "title": clean_title(args.title),
        "status": args.status or idx.states[0],
        "priority": args.priority or "none",
        "labels": csv_values(args.label),
        "assignee": args.assignee,
        "due": args.due,
        "parent": args.parent,
        "created": today(),
    }
    check_props(idx, props)
    if props["parent"]:
        props["parent"] = make_link(link_id(props["parent"]))
    text = new_note_text(props)

    prefix = idx.prefix
    seen = [idx.highest()]
    for where in LOCATIONS:
        seen += [id_number(i, prefix) or 0 for i in t.note_ids(where)]
    n = max(idx.next, max(seen) + 1)
    t.folder(IN_ISSUES).mkdir(exist_ok=True)
    while True:
        issue_id = f"{prefix}-{n}"
        if t.path_in(issue_id, IN_ARCHIVE).exists() or t.path_in(issue_id, IN_ROOT).exists():
            n += 1
            continue
        try:
            with open(t.note_path(issue_id, False), "x", encoding="utf-8", newline="") as f:
                f.write(text)
            break
        except FileExistsError:
            n += 1

    def commit(i: Index) -> None:
        if i.find(issue_id) is None:
            i.add(issue_id, props["title"], ISSUES, top=args.top)
        i.set_next(max(i.next or 1, n + 1))

    t.update_index(commit)
    if args.json:
        print(json.dumps({"id": issue_id, "path": str(t.note_path(issue_id, False))}))
    else:
        print(issue_id)
    return EXIT_OK


def cmd_list(t: Tracker, args) -> int:
    idx = t.read_index()
    statuses = csv_values(args.status)
    labels = csv_values(args.label)
    assignees = csv_values(args.assignee)
    priorities = csv_values(args.priority)
    out = []
    for it in idx.unique():
        if not args.all and it.archived != bool(args.archived):
            continue
        rec = issue_record(t, it)
        if statuses and rec["status"] not in statuses:
            continue
        if labels and not any(label in rec["labels"] for label in labels):
            continue
        if assignees and rec["assignee"] not in assignees:
            continue
        if priorities and rec["priority"] not in priorities:
            continue
        out.append(rec)
    if args.json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return EXIT_OK
    if not out:
        return EXIT_OK
    w_id = max(len(r["id"]) for r in out)
    w_st = max(len(r["status"] or "-") for r in out)
    w_pr = max(len(r["priority"]) for r in out)
    for r in out:
        extra = ""
        if r["missing"]:
            extra += "  (note missing)"
        if r["assignee"]:
            extra += f"  @{r['assignee']}"
        if r["labels"]:
            extra += "  " + " ".join("#" + label for label in r["labels"])
        if r["archived"] and args.all:
            extra += "  [archived]"
        print(f"{r['id']:<{w_id}}  {r['status'] or '-':<{w_st}}  {r['priority']:<{w_pr}}  {r['title']}{extra}")
    return EXIT_OK


def cmd_show(t: Tracker, args) -> int:
    idx = t.read_index()
    it = t.require(idx, args.id)
    rec = issue_record(t, it)
    path = t.resolve(it)
    doc = Doc(read_text(path)) if path else None
    if args.json:
        rec["path"] = str(path) if path else None
        rec["properties"] = {k: doc.get(k) for k in doc.keys()} if doc else {}
        rec["body"] = doc.body if doc else ""
        print(json.dumps(rec, indent=2, ensure_ascii=False))
        return EXIT_OK
    print(f"{rec['id']}  {rec['title']}")
    if doc is None:
        print("(note missing)")
        return EXIT_OK
    for key in doc.keys():
        if key == "title":
            continue
        value = doc.get(key)
        if isinstance(value, list):
            value = ", ".join(value)
        print(f"{key + ':':<12} {value if value is not None else ''}")
    if rec["archived"]:
        print(f"{'archived:':<12} yes")
    body = doc.body.strip("\r\n")
    if body:
        print()
        print(body)
    return EXIT_OK


_ASSIGN_RE = re.compile(r"^([^=+\-\s][^=\s]*?)(\+=|-=|=)(.*)$", re.S)


def cmd_set(t: Tracker, args) -> int:
    idx = t.read_index()
    it = t.require(idx, args.id)
    path = t.resolve(it)
    if path is None:
        raise UsageError(f"{args.id}: note missing")
    edits = []
    for a in args.assignments:
        m = _ASSIGN_RE.match(a)
        if not m:
            raise UsageError(f"'{a}' is not of the form key=value")
        edits.append((m.group(1), m.group(2), m.group(3).strip()))
    retitle = any(key == "title" for key, _, _ in edits)

    def transform(text: str) -> str:
        doc = Doc(text)
        for key, op, raw in edits:
            is_list = key in LIST_KEYS or op != "=" or isinstance(doc.get(key), list)
            links = key in ("parent", "blocked-by")
            if is_list:
                given = csv_values([raw])
                if links:
                    check_props(idx, {"blocked-by": given}, it.id)
                    given = [make_link(link_id(v)) for v in given]
                if op == "=":
                    value = given
                else:
                    value = list(doc.get_list(key))
                    for v in given:
                        if op == "+=" and v not in value:
                            value.append(v)
                        elif op == "-=" and v in value:
                            value.remove(v)
                if key == "labels":
                    check_props(idx, {"labels": [v for v in value if v not in doc.get_list(key)]})
                doc.set(key, value if value else None)
                continue
            if key == "title":
                raw = clean_title(raw)
            if raw == "":
                if key in ("title", "status"):
                    raise UsageError(f"{key} must not be empty")
                doc.set(key, None)
                continue
            check_props(idx, {key: raw}, it.id)
            doc.set(key, make_link(link_id(raw)) if links else raw)
        return doc.text()

    update_file(path, transform)
    if retitle:
        t.update_index(lambda i: None)
    return EXIT_OK


def author_name(args) -> str:
    return getattr(args, "author", None) or os.environ.get("BILINEAR_USER") or os.environ.get("USER") or "unknown"


def cmd_comment(t: Tracker, args) -> int:
    idx = t.read_index()
    it = t.require(idx, args.id)
    path = t.resolve(it)
    if path is None:
        raise UsageError(f"{args.id}: note missing")
    if not clean_title(args.text):
        raise UsageError("comment text must not be empty")
    author = author_name(args)
    date = today()
    update_file(path, lambda text: add_comment(text, date, author, args.text))
    return EXIT_OK


def cmd_move(t: Tracker, args) -> int:
    idx = t.read_index()
    where, anchor = "bottom", None
    if args.before:
        where, anchor = "before", args.before
    elif args.after:
        where, anchor = "after", args.after
    elif args.top:
        where = "top"
    for issue_id in filter(None, (args.id, anchor)):
        if t.require(idx, issue_id).archived:
            raise UsageError(f"{issue_id} is archived; only open issues can be reordered")
    if anchor == args.id:
        raise UsageError("an issue cannot be moved relative to itself")

    def commit(i: Index) -> None:
        if i.find(args.id) is None or (anchor and i.find(anchor) is None):
            raise UsageError("the index changed; issue no longer listed")
        i.move(args.id, where, anchor)

    t.update_index(commit)
    return EXIT_OK


def cmd_archive(t: Tracker, args) -> int:
    idx = t.read_index()
    if args.closed:
        if args.ids:
            raise UsageError("give either IDs or --closed")
        ids = []
        for it in idx.in_section(ISSUES):
            if issue_record(t, it)["status"] in idx.closed_states:
                ids.append(it.id)
    else:
        if not args.ids:
            raise UsageError("give one or more IDs, or --closed")
        ids = list(dict.fromkeys(args.ids))
        for issue_id in ids:
            t.require(idx, issue_id)
    todo = [i for i in ids if not idx.find(i).archived]
    for issue_id in todo:
        t.move_note(issue_id, True)

    def commit(i: Index) -> None:
        for issue_id in todo:
            if i.find(issue_id) is not None:
                i.move_to_section(issue_id, ARCHIVE)

    if todo:
        t.update_index(commit)
    for issue_id in todo:
        print(issue_id)
    return EXIT_OK


def cmd_unarchive(t: Tracker, args) -> int:
    idx = t.read_index()
    ids = list(dict.fromkeys(args.ids))
    for issue_id in ids:
        t.require(idx, issue_id)
    todo = [i for i in ids if idx.find(i).archived]
    for issue_id in todo:
        t.move_note(issue_id, False)

    def commit(i: Index) -> None:
        for issue_id in todo:
            if i.find(issue_id) is not None:
                i.move_to_section(issue_id, ISSUES)

    if todo:
        t.update_index(commit)
    for issue_id in todo:
        print(issue_id)
    return EXIT_OK


def cmd_rm(t: Tracker, args) -> int:
    idx = t.read_index()
    it = t.require(idx, args.id)
    paths = [t.path_in(it.id, where) for where in t.found(it.id)]
    if paths:
        vault = t.vault_root()
        if vault is None and not args.force:
            raise UsageError("no vault (.obsidian/) found above the tracker; use --force to delete the note for good")
        for p in paths:
            if vault is None:
                p.unlink()
                continue
            trash = vault / ".trash"
            trash.mkdir(exist_ok=True)
            dst = trash / p.name
            n = 2
            while dst.exists():
                dst = trash / f"{p.stem} {n}{p.suffix}"
                n += 1
            shutil.move(str(p), str(dst))
    t.update_index(lambda i: i.remove(it.id))
    return EXIT_OK


def cmd_adopt(t: Tracker, args) -> int:
    idx = t.read_index()
    if not ID_RE.match(args.id):
        raise UsageError(f"'{args.id}' is not an issue ID")
    if idx.find(args.id) is not None:
        raise UsageError(f"{args.id} is already in the index")
    here = t.found(args.id)
    if not here:
        raise UsageError(f"{args.id}: no such note in {ISSUES_DIR}/, {ARCHIVE_DIR}/ or the tracker folder")
    archived = here[0] == IN_ARCHIVE
    section = ARCHIVE if archived else ISSUES
    number = id_number(args.id, idx.prefix)
    # A note lying in the tracker folder goes to issues/ as it is adopted.
    t.move_note(args.id, archived)

    def commit(i: Index) -> None:
        if i.find(args.id) is None:
            i.add(args.id, "", section)
        if number is not None and (i.next or 1) <= number:
            i.set_next(number + 1)

    t.update_index(commit)
    return EXIT_OK


def cmd_label(t: Tracker, args) -> int:
    idx = t.read_index()
    if args.name is None:
        if args.color is not None:
            raise UsageError("--color needs a label name")
        colors = idx.label_colors
        names = idx.labels + [n for n in colors if n not in idx.labels]
        if args.json:
            print(json.dumps([{"name": n, "color": colors.get(n)} for n in names], indent=2, ensure_ascii=False))
        else:
            width = max((len(n) for n in names), default=0)
            for n in names:
                print(f"{n:<{width}}  {colors[n]}".rstrip() if n in colors else n)
        return EXIT_OK
    name = clean_title(args.name)
    if not name:
        raise UsageError("label name must not be empty")
    color = None
    if args.color is not None and args.color.lower() not in ("none", "auto"):
        color = normalize_color(args.color)
        if color is None:
            raise UsageError(f"unknown colour '{args.color}' (one of: {', '.join(COLOR_NAMES)}, #rgb, #rrggbb, or none)")

    def commit(i: Index) -> None:
        i.add_label(name)
        if args.color is not None:
            i.set_label_color(name, color)

    t.update_index(commit)
    return EXIT_OK


# --------------------------------------------------------------------------
# Lint


def check_note(idx: Index, issue_id: str, doc: Doc, add) -> None:
    for p in doc.problems():
        if p.endswith("unquoted wikilink"):
            add("warning", "note-yaml", issue_id, p)
        else:
            add("error", "note-yaml", issue_id, p)
    if not clean_title(doc.get_str("title")):
        add("error", "title-missing", issue_id, "title is missing")
    status = doc.get_str("status")
    if not status:
        add("error", "status-missing", issue_id, "status is missing")
    elif status not in idx.states:
        add("error", "status-unknown", issue_id, f"status '{status}' is not one of the tracker's states")
    priority = doc.get_str("priority")
    if priority is not None and priority not in PRIORITIES:
        add("error", "priority-invalid", issue_id, f"priority '{priority}' is not valid")
    for label in doc.get_list("labels"):
        if label not in idx.labels:
            add("warning", "label-unknown", issue_id, f"label '{label}' is not in the tracker's labels")
    for key in ("due", "created"):
        value = doc.get_str(key)
        if value is not None and not valid_date(value):
            add("error", f"{key}-invalid", issue_id, f"{key} '{value}' is not a YYYY-MM-DD date")
    refs = [("parent", v) for v in doc.get_list("parent")]
    refs += [("blocked-by", v) for v in doc.get_list("blocked-by")]
    for key, value in refs:
        target = link_id(value)
        if target is None or target == issue_id:
            add("error", f"{key}-invalid", issue_id, f"{key} '{value}' is not a link to another issue")
        elif idx.find(target) is None:
            add("error", f"{key}-unknown", issue_id, f"{key} {target} is not in the index")


def lint(t: Tracker, fix: bool) -> list[dict]:
    problems: list[dict] = []

    def add(severity, code, issue_id, message, fixable=False):
        problems.append({
            "severity": severity, "code": code, "id": issue_id, "message": message,
            "fixable": fixable, "fixed": False,
        })

    idx = Index(read_text(t.index_path))
    for p in idx.doc.problems():
        add("error", "index-yaml", None, p)
    for p in idx.key_problems():
        add("error", "index-key", None, p)
    for p in idx.label_color_problems():
        add("warning", "label-color-invalid", None, p)
    for other in index_notes(t.dir):
        if other != t.index_path:
            add("error", "multiple-trackers", None, f"{other.name} is also marked as a tracker index")
    if ISSUES not in idx.sections:
        add("warning", "missing-section", None, f"the index has no '## {ISSUES}' section")
    for name in idx.dup_sections:
        add("warning", "duplicate-section", None, f"more than one '## {name}' section; only the first is used")

    prefix = idx.prefix
    seen: dict[str, Item] = {}
    moves: list[tuple[str, bool]] = []
    for it in idx.items:
        if it.id in seen:
            add("warning", "duplicate-id", it.id, "listed more than once; the first line wins", True)
            continue
        seen[it.id] = it
        if not it.canonical:
            add("warning", "line-format", it.id, "index line is not in the form '- [[ID]] title'", True)
        if prefix and id_number(it.id, prefix) is None:
            add("warning", "prefix-mismatch", it.id, f"ID does not use the tracker prefix {prefix}")
        here = t.found(it.id)
        if not here:
            add("error", "note-missing", it.id, "note missing")
            continue
        if len(here) > 1:
            add("error", "note-duplicate", it.id, f"note exists in more than one place ({describe(here)})")
        elif here[0] != place(it.archived):
            section = f"## {ARCHIVE}" if it.archived else f"## {ISSUES}"
            add("warning", "wrong-location", it.id,
                f"listed under {section} but the note is in {describe(here[0])}, not {describe(place(it.archived))}", True)
            moves.append((it.id, it.archived))
        doc = Doc(read_text(t.resolve(it)))
        check_note(idx, it.id, doc, add)
        title = clean_title(doc.get_str("title"))
        if title and title != it.title:
            add("warning", "title-mismatch", it.id, "index line title differs from the title property", True)

    highest = idx.highest()
    for where in LOCATIONS:
        for issue_id in t.note_ids(where):
            number = id_number(issue_id, prefix)
            if number is None:
                continue
            highest = max(highest, number)
            if issue_id not in seen:
                path = t.path_in(issue_id, where).relative_to(t.dir).as_posix()
                add("warning", "orphan", issue_id, f"{path} has no index line (use 'adopt' to add it)")
    if idx.next is not None and idx.next <= highest:
        add("warning", "next-low", None, f"next is {idx.next} but {prefix}-{highest} exists", True)

    if not fix or idx.doc.broken:
        return problems

    for issue_id, to_archive in moves:
        t.move_note(issue_id, to_archive)

    def repair(i: Index) -> None:
        first: set[str] = set()
        dup_lines = []
        for it in i.items:
            if it.id in first:
                dup_lines.append(it.line)
            first.add(it.id)
        for line in sorted(dup_lines, reverse=True):
            del i.lines[line]
        i.scan()
        for it in list(i.items):
            if not it.canonical:
                i.rewrite(i.find(it.id), it.title)
        if i.next is not None and i.next <= highest:
            i.set_next(highest + 1)

    t.update_index(repair)
    for p in problems:
        if p["fixable"]:
            p["fixed"] = True
    return problems


def cmd_lint(t: Tracker, args) -> int:
    problems = lint(t, args.fix)
    remaining = [p for p in problems if not p["fixed"]]
    if args.json:
        print(json.dumps({"problems": problems}, indent=2, ensure_ascii=False))
    else:
        for p in problems:
            where = p["id"] or t.index_path.name
            tag = "fixed" if p["fixed"] else p["severity"]
            print(f"{tag}: {where}: {p['message']} [{p['code']}]")
        if not problems:
            print("no problems found")
    return EXIT_LINT if remaining else EXIT_OK


# --------------------------------------------------------------------------
# Entry point


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: error: {message}\n")


def build_parser() -> Parser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--tracker", metavar="PATH", default=argparse.SUPPRESS,
                        help="tracker folder or index note (default: $BILINEAR_TRACKER, then search upward)")
    common.add_argument("--author", default=argparse.SUPPRESS,
                        help="author for comments (default: $BILINEAR_USER, then $USER)")

    p = Parser(prog="bilinear", description="Issue tracker stored as Markdown notes in an Obsidian vault.",
               parents=[common])
    p.add_argument("--version", action="version", version=f"bilinear {VERSION}")
    sub = p.add_subparsers(dest="command", metavar="command")

    def cmd(name, help_text, func, needs_tracker=True, writes=True):
        sp = sub.add_parser(name, help=help_text, description=help_text, parents=[common])
        sp.set_defaults(func=func, needs_tracker=needs_tracker, writes=writes)
        return sp

    sp = cmd("init", "create a tracker folder, its index note, issues/ and archive/", cmd_init, needs_tracker=False)
    sp.add_argument("folder")
    sp.add_argument("--prefix", required=True, help="ID prefix, e.g. RB")

    sp = cmd("new", "create an issue and print its ID", cmd_new)
    sp.add_argument("title")
    sp.add_argument("--status")
    sp.add_argument("--priority")
    sp.add_argument("--label", action="append", metavar="LABEL", help="repeatable or comma-separated")
    sp.add_argument("--assignee")
    sp.add_argument("--due", metavar="YYYY-MM-DD")
    sp.add_argument("--parent", metavar="ID")
    sp.add_argument("--top", action="store_true", help="insert at the top of the list instead of the end")
    sp.add_argument("--json", action="store_true")

    sp = cmd("list", "list issues in index order", cmd_list, writes=False)
    sp.add_argument("--status", action="append")
    sp.add_argument("--label", action="append")
    sp.add_argument("--assignee", action="append")
    sp.add_argument("--priority", action="append")
    sp.add_argument("--archived", action="store_true", help="list archived issues instead of open ones")
    sp.add_argument("--all", action="store_true", help="list both open and archived issues")
    sp.add_argument("--json", action="store_true")

    sp = cmd("show", "print an issue's properties and body", cmd_show, writes=False)
    sp.add_argument("id")
    sp.add_argument("--json", action="store_true")

    sp = cmd("set", "change properties: key=value, list+=value, list-=value, key= to remove", cmd_set)
    sp.add_argument("id")
    sp.add_argument("assignments", nargs="+", metavar="key=value")

    sp = cmd("comment", "append a comment", cmd_comment)
    sp.add_argument("id")
    sp.add_argument("text")

    sp = cmd("move", "reorder an issue", cmd_move)
    sp.add_argument("id")
    g = sp.add_mutually_exclusive_group(required=True)
    g.add_argument("--before", metavar="ID")
    g.add_argument("--after", metavar="ID")
    g.add_argument("--top", action="store_true")
    g.add_argument("--bottom", action="store_true")

    sp = cmd("archive", "archive the named issues, or all closed ones", cmd_archive)
    sp.add_argument("ids", nargs="*", metavar="ID")
    sp.add_argument("--closed", action="store_true")

    sp = cmd("unarchive", "restore archived issues", cmd_unarchive)
    sp.add_argument("ids", nargs="+", metavar="ID")

    sp = cmd("rm", "remove an issue; its note goes to the vault's .trash/", cmd_rm)
    sp.add_argument("id")
    sp.add_argument("--force", action="store_true", help="delete the note when no vault is found")

    sp = cmd("adopt", "add an index line for an orphan note", cmd_adopt)
    sp.add_argument("id")

    sp = cmd("label", "list the labels, or add one and set its colour", cmd_label)
    sp.add_argument("name", nargs="?")
    sp.add_argument("--color", metavar="COLOR", help=f"{', '.join(COLOR_NAMES)}, #rgb or #rrggbb; 'none' clears it")
    sp.add_argument("--json", action="store_true")

    sp = cmd("lint", "check consistency; --fix repairs what is safe to repair", cmd_lint)
    sp.add_argument("--fix", action="store_true")
    sp.add_argument("--json", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help(sys.stderr)
        return EXIT_USAGE
    try:
        if not args.needs_tracker:
            return args.func(args)
        tracker = Tracker.open(getattr(args, "tracker", None) or os.environ.get("BILINEAR_TRACKER"))
        # Reads need no lock: every write is an atomic replace. `lint` only
        # writes with --fix.
        if not args.writes or (args.command == "lint" and not args.fix) or (args.command == "label" and not args.name):
            return args.func(tracker, args)
        with TrackerLock(tracker.dir):
            return args.func(tracker, args)
    except UsageError as e:
        warn(str(e))
        return EXIT_USAGE
    except ConflictError as e:
        warn(str(e))
        return EXIT_CONFLICT
    except BrokenPipeError:
        return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
