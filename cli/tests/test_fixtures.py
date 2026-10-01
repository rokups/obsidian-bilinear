"""Shared fixtures: every operation and every consistency rule, byte for byte."""

import json
import tempfile
import unittest
from pathlib import Path

import fixture_runner
from fixture_runner import bilinear


class FixtureTest(unittest.TestCase):
    maxDiff = None

    def test_cases_exist(self):
        self.assertGreater(len(fixture_runner.cases()), 40)

    def test_operations(self):
        for case in fixture_runner.cases():
            with self.subTest(case=case.name), tempfile.TemporaryDirectory() as tmp:
                op = json.loads((case / "op.json").read_text())
                tracker, result = fixture_runner.run(case, Path(tmp))
                expected = fixture_runner.snapshot(case / "after")
                actual = fixture_runner.snapshot(tracker)
                self.assertEqual(sorted(expected), sorted(actual))
                for name in expected:
                    self.assertEqual(expected[name].decode(), actual[name].decode(), name)
                expect = op.get("expect", {})
                if "id" in expect:
                    self.assertEqual(expect["id"], result["id"])
                if "problems" in expect:
                    self.assertEqual(expect["problems"], result["problems"])
                    self.assertEqual(2 if result_has_open_problems(case, result) else 0, result["exit"])
                for key in ("labels", "states"):
                    if key in expect:
                        self.assertEqual(expect[key], result[key])
                if "issues" in expect:
                    self.assertEqual([e["id"] for e in expect["issues"]], [i["id"] for i in result["issues"]])
                    for want, got in zip(expect["issues"], result["issues"]):
                        for key, value in want.items():
                            self.assertEqual(value, got[key], f"{want['id']}.{key}")

    def test_round_trip(self):
        """Parse then serialize is the identity on every fixture file."""
        count = 0
        for path in sorted(fixture_runner.FIXTURES.rglob("*.md")):
            with self.subTest(file=str(path.relative_to(fixture_runner.FIXTURES))):
                text = path.read_bytes().decode("utf-8")
                self.assertEqual(text, bilinear.Doc(text).text())
                self.assertEqual(text, bilinear.Index(text).text())
                self.assertEqual(text, "".join(bilinear.split_lines(text)))
                count += 1
        self.assertGreater(count, 200)


def result_has_open_problems(case: Path, result: dict) -> bool:
    """With --fix, only problems that cannot be fixed keep the exit code at 2."""
    op = json.loads((case / "op.json").read_text())
    fixable = {"duplicate-id", "line-format", "wrong-location", "title-mismatch", "next-low"}
    codes = [p.split(":")[0] for p in result["problems"]]
    if op["args"].get("fix"):
        codes = [c for c in codes if c not in fixable]
    return bool(codes)


if __name__ == "__main__":
    unittest.main()
