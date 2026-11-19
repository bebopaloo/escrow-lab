# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Find new direct dependencies and check that the Security section names them (ADR 0014, module dependency_control).

A new direct dependency is a name in a dependency manifest at HEAD that the
same manifest did not have at the merge base. Manifests:
  package.json      dependencies, devDependencies, optionalDependencies, peerDependencies
  pyproject.toml    [project] dependencies, [project.optional-dependencies], [dependency-groups]
  requirements*.txt one requirement per line
Lock files are not manifests: a version change is not a new dependency.

Commands:
  added [--repo <path>] --base <ref>
      List the new direct dependencies, as {manifest, name}.
  check [--repo <path>] --base <ref> --body-file <file>
      Each new direct dependency must appear by name in the Security section
      field "New dependencies, secrets, permissions or data", with its reason.
      Exit 0 when each one is named, 1 when one is not, 2 on an error. With the
      module off, prints {"skipped": "dependency_control is off"} and exits 0.
"""

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path, PurePosixPath
from typing import TextIO

from factory_config import ConfigError, skip_unless
from pr_sections import FIELD_LINE, SECTION

FIELD = "New dependencies, secrets, permissions or data"
NPM_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
REQUIREMENT_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


class DependencyError(Exception):
    pass


def _git(repo: Path, *args: str, check: bool = True) -> str | None:
    result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    if result.returncode != 0:
        if check:
            raise DependencyError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
        return None
    return result.stdout


def _is_manifest(path: str) -> bool:
    name = PurePosixPath(path).name
    return name in {"package.json", "pyproject.toml"} or (name.startswith("requirements") and name.endswith(".txt"))


def _python_name(requirement: str) -> str | None:
    match = REQUIREMENT_NAME.match(requirement)
    return re.sub(r"[-_.]+", "-", match.group(1)).lower() if match else None


def names(path: str, text: str | None) -> set[str]:
    """The direct dependency names of one manifest text. A missing file has none."""
    if not text:
        return set()
    name = PurePosixPath(path).name
    try:
        if name == "package.json":
            data = json.loads(text)
            return {dep for section in NPM_SECTIONS for dep in (data.get(section) or {})}
        if name == "pyproject.toml":
            data = tomllib.loads(text)
            requirements = list((data.get("project") or {}).get("dependencies") or [])
            for group in ((data.get("project") or {}).get("optional-dependencies") or {}).values():
                requirements += group
            for group in (data.get("dependency-groups") or {}).values():
                requirements += [r for r in group if isinstance(r, str)]
        else:
            requirements = [line.split("#", 1)[0] for line in text.splitlines()]
            requirements = [r for r in requirements if r.strip() and not r.strip().startswith("-")]
    except (json.JSONDecodeError, tomllib.TOMLDecodeError, AttributeError) as error:
        raise DependencyError(f"{path} cannot be read: {error}") from error
    return {n for n in (_python_name(r) for r in requirements) if n}


def added(repo: Path, base: str) -> list[dict]:
    repo = Path(repo)
    merge_base = _git(repo, "merge-base", base, "HEAD").strip()
    changed = _git(repo, "diff", "--name-only", "--no-renames", merge_base, "HEAD").splitlines()
    found = []
    for path in sorted(p for p in changed if _is_manifest(p)):
        before = names(path, _git(repo, "show", f"{merge_base}:{path}", check=False))
        after = names(path, _git(repo, "show", f"HEAD:{path}", check=False))
        found += [{"manifest": path, "name": dep} for dep in sorted(after - before)]
    return found


def is_named(dep: str, text: str) -> bool:
    return re.search(rf"(?<![\w@/.-]){re.escape(dep)}(?![\w/.-])", text, re.IGNORECASE) is not None


def check(repo: Path, base: str, body: str) -> list[str]:
    new = added(repo, base)
    if not new:
        return []
    match = SECTION.search(body)
    values = {k.strip(): v.strip() for k, v in FIELD_LINE.findall(match.group(1))} if match else {}
    field = values.get(FIELD, "")
    return [
        f"{dep['name']} ({dep['manifest']}) is a new direct dependency: name it, with its reason, in the Security section"
        for dep in new
        if not is_named(dep["name"], field)
    ]


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise DependencyError(message)


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = _Parser(prog="dependencies.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    added_cmd = commands.add_parser("added")
    added_cmd.add_argument("--repo", default=".")
    added_cmd.add_argument("--base", required=True)
    check_cmd = commands.add_parser("check")
    check_cmd.add_argument("--repo", default=".")
    check_cmd.add_argument("--base", required=True)
    check_cmd.add_argument("--body-file", required=True)
    try:
        args = parser.parse_args(argv)
        repo = Path(args.repo)
        if args.command == "added":
            stdout.write(json.dumps(added(repo, args.base), indent=2) + "\n")
            return 0
        skipped = skip_unless(repo, "dependency_control")
        if skipped:
            stdout.write(json.dumps(skipped) + "\n")
            return 0
        try:
            body = Path(args.body_file).read_text()
        except OSError as error:
            raise DependencyError(f"the body file cannot be read: {error}") from error
        problems = check(repo, args.base, body)
        result = {"added": added(repo, args.base), "problems": problems}
    except (DependencyError, ConfigError) as error:
        stderr.write(json.dumps({"error": str(error)}) + "\n")
        return 2
    stdout.write(json.dumps(result, indent=2) + "\n")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
