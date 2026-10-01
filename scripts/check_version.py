#!/usr/bin/env python3
"""Check that the version is the same everywhere, and equals the one given.

    scripts/check_version.py           all version numbers agree
    scripts/check_version.py 0.2.0     ... and are 0.2.0 (used by the release workflow)
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    manifest = json.loads((ROOT / "manifest.json").read_text())
    versions = {
        "manifest.json": manifest["version"],
        "plugin/package.json": json.loads((ROOT / "plugin" / "package.json").read_text())["version"],
        "cli/bilinear.py": re.search(r'^VERSION = "([^"]+)"', (ROOT / "cli" / "bilinear.py").read_text(), re.M).group(1),
    }
    wanted = sys.argv[1] if len(sys.argv) > 1 else manifest["version"]
    problems = [f"{name} has {v}, expected {wanted}" for name, v in versions.items() if v != wanted]
    supported = json.loads((ROOT / "versions.json").read_text())
    if supported.get(wanted) != manifest["minAppVersion"]:
        problems.append(f"versions.json should map {wanted} to {manifest['minAppVersion']}")
    for p in problems:
        print(p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
