#!/usr/bin/env python3
"""Discover the examples CI must check, and how each one is checked.

The convention lives in CONTRIBUTING.md: one example per directory, exactly one
level inside a track (`<track>/<example-name>/`). This script implements that
rule so adding an example needs no workflow edit.

`_template/` counts as a track container here, deliberately: `_template/stub-ts`
is what every TypeScript example is copied from, so it is the highest-leverage
directory in the repo to keep building.

It fails rather than skipping anything it doesn't understand. A directory CI
silently ignores is worse than no CI at all — the README promises every example
builds, so an unchecked example is a broken promise nobody can see.

Run it locally the same way CI does:

    python3 .github/scripts/discover-examples.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Top-level directories that are not track containers. Dot-directories (.git,
# .github, ...) are skipped by rule. Add here if the repo ever grows a
# non-example top-level directory such as `docs/`; leaving it out makes CI fail
# loudly, which is the intended direction.
NON_TRACK_DIRS: set[str] = set()

# Build output and dependency directories, in case this is run in a working
# tree that has them. They are gitignored, so CI never sees them.
IGNORED_CHILD_DIRS = {
    "node_modules",
    "target",
    "dist",
    "build",
    "venv",
    "__pycache__",
}

# CONTRIBUTING.md: lowercase kebab-case. Enforcing it here also keeps the
# discovered paths free of anything a shell could interpret, since they are
# interpolated into the workflow's matrix.
EXAMPLE_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TRACK_NAME_RE = re.compile(r"^_?[a-z0-9]+(?:-[a-z0-9]+)*$")

# Manifest a directory is recognised by, and the CI recipe that checks it.
# `None` means the language has no recipe yet: the PR adding the first example
# in that language adds the job, in the same PR.
MANIFESTS: list[tuple[str, str, str | None]] = [
    ("package.json", "node", "node"),
    ("Cargo.toml", "rust", None),
    ("pyproject.toml", "python", None),
]

CONVENTION_HINT = (
    "CONTRIBUTING.md requires one example per directory, exactly one level "
    "inside a track (<track>/<example-name>/)"
)


def iter_tracks() -> list[Path]:
    tracks = []
    for entry in sorted(ROOT.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if entry.name in NON_TRACK_DIRS:
            continue
        tracks.append(entry)
    return tracks


def iter_candidates(track: Path) -> list[Path]:
    return [
        child
        for child in sorted(track.iterdir())
        if child.is_dir()
        and not child.name.startswith(".")
        and child.name not in IGNORED_CHILD_DIRS
    ]


def classify(example: Path, errors: list[str]) -> str | None:
    """Return the CI recipe for `example`, or None after recording an error."""
    rel = example.relative_to(ROOT).as_posix()
    found = [(m, lang, job) for m, lang, job in MANIFESTS if (example / m).is_file()]

    if not found:
        manifests = ", ".join(m for m, _, _ in MANIFESTS)
        errors.append(
            f"{rel}: no manifest found (expected one of: {manifests}). "
            f"If this is not an example it does not belong here: {CONVENTION_HINT}."
        )
        return None

    if len(found) > 1:
        langs = ", ".join(lang for _, lang, _ in found)
        errors.append(
            f"{rel}: manifests for more than one language ({langs}). "
            "Split it into one example per language."
        )
        return None

    manifest, lang, job = found[0]
    if job is None:
        errors.append(
            f"{rel}: found {manifest}, but CI has no {lang} recipe yet. "
            "Add the job to .github/workflows/ci.yml in the same PR — CI fails "
            "on a directory it cannot check rather than skipping it."
        )
        return None

    return job


def check_node(example: Path, errors: list[str]) -> None:
    rel = example.relative_to(ROOT).as_posix()

    if not (example / "package-lock.json").is_file():
        errors.append(
            f"{rel}: no package-lock.json. Commit the lockfile so the pinned "
            "versions are reproducible and Dependabot has something to bump."
        )
        return

    try:
        manifest = json.loads((example / "package.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{rel}: package.json is not readable JSON ({exc}).")
        return

    scripts = manifest.get("scripts") or {}
    if not any(name in scripts for name in ("typecheck", "build")):
        errors.append(
            f"{rel}: package.json defines neither a `typecheck` nor a `build` "
            "script, so CI has nothing to check it with. Add one."
        )


def main() -> int:
    errors: list[str] = []
    by_job: dict[str, list[str]] = {job: [] for _, _, job in MANIFESTS if job}

    for track in iter_tracks():
        # An example at the repo root, or a track directory that is itself an
        # example, would otherwise fall outside discovery entirely.
        if any((track / m).is_file() for m, _, _ in MANIFESTS):
            errors.append(
                f"{track.name}/: looks like an example at the repo root. "
                f"Move it into a track: {CONVENTION_HINT}."
            )
            continue

        if not TRACK_NAME_RE.match(track.name):
            errors.append(
                f"{track.name}/: track directory name is not lowercase "
                "kebab-case."
            )
            continue

        for example in iter_candidates(track):
            rel = example.relative_to(ROOT).as_posix()

            if not EXAMPLE_NAME_RE.match(example.name):
                errors.append(
                    f"{rel}: directory name is not lowercase kebab-case "
                    "(CONTRIBUTING.md § Naming)."
                )
                continue

            job = classify(example, errors)
            if job is None:
                continue
            if job == "node":
                check_node(example, errors)

            by_job[job].append(rel)

    for error in errors:
        print(f"::error::{error}")
    if errors:
        print(
            f"\n{len(errors)} problem(s) found. CI checks every example "
            "directory and fails on any it cannot check."
        )
        return 1

    lines = ["## Examples discovered", ""]
    total = 0
    for job, dirs in sorted(by_job.items()):
        total += len(dirs)
        print(f"{job}: {len(dirs)} example(s)")
        for d in dirs:
            print(f"  {d}")
            lines.append(f"- `{d}` — {job}")
    if total == 0:
        # Not an error: the track directories are empty until the seed examples
        # land, and the gate job below still has to report green.
        print("no examples found")
        lines.append("_No examples found._")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as fh:
            for job, dirs in sorted(by_job.items()):
                fh.write(f"{job}={json.dumps(dirs)}\n")
                fh.write(f"any-{job}={'true' if dirs else 'false'}\n")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
