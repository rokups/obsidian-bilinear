"""Run spec/fixtures cases through the CLI.

Each case is ``before/`` (a tracker folder), ``op.json`` (one operation)
and ``after/`` (the expected folder). The TypeScript tests run the same
cases against the plugin's ops.
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import bilinear  # noqa: E402

FIXTURES = HERE.parent.parent / "spec" / "fixtures"


def cases() -> list[Path]:
    return sorted(p for p in FIXTURES.iterdir() if (p / "op.json").is_file())


def argv_for(op: dict) -> list[str]:
    a = op.get("args", {})
    kind = op["op"]
    if kind == "create":
        argv = ["new", a["title"]]
        for key in ("status", "priority", "assignee", "due", "parent"):
            if a.get(key):
                argv += [f"--{key}", a[key]]
        for label in a.get("labels", []):
            argv += ["--label", label]
        if a.get("top"):
            argv.append("--top")
        return argv
    if kind == "set":
        argv = ["set", a["id"]]
        for key, value in a["props"].items():
            if value is None:
                value = ""
            elif isinstance(value, list):
                value = ",".join(value)
            argv.append(f"{key}={value}")
        return argv
    if kind == "move":
        argv = ["move", a["id"]]
        for key in ("before", "after"):
            if a.get(key):
                argv += [f"--{key}", a[key]]
        for key in ("top", "bottom"):
            if a.get(key):
                argv.append(f"--{key}")
        return argv
    if kind in ("archive", "unarchive"):
        return [kind] + (["--closed"] if a.get("closed") else a["ids"])
    if kind == "delete":
        return ["rm", a["id"]]
    if kind == "comment":
        return ["--author", op.get("author", "rk"), "comment", a["id"], a["text"]]
    if kind == "adopt":
        return ["adopt", a["id"]]
    if kind == "label":
        argv = ["label", a["name"]]
        if "color" in a:
            argv += ["--color", a["color"] if a["color"] is not None else "none"]
        return argv
    if kind == "labels":
        return ["label", "--json"]
    if kind == "state":
        argv = ["state", a["name"]]
        for key in ("icon", "color"):
            if key in a:
                argv += [f"--{key}", a[key] if a[key] is not None else "none"]
        return argv
    if kind == "states":
        return ["state", "--json"]
    if kind == "lint":
        return ["lint", "--json"] + (["--fix"] if a.get("fix") else [])
    if kind == "list":
        return ["list", "--all", "--json"]
    raise ValueError(f"unknown op {kind}")


def run(case: Path, workdir: Path) -> tuple[Path, dict]:
    """Copy before/ into a scratch vault, apply op.json. Returns (tracker dir, result)."""
    op = json.loads((case / "op.json").read_text())
    vault = workdir / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    tracker = vault / "Tracker"
    shutil.copytree(case / "before", tracker)
    old_env = dict(os.environ)
    os.environ["BILINEAR_TODAY"] = op.get("today", "2026-01-01")
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = bilinear.main(["--tracker", str(tracker)] + argv_for(op))
    finally:
        os.environ.clear()
        os.environ.update(old_env)
    result: dict = {"exit": code, "stderr": err.getvalue()}
    text = out.getvalue()
    if op["op"] == "create":
        result["id"] = text.strip()
    elif op["op"] == "lint":
        data = json.loads(text)
        result["problems"] = sorted(f"{p['code']}:{p['id'] or '-'}" for p in data["problems"])
    elif op["op"] in ("labels", "states"):
        result[op["op"]] = json.loads(text)
    elif op["op"] == "list":
        result["issues"] = json.loads(text)
    return tracker, result


def snapshot(folder: Path) -> dict[str, bytes]:
    """Every file under a folder. The lock file used on Windows is not tracker content."""
    return {
        str(p.relative_to(folder)).replace(os.sep, "/"): p.read_bytes()
        for p in sorted(folder.rglob("*")) if p.is_file() and p.name != bilinear.LOCK_FILE
    }


def regenerate(case: Path) -> None:
    """Rewrite after/ from what the CLI produces. For authoring fixtures only."""
    with tempfile.TemporaryDirectory() as tmp:
        tracker, _ = run(case, Path(tmp))
        after = case / "after"
        if after.exists():
            shutil.rmtree(after)
        for rel, data in snapshot(tracker).items():
            p = after / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
