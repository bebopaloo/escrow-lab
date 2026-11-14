# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""The Control register and its traceability matrix (ADR 0014, module control_register).

Commands:
  validate [--repo <path>]
      Check _context/controls/controls.toml: the schema, unique IDs, module
      globs that match tracked files, a tagged test or a manual check for each
      Control, and no tagged test for an unknown Control. With the threat_model
      module on, also check _context/threat-model.md (work item C7): each TM-
      under a TB- heading, unique IDs, STRIDE categories, Controls that the
      register lists, and each [[boundary]] of the Risk map named there. A
      Control that guards authority code and that no threat cites is a warning.
  scan [--repo <path>]
      Map each Control ID to the test files that carry it.
  matrix [--repo <path>] --junit <file>... [--format md|json]
      Each Control with its modules, its tests and their results from the
      JUnit reports, its manual checks, and a status: passing, failing,
      untested or manual.

A test carries a Control ID in its name: `[CTRL-PAY-03] refuses …` in a
TypeScript test, or `test_ctrl_pay_03_…` in a Python test.

With the module off, validate and scan print {"skipped": "control_register is
off"} and exit 0. Prints one JSON document (or the markdown matrix) on stdout.
On an error: exit code 1 and {"error": ..., "problems": [...]} on stderr.
"""

import argparse
import json
import re
import subprocess
import sys
import tomllib
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from typing import TextIO

import risk_tier
from factory_config import ConfigError, resolve_repo, skip_unless
from risk_tier import glob_matches

REGISTER = Path("_context") / "controls" / "controls.toml"
TEMPLATE = Path(__file__).resolve().parents[1] / "templates" / "controls" / "controls.toml"
CONTROL_ID = re.compile(r"^CTRL-[A-Z]+-\d+$")
BRACKET_ID = re.compile(r"\[(CTRL-[A-Z]+-\d+)\]")
PYTHON_ID = re.compile(r"ctrl_([a-z]+)_(\d+)")
CONTROL_KEYS = {"id", "title", "sources", "owner", "modules", "manual_checks"}
REQUIRED_KEYS = ("title", "owner", "modules")
THREAT_MODEL = Path("_context") / "threat-model.md"
STRIDE = {
    "Spoofing", "Tampering", "Repudiation", "Information disclosure", "Denial of service", "Elevation of privilege",
}
BOUNDARY_HEADING = re.compile(r"^## (TB-\d+)\s+(.*)$")
THREAT_HEADING = re.compile(r"^### (TM-\d+)\s+(.*)$")
FIELD = re.compile(r"^- (STRIDE|Controls):\s*(.*)$")
COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
DEFAULT_TESTS = (
    "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx",
    "**/test_*.py", "**/*_test.py", "**/*_test.go",
)


class ControlsError(Exception):
    def __init__(self, problems: list[str] | str):
        self.problems = [problems] if isinstance(problems, str) else problems
        super().__init__("; ".join(self.problems))


def ids_in_name(name: str) -> list[str]:
    """The Control IDs in one test name, in order, without repeats."""
    found = BRACKET_ID.findall(name)
    found += [f"CTRL-{area.upper()}-{number}" for area, number in PYTHON_ID.findall(name)]
    return list(dict.fromkeys(found))


def load(repo: Path) -> dict:
    path = Path(repo) / REGISTER
    if not path.is_file():
        raise ControlsError(f"control_register is on, but {REGISTER.as_posix()} is missing")
    try:
        data = tomllib.loads(path.read_text())
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ControlsError(f"{REGISTER.as_posix()} cannot be read: {error}") from error
    if not isinstance(data.get("control", []), list):
        raise ControlsError("control must be a list of [[control]] tables")
    return data


def _tracked(repo: Path) -> list[str]:
    result = subprocess.run(["git", "ls-files"], cwd=repo, capture_output=True, text=True)
    if result.returncode != 0:
        raise ControlsError(f"git ls-files failed: {result.stderr.strip()}")
    return result.stdout.splitlines()


def scan(repo: Path, data: dict | None = None, files: list[str] | None = None) -> dict[str, list[str]]:
    """Control ID → the test files that carry it."""
    repo = Path(repo)
    data = data if data is not None else load(repo)
    globs = data.get("tests") or list(DEFAULT_TESTS)
    found: dict[str, list[str]] = {}
    for name in sorted(files if files is not None else _tracked(repo)):
        if not any(glob_matches(glob, name) for glob in globs):
            continue
        try:
            text = (repo / name).read_text()
        except (OSError, UnicodeDecodeError):
            continue
        for control in ids_in_name(text):
            found.setdefault(control, []).append(name)
    return found


def validate(repo: Path) -> list[str]:
    repo = Path(repo)
    try:
        data = load(repo)
    except ControlsError as error:
        return error.problems
    files = _tracked(repo)
    problems, seen = [], set()
    tagged = scan(repo, data, files)
    for entry in data.get("control", []):
        if not isinstance(entry, dict):
            problems.append("each [[control]] must be a table")
            continue
        control = entry.get("id")
        if not isinstance(control, str) or not CONTROL_ID.match(control):
            problems.append(f"{control} is not a Control ID like CTRL-PAY-03")
            continue
        if control in seen:
            problems.append(f"{control} is listed more than once")
        seen.add(control)
        problems += [f"{control}: unknown key {key}" for key in entry if key not in CONTROL_KEYS]
        problems += [f"{control}: {key} is missing" for key in REQUIRED_KEYS if not entry.get(key)]
        for glob in entry.get("modules") or []:
            if not any(glob_matches(glob, name) for name in files):
                problems.append(f"{control}: module {glob} matches no file")
        if control not in tagged and not entry.get("manual_checks"):
            problems.append(f"{control} has no tagged test and no manual check")
    for control, names in tagged.items():
        if control not in seen:
            problems += [f"{name} tags {control}, which the Control register does not list" for name in names]
    if _threat_model_on(repo):
        problems += _threat_problems(repo, data)
    return problems


def _read_threats(text: str) -> tuple[dict, list[str], list[str]]:
    """Threats, boundary IDs and problems of a threat-model.md text. HTML comments are ignored."""
    threats: dict[str, dict] = {}
    boundaries: list[str] = []
    problems: list[str] = []
    boundary = None
    current = None
    for line in COMMENT.sub("", text).splitlines():
        if match := BOUNDARY_HEADING.match(line):
            boundary, current = match.group(1), None
            if boundary in boundaries:
                problems.append(f"{boundary} is listed more than once")
            boundaries.append(boundary)
        elif match := THREAT_HEADING.match(line):
            threat, name = match.groups()
            if threat in threats:
                problems.append(f"{threat} is listed more than once")
            if boundary is None:
                problems.append(f"{threat} is not under a ## TB- heading")
            current = threat
            threats[threat] = {"boundary": boundary, "name": name.strip(), "stride": None, "controls": None}
        elif line.startswith("## "):
            boundary, current = None, None
        elif current and (match := FIELD.match(line)):
            key, value = match.groups()
            items = [item.strip() for item in value.split(",") if item.strip()]
            if key == "STRIDE":
                threats[current]["stride"] = items
                problems += [f"{current}: {item} is not a STRIDE category" for item in items if item not in STRIDE]
            else:
                threats[current]["controls"] = [] if value.strip().lower() == "none" else items
    for threat, entry in threats.items():
        if entry["stride"] is None:
            problems.append(f"{threat} has no STRIDE line")
        if entry["controls"] is None:
            problems.append(f"{threat} has no Controls line")
    return threats, boundaries, problems


def parse_threats(text: str) -> dict:
    return _read_threats(text)[0]


def _threat_model_on(repo: Path) -> bool:
    return "threat_model" in resolve_repo(repo)["modules"]


def _map_boundaries(repo: Path) -> list[str]:
    path = repo / risk_tier.MAP_PATH
    if not path.is_file():
        return []
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError:
        return []  # risk_tier.py validate reports a bad Risk map
    return [entry.get("id") for entry in data.get("boundary", []) if isinstance(entry, dict)]


def _threat_problems(repo: Path, data: dict) -> list[str]:
    path = repo / THREAT_MODEL
    if not path.is_file():
        return [f"threat_model is on, but {THREAT_MODEL.as_posix()} is missing"]
    threats, boundaries, problems = _read_threats(path.read_text())
    listed = {entry.get("id") for entry in data.get("control", []) if isinstance(entry, dict)}
    for threat, entry in threats.items():
        problems += [f"{threat} cites {c}, which the Control register does not list" for c in entry["controls"] or [] if c not in listed]
    problems += [f"{risk_tier.MAP_PATH.as_posix()} names boundary {b}, which the Threat model does not have"
                 for b in _map_boundaries(repo) if b not in boundaries]
    return problems


def warnings(repo: Path) -> list[str]:
    """Findings that do not fail validate: an authority Control that no threat cites."""
    repo = Path(repo)
    if not _threat_model_on(repo) or not (repo / THREAT_MODEL).is_file():
        return []
    data = load(repo)
    cited = {c for entry in parse_threats((repo / THREAT_MODEL).read_text()).values() for c in entry["controls"] or []}
    rules = risk_tier.load_rules(repo)
    authority_files = [f for f in _tracked(repo) if risk_tier.tier_of(f, rules)[0] == "authority"]
    found = []
    for entry in data.get("control", []):
        control = entry.get("id")
        guards = any(glob_matches(g, f) for g in entry.get("modules") or [] for f in authority_files)
        if guards and control not in cited:
            found.append(f"{control} guards authority code, but no threat in the Threat model cites it")
    return found


def _results(paths: list[Path]) -> list[dict]:
    results = []
    for path in paths:
        try:
            root = ElementTree.parse(path).getroot()
        except (OSError, ElementTree.ParseError) as error:
            raise ControlsError(f"the junit report {path} cannot be read: {error}") from error
        for case in root.iter("testcase"):
            if case.find("failure") is not None or case.find("error") is not None:
                result = "failed"
            elif case.find("skipped") is not None:
                result = "skipped"
            else:
                result = "passed"
            results.append({"name": case.get("name", ""), "file": case.get("classname", ""), "result": result})
    return results


def _status(tests: list[dict], manual: list[str]) -> str:
    results = {t["result"] for t in tests}
    if "failed" in results:
        return "failing"
    if "passed" in results:
        return "passing"
    return "manual" if manual and not tests else "untested"


def matrix(repo: Path, junit: list[Path]) -> list[dict]:
    data = load(Path(repo))
    results = _results([Path(p) for p in junit])
    rows = []
    for entry in data.get("control", []):
        control = entry.get("id")
        tests = [{"name": r["name"], "file": r["file"], "result": r["result"]}
                 for r in results if control in ids_in_name(r["name"])]
        manual = entry.get("manual_checks") or []
        rows.append({
            "id": control,
            "title": entry.get("title", ""),
            "sources": entry.get("sources") or [],
            "owner": entry.get("owner", ""),
            "modules": entry.get("modules") or [],
            "tests": tests,
            "manual_checks": manual,
            "status": _status(tests, manual),
        })
    return rows


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def to_markdown(rows: list[dict]) -> str:
    lines = ["| Control | Title | Modules | Tests | Status |", "|---|---|---|---|---|"]
    for row in rows:
        tests = "<br>".join(f"{_cell(t['name'])} ({t['result']})" for t in row["tests"])
        manual = "<br>".join(f"Manual: {_cell(m)}" for m in row["manual_checks"])
        evidence = "<br>".join(part for part in (tests, manual) if part) or "none"
        modules = ", ".join(f"`{m}`" for m in row["modules"])
        lines.append(f"| {row['id']} | {_cell(row['title'])} | {modules} | {evidence} | {row['status']} |")
    return "\n".join(lines) + "\n"


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ControlsError(message)


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = _Parser(prog="controls.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    for name in ("validate", "scan"):
        commands.add_parser(name).add_argument("--repo", default=".")
    matrix_cmd = commands.add_parser("matrix")
    matrix_cmd.add_argument("--repo", default=".")
    matrix_cmd.add_argument("--junit", action="append", required=True)
    matrix_cmd.add_argument("--format", choices=("md", "json"), default="md")
    try:
        args = parser.parse_args(argv)
        repo = Path(args.repo)
        skipped = skip_unless(repo, "control_register")
        if skipped:
            stdout.write(json.dumps(skipped) + "\n")
            return 0
        if args.command == "validate":
            problems = validate(repo)
            if problems:
                raise ControlsError(problems)
            found = warnings(repo)
            stdout.write(json.dumps({"valid": True, **({"warnings": found} if found else {})}) + "\n")
        elif args.command == "scan":
            stdout.write(json.dumps(scan(repo), indent=2) + "\n")
        else:
            rows = matrix(repo, args.junit)
            text = to_markdown(rows) if args.format == "md" else json.dumps({"controls": rows}, indent=2) + "\n"
            stdout.write(text)
    except (ControlsError, ConfigError, risk_tier.TierError) as error:
        stderr.write(json.dumps({"error": str(error), "problems": error.problems}) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
