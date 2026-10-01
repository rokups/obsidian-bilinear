"""The YAML subset parser and the line-preserving frontmatter editor."""

import unittest

from fixture_runner import bilinear
from bilinear import Doc, format_scalar, parse_flow_list, parse_scalar


class ScalarTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(("in-progress", None), parse_scalar("in-progress"))
        self.assertEqual(("2026-10-10", None), parse_scalar(" 2026-10-10  "))
        self.assertEqual((None, None), parse_scalar(""))
        self.assertEqual((None, None), parse_scalar("null"))
        self.assertEqual(("Fix", None), parse_scalar("Fix #3 is a comment"))

    def test_quoted(self):
        self.assertEqual(("a: b", None), parse_scalar('"a: b"'))
        self.assertEqual(('say "hi"\n', None), parse_scalar(r'"say \"hi\"\n"'))
        self.assertEqual(("it's", None), parse_scalar("'it''s'"))
        self.assertEqual(("", None), parse_scalar('""'))
        self.assertEqual(("x", None), parse_scalar('"x" # note'))
        self.assertEqual(("éA", None), parse_scalar(r'"é\x41"'))

    def test_outside_subset(self):
        for raw in ('"open', "'open", '"a" b', "&anchor x", "*alias", "| ", ">-", "{a: 1}", "!tag x", "a: b"):
            with self.subTest(raw=raw):
                self.assertIsNotNone(parse_scalar(raw)[1])
        self.assertEqual(("[[BL-9]]", "unquoted wikilink"), parse_scalar("[[BL-9]]"))

    def test_format_round_trips(self):
        values = [
            "plain", "in-progress", "2026-10-10", "", " padded ", "a: b", "a #b", "ends:", "[[BL-9]]", "-dash",
            "123", "1.5", "true", "No", "null", "~", 'say "hi"', "back\\slash", "tab\there", "line\nbreak",
            "it's", "@rk", "#tag", "é ü", "a,b", "100%", "x: ", "? what",
        ]
        for v in values:
            with self.subTest(value=v):
                self.assertEqual((v, None), parse_scalar(format_scalar(v)))
                self.assertEqual(([v, "z"], None), parse_flow_list(f"[{format_scalar(v, flow=True)}, z]"))

    def test_format_quotes_only_when_needed(self):
        self.assertEqual("Fix flaky cache test", format_scalar("Fix flaky cache test"))
        self.assertEqual("it's", format_scalar("it's"))
        self.assertEqual('"[[BL-9]]"', format_scalar("[[BL-9]]"))
        self.assertEqual('"a, b"', format_scalar("a, b", flow=True))
        self.assertEqual("a, b", format_scalar("a, b"))

    def test_flow_list(self):
        self.assertEqual(([], None), parse_flow_list("[]"))
        self.assertEqual(([], None), parse_flow_list("[  ]"))
        self.assertEqual((["a", "b c", "d, e"], None), parse_flow_list('[a, b c , "d, e"]'))
        self.assertEqual((["[[BL-3]]", "x]"], None), parse_flow_list("""["[[BL-3]]", 'x]']"""))
        self.assertEqual(["[[BL-3]]", "[[BL-4]]"], parse_flow_list("[[[BL-3]], [[BL-4]]]")[0])
        self.assertIsNotNone(parse_flow_list("[[[BL-3]], [[BL-4]]]")[1])
        self.assertIsNotNone(parse_flow_list("[a, b")[1])
        self.assertIsNotNone(parse_flow_list("[a, {b: 1}]")[1])


NOTE = """---
title: "Fix: it"
status: todo
labels:
  - build
  - "bug"
tags: [a, b]
empty:
# a comment

parent: "[[BL-9]]"
---
Body
"""


class DocTest(unittest.TestCase):
    def test_parse(self):
        d = Doc(NOTE)
        self.assertEqual("Fix: it", d.get("title"))
        self.assertEqual(["build", "bug"], d.get("labels"))
        self.assertEqual(["a", "b"], d.get("tags"))
        self.assertIsNone(d.get("empty"))
        self.assertEqual([], d.get_list("empty"))
        self.assertEqual("[[BL-9]]", d.get_str("parent"))
        self.assertEqual(["title", "status", "labels", "tags", "empty", "parent"], d.keys())
        self.assertEqual("Body\n", d.body)
        self.assertEqual([], d.problems())
        self.assertEqual(NOTE, d.text())

    def test_no_frontmatter(self):
        for text in ("", "Body only\n", "--- not a fence\n", "text\n---\nkey: v\n---\n"):
            with self.subTest(text=text):
                d = Doc(text)
                self.assertFalse(d.has_fm)
                self.assertEqual(text, d.text())
        d = Doc("Body\n")
        d.set("status", "todo")
        self.assertEqual("---\nstatus: todo\n---\nBody\n", d.text())

    def test_unterminated_is_never_written(self):
        d = Doc("---\ntitle: x\nbody without end\n")
        self.assertTrue(d.broken)
        self.assertEqual(["frontmatter is not terminated"], d.problems())
        with self.assertRaises(bilinear.UsageError):
            d.set("title", "y")

    def test_set_touches_only_that_key(self):
        d = Doc(NOTE)
        d.set("status", "done")
        self.assertEqual(NOTE.replace("status: todo", "status: done"), d.text())

    def test_set_equal_value_keeps_formatting(self):
        d = Doc(NOTE)
        d.set("title", "Fix: it")
        d.set("labels", ["build", "bug"])
        self.assertEqual(NOTE, d.text())

    def test_set_list_keeps_style(self):
        d = Doc(NOTE)
        d.set("labels", ["ui"])
        d.set("tags", ["a, b", "c"])
        text = d.text()
        self.assertIn("labels:\n  - ui\ntags: [\"a, b\", c]\n", text)
        d.set("labels", [])
        self.assertIn("labels: []\n", d.text())

    def test_block_list_without_indent(self):
        d = Doc("---\ntags:\n- a\n- b\n---\n")
        self.assertEqual(["a", "b"], d.get("tags"))
        d.set("tags", ["a", "b", "c"])
        self.assertEqual("---\ntags:\n- a\n- b\n- c\n---\n", d.text())

    def test_remove_and_append(self):
        d = Doc(NOTE)
        d.set("labels", None)
        d.set("assignee", "rk")
        text = d.text()
        self.assertNotIn("build", text)
        self.assertTrue(text.endswith('parent: "[[BL-9]]"\nassignee: rk\n---\nBody\n'))

    def test_crlf_and_missing_final_newline(self):
        text = "---\r\ntitle: x\r\n---"
        d = Doc(text)
        self.assertEqual(text, d.text())
        d.set("status", "todo")
        self.assertEqual("---\r\ntitle: x\r\nstatus: todo\r\n---", d.text())

    def test_bom_is_kept(self):
        text = "﻿---\ntitle: x\n---\n"
        d = Doc(text)
        self.assertEqual("x", d.get("title"))
        self.assertEqual(text, d.text())

    def test_outside_subset_is_reported_and_kept(self):
        text = "---\nmeta:\n  owner: rk\ntext: |\n  one\n  two\n? odd\ntitle: x\ntitle: y\n---\n"
        d = Doc(text)
        self.assertEqual(4, len(d.problems()))
        self.assertEqual("x", d.get("title"))
        d.set("status", "todo")
        self.assertEqual(text.replace("title: y\n", "title: y\nstatus: todo\n"), d.text())


if __name__ == "__main__":
    unittest.main()
