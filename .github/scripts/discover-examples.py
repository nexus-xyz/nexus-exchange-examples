#!/usr/bin/env python3
"""Discover the examples CI must check, and how each one is checked.

The convention lives in CONTRIBUTING.md: one example per directory, exactly one
level inside a track (`<track>/<example-name>/`). This script implements that
rule so adding an example needs no workflow edit — the matrix keys off the
directory convention, never a hardcoded list.

`_template/` counts as a track container here, deliberately: `_template/stub-ts`
is what every TypeScript example is copied from, so it is the highest-leverage
directory in the repo to keep building.

An example's language comes from its manifest, not from the track it sits in. An
MCP example is a Node or Python project, so it's checked as one; the `sdk-mcp/`
directory says what the app is built on, not what toolchain builds it.

It fails rather than skipping anything it doesn't understand. A directory CI
silently ignores is worse than no CI at all — the README promises every example
builds, so an unchecked example is a broken promise nobody can see. That extends
to gates that would pass vacuously: a Node example with no `typecheck` script or
a Python example with no `mypy` would "pass" while checking nothing, so both are
errors here instead.

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

# The manifest a language is recognised by. First match wins per language, and
# an example carrying manifests for two different languages is an error.
MANIFESTS: list[tuple[str, str]] = [
    ("package.json", "node"),
    ("Cargo.toml", "rust"),
    ("pyproject.toml", "python"),
    ("requirements.txt", "python"),
]

# Shell-driven examples (track 3 scripts the CLI) have no manifest — the CLI
# ships as a binary, not a package — so they're recognised by their scripts,
# and only when nothing else matched.
SHELL_GLOB = "*.sh"

CONVENTION_HINT = (
    "CONTRIBUTING.md requires one example per directory, exactly one level "
    "inside a track (<track>/<example-name>/)"
)

MYPY_RE = re.compile(r"^mypy\b", re.IGNORECASE)


def iter_tracks() -> list[Path]:
    return [
        entry
        for entry in sorted(ROOT.iterdir())
        if entry.is_dir()
        and not entry.name.startswith(".")
        and entry.name not in NON_TRACK_DIRS
    ]


def iter_candidates(track: Path) -> list[Path]:
    return [
        child
        for child in sorted(track.iterdir())
        if child.is_dir()
        and not child.name.startswith(".")
        and child.name not in IGNORED_CHILD_DIRS
    ]


def classify(example: Path, errors: list[str]) -> str | None:
    """Return the language of `example`, or None after recording an error."""
    rel = example.relative_to(ROOT).as_posix()

    languages = []
    for manifest, language in MANIFESTS:
        if (example / manifest).is_file() and language not in languages:
            languages.append(language)

    if len(languages) > 1:
        errors.append(
            f"{rel}: manifests for more than one language ({', '.join(languages)}). "
            "One example per directory means one toolchain per directory."
        )
        return None

    if languages:
        return languages[0]

    if any(example.glob(SHELL_GLOB)):
        return "shell"

    manifests = ", ".join(manifest for manifest, _ in MANIFESTS)
    errors.append(
        f"{rel}: nothing here says how to check it — no manifest ({manifests}) "
        f"and no {SHELL_GLOB} script. If it isn't an example it doesn't belong "
        f"here: {CONVENTION_HINT}."
    )
    return None


def check_node(example: Path, rel: str, errors: list[str]) -> None:
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


def check_rust(example: Path, rel: str, errors: list[str]) -> None:
    if not (example / "Cargo.lock").is_file():
        errors.append(
            f"{rel}: no Cargo.lock. Commit it — `cargo build --locked` needs it, "
            "and without it the dependency tree floats."
        )


def check_python(example: Path, rel: str, errors: list[str]) -> None:
    requirements = example / "requirements.txt"
    if not requirements.is_file():
        errors.append(
            f"{rel}: no requirements.txt. Python examples pin their dependencies "
            "there — it's the lockfile CI installs from."
        )
        return

    try:
        lines = requirements.read_text().splitlines()
    except OSError as exc:
        errors.append(f"{rel}: requirements.txt is not readable ({exc}).")
        return

    specs = [
        line.strip()
        for line in lines
        if line.strip() and not line.strip().startswith(("#", "-"))
    ]

    unpinned = [spec for spec in specs if "==" not in spec]
    if unpinned:
        errors.append(
            f"{rel}: requirements.txt has unpinned dependencies "
            f"({', '.join(unpinned)}). Pin exact versions with `==`."
        )

    if not any(MYPY_RE.match(spec) for spec in specs):
        errors.append(
            f"{rel}: requirements.txt doesn't pin `mypy`, so the typecheck step "
            "has nothing to run. Add it — the check is what keeps the example "
            "from rotting."
        )


def check_shell(example: Path, rel: str, errors: list[str]) -> None:
    if not (example / "README.md").is_file():
        # Every example needs a README, but for a shell example it's the only
        # place the pinned CLI version can be stated at all.
        errors.append(f"{rel}: no README.md.")


CHECKS = {
    "node": check_node,
    "rust": check_rust,
    "python": check_python,
    "shell": check_shell,
}


def main() -> int:
    errors: list[str] = []
    by_language: dict[str, list[str]] = {language: [] for language in CHECKS}

    for track in iter_tracks():
        # An example at the repo root, or a track directory that is itself an
        # example, would otherwise fall outside discovery entirely.
        if any((track / manifest).is_file() for manifest, _ in MANIFESTS):
            errors.append(
                f"{track.name}/: looks like an example at the repo root. "
                f"Move it into a track: {CONVENTION_HINT}."
            )
            continue

        if not TRACK_NAME_RE.match(track.name):
            errors.append(
                f"{track.name}/: track directory name is not lowercase kebab-case."
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

            language = classify(example, errors)
            if language is None:
                continue

            CHECKS[language](example, rel, errors)
            by_language[language].append(rel)

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
    for language, dirs in sorted(by_language.items()):
        total += len(dirs)
        if dirs:
            print(f"{language}: {len(dirs)} example(s)")
            for directory in dirs:
                print(f"  {directory}")
                lines.append(f"- `{directory}` — {language}")
    if total == 0:
        # Not an error: the track directories are empty until the seed examples
        # land, and the gate job still has to report green.
        print("no examples found")
        lines.append("_No examples found._")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            for language, dirs in sorted(by_language.items()):
                handle.write(f"{language}={json.dumps(dirs)}\n")
                handle.write(f"any-{language}={'true' if dirs else 'false'}\n")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
