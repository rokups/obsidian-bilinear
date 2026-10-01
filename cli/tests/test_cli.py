"""CLI behaviour that the shared fixtures do not cover."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from fixture_runner import bilinear


class CliCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.vault = Path(tmp.name).resolve() / "vault"
        (self.vault / ".obsidian").mkdir(parents=True)
        self.dir = self.vault / "Trackers" / "Bilinear"
        self.index = self.dir / "Bilinear.md"
        saved = dict(os.environ)
        cwd = os.getcwd()
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved), os.chdir(cwd)))
        self.addCleanup(setattr, bilinear, "_before_write_hook", None)
        for key in ("BILINEAR_TRACKER", "BILINEAR_USER"):
            os.environ.pop(key, None)
        os.environ["BILINEAR_TODAY"] = "2026-10-01"
        os.environ["USER"] = "rk"
        self.assertEqual((0, str(self.index) + "\n"), self.run_cli("init", str(self.dir), "--prefix", "BL")[:2])
        os.chdir(self.dir)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = bilinear.main(list(argv))
            except SystemExit as e:
                code = e.code
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        code, out, err = self.run_cli(*argv)
        self.assertEqual(0, code, err)
        return out

    def entries(self):
        """Files under the tracker folder, apart from the lock file used on Windows."""
        return sorted(p.relative_to(self.dir).as_posix() for p in self.dir.rglob("*")
                      if p.is_file() and p.name != bilinear.LOCK_FILE)

    def ids(self, *argv):
        return [i["id"] for i in json.loads(self.ok("list", "--json", *argv))]


class InitTest(CliCase):
    def test_layout(self):
        self.assertTrue((self.dir / "issues").is_dir())
        self.assertTrue((self.dir / "archive").is_dir())
        text = self.index.read_text()
        self.assertTrue(text.startswith("---\nbilinear: tracker\nprefix: BL\nnext: 1\n"))
        self.assertIn("## Issues\n\n## Archive\n", text)
        self.assertEqual((0, "no problems found\n"), self.run_cli("lint")[:2])

    def test_refuses_existing_tracker_and_bad_prefix(self):
        self.assertEqual(1, self.run_cli("init", str(self.dir), "--prefix", "BL")[0])
        self.assertEqual(1, self.run_cli("init", str(self.vault / "X"), "--prefix", "bl")[0])
        self.assertFalse((self.vault / "X").exists())


class DiscoveryTest(CliCase):
    def test_upward_search_env_and_flag(self):
        self.ok("new", "One")
        sub = self.dir / "archive"
        os.chdir(sub)
        self.assertEqual(["BL-1"], self.ids())
        os.chdir(self.vault)
        self.assertEqual(1, self.run_cli("list")[0])
        self.assertEqual(["BL-1"], self.ids("--tracker", str(self.dir)))
        self.assertEqual(["BL-1"], self.ids("--tracker", str(self.index)))
        os.environ["BILINEAR_TRACKER"] = str(self.dir)
        self.assertEqual(["BL-1"], self.ids())
        code, out, _ = self.run_cli("--tracker", str(self.index), "list", "--json")
        self.assertEqual(0, code)
        self.assertEqual(1, self.run_cli("--tracker", str(self.vault), "list")[0])

    def test_index_note_is_found_by_frontmatter_not_name(self):
        self.index.rename(self.dir / "Board.md")
        self.assertEqual("BL-1\n", self.ok("new", "One"))


class AllocationTest(CliCase):
    def test_sequential(self):
        self.assertEqual(["BL-1\n", "BL-2\n"], [self.ok("new", "A"), self.ok("new", "B")])
        self.assertIn("next: 3\n", self.index.read_text())

    def test_skips_numbers_seen_in_index_folder_and_archive(self):
        self.ok("new", "A")
        (self.dir / "issues" / "BL-7.md").write_text("---\ntitle: stray\n---\n")
        self.assertEqual("BL-8\n", self.ok("new", "B"))
        (self.dir / "archive" / "BL-12.md").write_text("---\ntitle: stray\n---\n")
        self.assertEqual("BL-13\n", self.ok("new", "C"))
        text = self.index.read_text().replace("next: 14", "next: 2")
        self.index.write_text(text.replace("- [[BL-13]] C", "- [[BL-13]] C\n- [[BL-30]] line without a note"))
        self.assertEqual("BL-31\n", self.ok("new", "D"))
        self.assertIn("next: 32\n", self.index.read_text())
        self.assertEqual("---\ntitle: stray\n---\n", (self.dir / "issues" / "BL-7.md").read_text())

    def test_exclusive_create_retries_on_collision(self):
        real_ids = bilinear.Tracker.note_ids
        calls = []

        def racing(tracker, archived):
            found = real_ids(tracker, archived)
            if not calls:  # another writer takes BL-1 and BL-2 after we looked
                calls.append(1)
                (self.dir / "issues" / "BL-1.md").write_text("theirs")
                (self.dir / "archive" / "BL-2.md").write_text("theirs")
            return found

        bilinear.Tracker.note_ids = racing
        self.addCleanup(setattr, bilinear.Tracker, "note_ids", real_ids)
        self.assertEqual("BL-3\n", self.ok("new", "Mine"))
        self.assertEqual("theirs", (self.dir / "issues" / "BL-1.md").read_text())
        self.assertIn("next: 4\n", self.index.read_text())

    def test_numbers_in_the_tracker_folder_itself_count(self):
        (self.dir / "BL-40.md").write_text("---\ntitle: old layout\n---\n")
        self.assertEqual("BL-41\n", self.ok("new", "A"))
        self.assertTrue((self.dir / "issues" / "BL-41.md").is_file())

    def test_issues_folder_is_created_on_demand(self):
        (self.dir / "issues").rmdir()
        self.assertEqual("BL-1\n", self.ok("new", "A"))
        self.assertTrue((self.dir / "issues" / "BL-1.md").is_file())

    def test_other_prefixes_do_not_count(self):
        (self.dir / "issues" / "XY-50.md").write_text("---\ntitle: other\n---\n")
        self.assertEqual("BL-1\n", self.ok("new", "A"))


class ConflictTest(CliCase):
    def test_retry_redoes_the_operation_on_fresh_content(self):
        self.ok("new", "A")
        hits = []

        def hook(path):
            if path == self.index and not hits:
                hits.append(1)
                path.write_text(path.read_text().replace("\n## Issues\n", "\nEdited meanwhile.\n\n## Issues\n"))

        bilinear._before_write_hook = hook
        self.assertEqual("BL-2\n", self.ok("new", "B"))
        text = self.index.read_text()
        self.assertIn("Edited meanwhile.", text)
        self.assertIn("- [[BL-1]] A\n- [[BL-2]] B\n", text)
        self.assertIn("next: 3\n", text)

    def test_gives_up_with_exit_code_3(self):
        self.ok("new", "A")
        before = (self.dir / "issues" / "BL-1.md").read_text()
        count = []

        def hook(path):
            count.append(1)
            with open(path, "a") as f:
                f.write("x")

        bilinear._before_write_hook = hook
        code, _, err = self.run_cli("set", "BL-1", "status=todo")
        self.assertEqual(3, code)
        self.assertEqual(3, len(count))
        self.assertIn("kept changing", err)
        self.assertEqual(before + "xxx", (self.dir / "issues" / "BL-1.md").read_text())

    def test_no_temp_files_left_behind(self):
        self.ok("new", "A")
        self.ok("set", "BL-1", "status=todo")
        self.assertEqual(["Bilinear.md", "issues/BL-1.md"], self.entries())


class LockTest(CliCase):
    """Writers from several CLI processes are serialized by a per-tracker lock."""

    def setUp(self):
        super().setUp()
        self.ok("new", "A")
        os.environ["BILINEAR_LOCK_TIMEOUT"] = "0.2"

    def test_writers_wait_and_give_up_with_exit_code_3(self):
        before = self.index.read_bytes()
        with bilinear.TrackerLock(self.dir):
            for argv in (["new", "B"], ["set", "BL-1", "status=todo"], ["comment", "BL-1", "x"], ["move", "BL-1", "--top"],
                         ["archive", "BL-1"], ["rm", "BL-1"], ["lint", "--fix"]):
                with self.subTest(argv=argv):
                    code, _, err = self.run_cli(*argv)
                    self.assertEqual(3, code)
                    self.assertIn("locked by another bilinear process", err)
            self.assertEqual(before, self.index.read_bytes())
            self.assertEqual(["Bilinear.md", "issues/BL-1.md"], self.entries())
        self.assertEqual("BL-2\n", self.ok("new", "B"))

    def test_readers_do_not_wait(self):
        with bilinear.TrackerLock(self.dir):
            self.assertEqual(["BL-1"], self.ids())
            self.assertIn("BL-1  A", self.ok("show", "BL-1"))
            self.assertEqual(0, self.run_cli("lint")[0])

    def test_lock_is_released_after_a_failed_command(self):
        self.assertEqual(1, self.run_cli("set", "BL-1", "status=nope")[0])
        self.assertEqual(1, self.run_cli("set", "BL-99", "status=todo")[0])
        self.ok("set", "BL-1", "status=todo")

    def test_a_waiting_writer_proceeds_once_the_lock_is_free(self):
        import threading
        os.environ["BILINEAR_LOCK_TIMEOUT"] = "5"
        lock = bilinear.TrackerLock(self.dir)
        lock.__enter__()
        threading.Timer(0.3, lambda: lock.__exit__(None, None, None)).start()
        self.assertEqual("BL-2\n", self.ok("new", "B"))

    @unittest.skipIf(bilinear.fcntl is None, "the folder itself is only locked on POSIX")
    def test_no_lock_file_is_left_in_the_vault(self):
        self.ok("new", "B")
        self.assertEqual(["Bilinear.md", "issues/BL-1.md", "issues/BL-2.md"], self.entries())

    def test_concurrent_processes_lose_nothing(self):
        import subprocess
        import sys
        cli = str(Path(bilinear.__file__).resolve())
        procs, per = 6, 4
        worker = (
            "import subprocess, sys\n"
            f"for i in range({per}):\n"
            "    for argv in (['new', f'w{sys.argv[1]}-{i}'], ['comment', 'BL-1', f'w{sys.argv[1]}-{i}'],\n"
            "                 ['set', 'BL-1', f'k{sys.argv[1]}x{i}=1']):\n"
            f"        r = subprocess.run([sys.executable, {cli!r}, '--tracker', {str(self.dir)!r}, *argv], capture_output=True, text=True)\n"
            "        if r.returncode: print(r.returncode, argv, r.stderr)\n"
        )
        env = {**os.environ, "BILINEAR_LOCK_TIMEOUT": "60", "BILINEAR_USER": "w"}
        running = [subprocess.Popen([sys.executable, "-c", worker, str(n)], stdout=subprocess.PIPE, text=True, env=env) for n in range(procs)]
        self.assertEqual("", "".join(p.communicate()[0] for p in running))
        total = procs * per
        issues = json.loads(self.ok("list", "--json"))
        self.assertEqual(total + 1, len(issues))
        self.assertEqual(total + 1, len({i["id"] for i in issues}))
        self.assertEqual(sorted(f"w{n}-{i}" for n in range(procs) for i in range(per)), sorted(i["title"] for i in issues[1:]))
        note = (self.dir / "issues" / "BL-1.md").read_text()
        self.assertEqual(total, note.count("- 2026-10-01 w: w"))
        self.assertEqual(total, sum(1 for line in note.splitlines() if line.startswith("k")))
        self.assertIn(f"next: {total + 2}\n", self.index.read_text())
        self.assertEqual((0, "no problems found\n"), self.run_cli("lint")[:2])
        self.assertEqual(total + 2, len(self.entries()))


class LegacyLayoutTest(CliCase):
    """Trackers made before issues/ existed keep their open notes in the tracker folder."""

    def setUp(self):
        super().setUp()
        self.ok("new", "A")
        self.ok("new", "B", "--status", "done")
        for name in ("BL-1.md", "BL-2.md"):
            (self.dir / "issues" / name).rename(self.dir / name)
        (self.dir / "issues").rmdir()

    def test_everything_works_in_place(self):
        self.assertEqual(["BL-1", "BL-2"], self.ids())
        self.assertFalse(json.loads(self.ok("list", "--json"))[0]["missing"])
        self.ok("set", "BL-1", "status=todo")
        self.ok("comment", "BL-1", "still here")
        self.assertIn("status: todo", (self.dir / "BL-1.md").read_text())
        self.assertEqual(["BL-1.md", "BL-2.md", "Bilinear.md"], self.entries())

    def test_lint_fix_moves_notes_into_issues(self):
        code, out, _ = self.run_cli("lint")
        self.assertEqual(2, code)
        self.assertEqual(2, out.count("[wrong-location]"))
        self.assertIn("the note is in the tracker folder, not issues/", out)
        self.assertEqual(0, self.run_cli("lint", "--fix")[0])
        self.assertEqual(["Bilinear.md", "issues/BL-1.md", "issues/BL-2.md"], self.entries())
        self.assertEqual((0, "no problems found\n"), self.run_cli("lint")[:2])

    def test_archive_unarchive_and_new_use_the_new_layout(self):
        self.ok("archive", "--closed")
        self.ok("unarchive", "BL-2")
        self.assertEqual("BL-3\n", self.ok("new", "C"))
        self.assertEqual(["BL-1.md", "Bilinear.md", "issues/BL-2.md", "issues/BL-3.md"], self.entries())

    def test_rm_and_duplicates(self):
        (self.dir / "archive" / "BL-1.md").write_text("copy")
        code, out, _ = self.run_cli("lint")
        self.assertIn("note exists in more than one place (archive/, the tracker folder) [note-duplicate]", out)
        self.assertEqual(1, self.run_cli("archive", "BL-1")[0])
        self.ok("rm", "BL-1")
        self.assertEqual(["BL-2.md", "Bilinear.md"], self.entries())
        self.assertEqual(["BL-1 2.md", "BL-1.md"], sorted(p.name for p in (self.vault / ".trash").iterdir()))


class LabelTest(CliCase):
    def test_add_colour_list_and_clear(self):
        self.assertEqual("", self.ok("label"))
        self.ok("label", "bug", "--color", "RED")
        self.ok("label", "ui")
        self.ok("label", "perf", "--color", "#0af")
        text = self.index.read_text()
        self.assertIn("labels: [bug, ui, perf]\n", text)
        self.assertIn("label-colors: [bug=red, perf=#0af]\n", text)
        self.assertEqual("bug   red\nui\nperf  #0af\n", self.ok("label"))
        self.assertEqual([{"name": "bug", "color": "red"}, {"name": "ui", "color": None}, {"name": "perf", "color": "#0af"}],
                         json.loads(self.ok("label", "--json")))
        self.ok("label", "bug", "--color", "none")
        self.ok("label", "perf", "--color", "auto")
        self.assertNotIn("label-colors", self.index.read_text())
        self.assertIn("labels: [bug, ui, perf]\n", self.index.read_text())
        self.assertEqual((0, "no problems found\n"), self.run_cli("lint")[:2])

    def test_refuses_bad_colours(self):
        before = self.index.read_bytes()
        for argv in (["bug", "--color", "mauve"], ["bug", "--color", "#12"], ["  ", "--color", "red"], ["--color", "red"]):
            with self.subTest(argv=argv):
                self.assertEqual(1, self.run_cli("label", *argv)[0])
        self.assertEqual(before, self.index.read_bytes())

    def test_known_labels_stop_the_warning(self):
        self.assertIn("label 'bug'", self.run_cli("new", "A", "--label", "bug")[2])
        self.ok("label", "bug", "--color", "red")
        self.assertEqual("", self.run_cli("new", "B", "--label", "bug")[2])


class StateTest(CliCase):
    def test_set_list_and_clear(self):
        self.ok("state", "in-review", "--icon", "lucide-eye", "--color", "Purple")
        self.ok("state", "done", "--color", "#2da44e")
        self.ok("state", "backlog", "--icon", "dashed")
        text = self.index.read_text()
        self.assertIn("state-icons: [in-review=eye, backlog=dashed]\n", text)
        self.assertIn("state-colors: [in-review=purple, done=#2da44e]\n", text)
        self.assertEqual(
            "backlog      icon=dashed\ntodo\nin-progress\nin-review    icon=eye  color=purple\n"
            "done         color=#2da44e  (closed)\ncanceled     (closed)\n", self.ok("state"))
        rows = json.loads(self.ok("state", "--json"))
        self.assertEqual({"name": "in-review", "icon": "eye", "color": "purple", "closed": False}, rows[3])
        self.ok("state", "in-review", "--icon", "none")
        self.ok("state", "in-review", "--color", "auto")
        self.ok("state", "done", "--color", "none")
        self.ok("state", "backlog", "--icon", "none")
        self.assertNotIn("state-", self.index.read_text())
        self.assertEqual((0, "no problems found\n"), self.run_cli("lint")[:2])

    def test_refuses_unknown_states_and_bad_values(self):
        before = self.index.read_bytes()
        for argv in (["nope", "--icon", "check"], ["done"], ["done", "--icon", "two words"], ["done", "--color", "mauve"],
                     ["--icon", "check"]):
            with self.subTest(argv=argv):
                self.assertEqual(1, self.run_cli("state", *argv)[0])
        self.assertEqual(before, self.index.read_bytes())

    def test_lint_reports_unusable_entries(self):
        self.index.write_text(self.index.read_text().replace("labels: []", "labels: []\nstate-icons: [gone=check]\nstate-colors: [done=mauve]"))
        code, out, _ = self.run_cli("lint")
        self.assertEqual(2, code)
        self.assertIn("state-icons names 'gone', which is not one of the states [state-style-invalid]", out)
        self.assertIn("state-colors entry 'done=mauve' is not of the form name=color [state-style-invalid]", out)


class CommandTest(CliCase):
    def setUp(self):
        super().setUp()
        self.index.write_text(self.index.read_text().replace("labels: []", "labels: [bug, ui]"))
        self.ok("new", "Alpha", "--priority", "high", "--label", "bug", "--assignee", "rk")
        self.ok("new", "Beta", "--status", "done", "--parent", "BL-1")
        self.ok("new", "Gamma", "--label", "ui,bug", "--due", "2026-10-10")

    def test_new_validates(self):
        for argv in (["--status", "nope"], ["--priority", "p0"], ["--due", "tomorrow"], ["--parent", "BL-99"]):
            with self.subTest(argv=argv):
                self.assertEqual(1, self.run_cli("new", "X", *argv)[0])
        self.assertEqual(1, self.run_cli("new", "  ")[0])
        self.assertEqual(["BL-1", "BL-2", "BL-3"], self.ids())
        self.assertEqual(["BL-1.md", "BL-2.md", "BL-3.md"], sorted(p.name for p in (self.dir / "issues").glob("BL-*.md")))
        code, out, err = self.run_cli("new", "X", "--label", "odd")
        self.assertEqual((0, "BL-4\n"), (code, out))
        self.assertIn("label 'odd'", err)

    def test_new_json(self):
        data = json.loads(self.ok("new", "X", "--json"))
        self.assertEqual("BL-4", data["id"])
        self.assertEqual(str(self.dir / "issues" / "BL-4.md"), data["path"])

    def test_list_filters(self):
        self.assertEqual(["BL-2"], self.ids("--status", "done"))
        self.assertEqual(["BL-1", "BL-3"], self.ids("--status", "backlog,todo"))
        self.assertEqual(["BL-1", "BL-3"], self.ids("--label", "bug"))
        self.assertEqual(["BL-3"], self.ids("--label", "ui"))
        self.assertEqual(["BL-1"], self.ids("--assignee", "rk"))
        self.assertEqual(["BL-1"], self.ids("--priority", "high", "--priority", "urgent"))
        self.ok("archive", "BL-2")
        self.assertEqual(["BL-1", "BL-3"], self.ids())
        self.assertEqual(["BL-2"], self.ids("--archived"))
        self.assertEqual(["BL-1", "BL-3", "BL-2"], self.ids("--all"))

    def test_list_text(self):
        out = self.ok("list")
        self.assertEqual(
            "BL-1  backlog  high  Alpha  [1/1]  @rk  #bug\n"
            "BL-2  done     none  Beta\n"
            "BL-3  backlog  none  Gamma  #ui #bug\n", out)

    def test_progress_follows_linked_issues(self):
        note = self.dir / "issues" / "BL-3.md"
        note.write_text(note.read_text() + "\nDepends on [[BL-1]] and [[BL-2]].\n\n## Comments\n- 2026-10-01 rk: unlike [[BL-9]]\n")
        by_id = {i["id"]: i for i in json.loads(self.ok("list", "--json"))}
        self.assertEqual({"done": 1, "total": 1, "issues": ["BL-2"]}, by_id["BL-1"]["progress"])
        self.assertIsNone(by_id["BL-2"]["progress"])
        self.assertEqual(["BL-1", "BL-2"], by_id["BL-3"]["links"])
        self.assertEqual({"done": 1, "total": 2, "issues": ["BL-1", "BL-2"]}, by_id["BL-3"]["progress"])
        self.assertIn("progress:    1/2  (BL-1 backlog, BL-2 done)\n", self.ok("show", "BL-3"))
        self.ok("set", "BL-1", "status=canceled")
        self.assertIn("  [2/2]", self.ok("list", "--status", "backlog"))
        self.ok("archive", "--closed")
        self.assertEqual({"done": 2, "total": 2, "issues": ["BL-1", "BL-2"]}, json.loads(self.ok("show", "BL-3", "--json"))["progress"])

    def test_show(self):
        out = self.ok("show", "BL-2")
        self.assertIn("BL-2  Beta\n", out)
        self.assertIn("parent:      [[BL-1]]\n", out)
        data = json.loads(self.ok("show", "BL-2", "--json"))
        self.assertEqual("BL-1", data["parent"])
        self.assertEqual("[[BL-1]]", data["properties"]["parent"])
        self.assertEqual(1, self.run_cli("show", "BL-99")[0])

    def test_set(self):
        self.ok("set", "BL-1", "status=in-progress", "labels+=ui", "estimate=3", "blocked-by=BL-2, BL-3")
        data = json.loads(self.ok("show", "BL-1", "--json"))
        self.assertEqual("in-progress", data["status"])
        self.assertEqual(["bug", "ui"], data["labels"])
        self.assertEqual(["BL-2", "BL-3"], data["blocked-by"])
        self.assertEqual("3", data["properties"]["estimate"])
        self.ok("set", "BL-1", "labels-=bug", "blocked-by-=BL-2", "estimate=", "assignee=")
        data = json.loads(self.ok("show", "BL-1", "--json"))
        self.assertEqual(["ui"], data["labels"])
        self.assertEqual(["BL-3"], data["blocked-by"])
        self.assertNotIn("estimate", data["properties"])
        self.assertIsNone(data["assignee"])

    def test_set_validates_and_leaves_note_alone(self):
        before = (self.dir / "issues" / "BL-1.md").read_text()
        for assignment in ("status=nope", "priority=p0", "due=soon", "parent=BL-1", "parent=BL-99",
                           "blocked-by=BL-1", "title=", "status=", "nonsense"):
            with self.subTest(assignment=assignment):
                self.assertEqual(1, self.run_cli("set", "BL-1", "assignee=x", assignment)[0])
                self.assertEqual(before, (self.dir / "issues" / "BL-1.md").read_text())

    def test_retitle_updates_index_line(self):
        self.ok("set", "BL-2", "title=Beta:  two")
        self.assertIn("- [[BL-2]] Beta: two\n", self.index.read_text())
        self.assertIn('title: "Beta: two"\n', (self.dir / "issues" / "BL-2.md").read_text())

    def test_comment_author_sources(self):
        self.ok("comment", "BL-1", "from user")
        os.environ["BILINEAR_USER"] = "env"
        self.ok("comment", "BL-1", "from env")
        self.ok("--author", "flag", "comment", "BL-1", "from flag")
        self.ok("comment", "BL-1", "from flag after", "--author", "late")
        text = (self.dir / "issues" / "BL-1.md").read_text()
        self.assertTrue(text.endswith(
            "\n## Comments\n- 2026-10-01 rk: from user\n- 2026-10-01 env: from env\n"
            "- 2026-10-01 flag: from flag\n- 2026-10-01 late: from flag after\n"))
        self.assertEqual(1, self.run_cli("comment", "BL-1", " ")[0])

    def test_move(self):
        self.ok("move", "BL-3", "--top")
        self.assertEqual(["BL-3", "BL-1", "BL-2"], self.ids())
        self.ok("move", "BL-3", "--after", "BL-1")
        self.assertEqual(["BL-1", "BL-3", "BL-2"], self.ids())
        self.ok("move", "BL-2", "--before", "BL-3")
        self.assertEqual(["BL-1", "BL-2", "BL-3"], self.ids())
        self.ok("move", "BL-1", "--bottom")
        self.assertEqual(["BL-2", "BL-3", "BL-1"], self.ids())
        self.ok("archive", "BL-3")
        for argv in (["BL-1", "--before", "BL-1"], ["BL-3", "--top"], ["BL-1", "--after", "BL-3"],
                     ["BL-9", "--top"], ["BL-1"], ["BL-1", "--top", "--bottom"]):
            with self.subTest(argv=argv):
                self.assertEqual(1, self.run_cli("move", *argv)[0])

    def test_archive_and_unarchive(self):
        self.assertEqual("BL-2\n", self.ok("archive", "--closed"))
        self.assertTrue((self.dir / "archive" / "BL-2.md").is_file())
        self.assertFalse((self.dir / "issues" / "BL-2.md").exists())
        self.assertEqual("", self.ok("archive", "--closed"))
        self.assertEqual("", self.ok("archive", "BL-2"))
        self.assertEqual("BL-2\n", self.ok("unarchive", "BL-2"))
        self.assertEqual(["BL-1", "BL-3", "BL-2"], self.ids())
        self.assertTrue((self.dir / "issues" / "BL-2.md").is_file())
        self.assertEqual(1, self.run_cli("archive")[0])
        self.assertEqual(1, self.run_cli("archive", "BL-1", "--closed")[0])
        self.assertEqual(1, self.run_cli("archive", "BL-1", "BL-99")[0])
        self.assertEqual(["BL-1", "BL-3", "BL-2"], self.ids())

    def test_rm_moves_note_to_vault_trash(self):
        self.ok("rm", "BL-2")
        self.assertEqual(["BL-1", "BL-3"], self.ids("--all"))
        self.assertTrue((self.vault / ".trash" / "BL-2.md").is_file())
        (self.dir / "issues" / "BL-2.md").write_text("---\ntitle: again\nstatus: todo\n---\n")
        self.ok("adopt", "BL-2")
        self.ok("rm", "BL-2")
        self.assertTrue((self.vault / ".trash" / "BL-2 2.md").is_file())

    def test_rm_without_vault_needs_force(self):
        (self.vault / ".obsidian").rmdir()
        code, _, err = self.run_cli("rm", "BL-2")
        self.assertEqual(1, code)
        self.assertIn("--force", err)
        self.assertTrue((self.dir / "issues" / "BL-2.md").is_file())
        self.assertEqual(["BL-1", "BL-2", "BL-3"], self.ids())
        self.ok("rm", "BL-2", "--force")
        self.assertFalse((self.dir / "issues" / "BL-2.md").exists())
        self.assertFalse((self.vault / ".trash").exists())

    def test_rm_line_without_note_needs_no_vault(self):
        (self.vault / ".obsidian").rmdir()
        (self.dir / "issues" / "BL-2.md").unlink()
        self.ok("rm", "BL-2")
        self.assertEqual(["BL-1", "BL-3"], self.ids())

    def test_adopt(self):
        self.assertEqual(1, self.run_cli("adopt", "BL-1")[0])
        self.assertEqual(1, self.run_cli("adopt", "BL-40")[0])
        (self.dir / "issues" / "BL-40.md").write_text("---\ntitle: Found\nstatus: todo\n---\n")
        self.ok("adopt", "BL-40")
        text = self.index.read_text()
        self.assertIn("- [[BL-3]] Gamma\n- [[BL-40]] Found\n", text)
        self.assertIn("next: 41\n", text)

    def test_lint_exit_codes_and_json(self):
        self.assertEqual(0, self.run_cli("lint")[0])
        (self.dir / "issues" / "BL-2.md").unlink()
        code, out, _ = self.run_cli("lint")
        self.assertEqual(2, code)
        self.assertIn("error: BL-2: note missing [note-missing]\n", out)
        data = json.loads(self.run_cli("lint", "--json")[1])
        self.assertEqual(["note-missing"], [p["code"] for p in data["problems"]])

    def test_lint_fix_reports_fixed_and_exits_clean(self):
        self.index.write_text(self.index.read_text().replace("- [[BL-1]] Alpha", "* [[BL-1]] Alfa").replace("next: 4", "next: 1"))
        code, out, _ = self.run_cli("lint", "--fix")
        self.assertEqual(0, code)
        self.assertEqual(3, out.count("fixed: "))
        self.assertEqual((0, "no problems found\n"), self.run_cli("lint")[:2])

    def test_lint_never_writes_without_fix(self):
        self.index.write_text(self.index.read_text().replace("- [[BL-1]] Alpha", "* [[BL-1]] Alfa"))
        before = self.index.read_bytes()
        self.assertEqual(2, self.run_cli("lint")[0])
        self.assertEqual(before, self.index.read_bytes())

    def test_broken_index_is_a_usage_error_but_lint_reports_it(self):
        self.index.write_text(self.index.read_text().replace("prefix: BL", "prefix: bl"))
        self.assertEqual(1, self.run_cli("list")[0])
        code, out, _ = self.run_cli("lint")
        self.assertEqual(2, code)
        self.assertIn("[index-key]", out)

    def test_multiple_trackers_reported(self):
        (self.dir / "Other.md").write_text("---\nbilinear: tracker\nprefix: OT\nnext: 1\nstates: [todo]\n---\n")
        code, out, _ = self.run_cli("lint")
        self.assertEqual(2, code)
        self.assertIn("[multiple-trackers]", out)
        self.assertEqual(["BL-1", "BL-2", "BL-3"], self.ids())

    def test_usage_errors_exit_1(self):
        for argv in ([], ["bogus"], ["new"], ["list", "--nope"], ["show"]):
            with self.subTest(argv=argv):
                self.assertEqual(1, self.run_cli(*argv)[0])


if __name__ == "__main__":
    unittest.main()
