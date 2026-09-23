#!/usr/bin/env python3
"""Check that catalog.json lists every example, and only examples that exist.

catalog.json is the machine-readable index of this repo. `nexus examples
list/show/get` in nexus-exchange-cli reads it (ENG-17337), so an example missing
from it is invisible there, and an entry pointing at a moved directory makes
`get` fail for whoever tries it.

The directory convention is the one discover-examples.py enforces:
`<track>/<example-name>/`, one level deep. `_template/` is not an example and
must not be listed.

Run it locally the same way CI does:

    python3 .github/scripts/check-catalog.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "catalog.json"

IGNORED_CHILD_DIRS = {"node_modules", "target", "dist", "build", "venv", "__pycache__"}
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CREDENTIALS = {"none", "optional", "required"}
LANGUAGES = {"typescript", "rust", "python", "shell"}
REQUIRED = {
    "id": str,
    "track": str,
    "language": str,
    "path": str,
    "summary": str,
    "credentials": str,
    "writes": bool,
    "toolchain": list,
    "setup": list,
    "run": str,
}


def example_dirs() -> set[str]:
    found: set[str] = set()
    for track in sorted(ROOT.iterdir()):
        if not track.is_dir() or track.name.startswith((".", "_")):
            continue
        for child in sorted(track.iterdir()):
            if child.is_dir() and child.name not in IGNORED_CHILD_DIRS and not child.name.startswith("."):
                found.add(f"{track.name}/{child.name}")
    return found


def main() -> int:
    errors: list[str] = []
    try:
        catalog = json.loads(CATALOG.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read {CATALOG.name}: {exc}", file=sys.stderr)
        return 1

    if catalog.get("schema") != 1:
        errors.append("`schema` must be 1")
    entries = catalog.get("examples")
    if not isinstance(entries, list):
        print("error: `examples` must be a list", file=sys.stderr)
        return 1

    listed: set[str] = set()
    seen: set[tuple[str, str]] = set()
    for i, entry in enumerate(entries):
        where = f"examples[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{where}: not an object")
            continue
        bad = [k for k, kind in REQUIRED.items() if not isinstance(entry.get(k), kind)]
        if bad:
            errors.extend(f"{where}: `{k}` missing or not a {REQUIRED[k].__name__}" for k in bad)
            continue
        where = f"{where} ({entry['path']})"
        path, track, eid = entry["path"], entry["track"], entry["id"]
        if not ID_RE.match(eid):
            errors.append(f"{where}: id `{eid}` is not lowercase kebab-case")
        if path != f"{track}/{eid}":
            errors.append(f"{where}: path must be `<track>/<id>`, i.e. `{track}/{eid}`")
        if entry["credentials"] not in CREDENTIALS:
            errors.append(f"{where}: credentials must be one of {sorted(CREDENTIALS)}")
        if entry["language"] not in LANGUAGES:
            errors.append(f"{where}: language must be one of {sorted(LANGUAGES)}")
        if not all(isinstance(s, str) for s in entry["toolchain"] + entry["setup"]):
            errors.append(f"{where}: toolchain and setup must be lists of strings")
        if (eid, entry["language"]) in seen:
            errors.append(f"{where}: id `{eid}` is listed twice for {entry['language']}")
        seen.add((eid, entry["language"]))
        if path in listed:
            errors.append(f"{where}: listed twice")
        listed.add(path)
        example = ROOT / path
        if not (example / "README.md").is_file():
            errors.append(f"{where}: no README.md at {path}/")
        if any(".env.example" in s for s in entry["setup"]) and not (example / ".env.example").is_file():
            errors.append(f"{where}: setup copies .env.example, but {path}/.env.example does not exist")

    on_disk = example_dirs()
    for path in sorted(on_disk - listed):
        errors.append(f"{path}/ is an example with no catalog.json entry")
    for path in sorted(listed - on_disk):
        errors.append(f"catalog.json lists {path}, which is not an example directory")

    if errors:
        for err in errors:
            print(f"error: {err}", file=sys.stderr)
        print(f"\n{len(errors)} problem(s) in {CATALOG.name}", file=sys.stderr)
        return 1
    print(f"{CATALOG.name}: {len(entries)} examples, all present and consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
