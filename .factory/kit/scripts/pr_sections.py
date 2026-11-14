# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Check the Security section of a pull request body (ADR 0014, module security_section).

Commands:
  check --repo <path> --tier <tier> --body-file <file>
      An `authority` or `sensitive` pull request needs a `## Security` section
      with every field below. A `general` or `inert` pull request needs none,
      but a section that it has is checked too. Exit 0 when the body passes,
      1 when it has problems (listed on stdout), 2 on an error. With the module
      off, prints {"skipped": "security_section is off"} and exits 0.

Fields, one bullet line each, `- <field>: <value>`:
  Controls, Threats, New dependencies, secrets, permissions or data, Tests,
  Residual risk, Waivers.

`none` is a valid value, except for Tests at `authority` and `sensitive`.
Placeholders such as N/A, TBD or an empty value are not. Each CTRL-, TM-, TB-
and WAIVER- ID must be in the repo's Control register, Threat model or Waiver
register.
"""

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import TextIO

from factory_config import ConfigError, skip_unless

TIERS = ("authority", "sensitive", "general", "inert")
REQUIRED_TIERS = {"authority", "sensitive"}
FIELDS = (
    "Controls",
    "Threats",
    "New dependencies, secrets, permissions or data",
    "Tests",
    "Residual risk",
    "Waivers",
)
NOT_NONE_AT_HIGH_TIERS = {"Tests"}
PLACEHOLDERS = {"", "n/a", "na", "-", "--", "tbd", "tbc", "todo", "?"}
CONTROL_REGISTER = Path("_context") / "controls" / "controls.toml"
THREAT_MODEL = Path("_context") / "threat-model.md"
WAIVER_REGISTER = Path("_context") / "controls" / "waivers.toml"
ID_PATTERNS = {
    "Controls": re.compile(r"\bCTRL-[A-Z]+-\d+\b"),
    "Threats": re.compile(r"\bT[MB]-\d+\b"),
    "Waivers": re.compile(r"\bWAIVER-\d+\b"),
}
ID_EXAMPLES = {"Controls": "CTRL-PAY-03", "Threats": "TM-4 or TB-2", "Waivers": "WAIVER-7"}
SECTION = re.compile(r"^## Security[ \t]*\n(.*?)(?=^## |\Z)", re.MULTILINE | re.DOTALL)
FIELD_LINE = re.compile(r"^- ([^:\n]+):[ \t]*(.*)$", re.MULTILINE)

# The section that open-pr writes. The tests check that it holds every field.
TEMPLATE = """## Security
- Controls: <CTRL-… IDs, or none>
- Threats: <TM-… and TB-… IDs, or none>
- New dependencies, secrets, permissions or data: <each one with its reason, or none>
- Tests: <the tests that prove the controls>
- Residual risk: <what is left, or none>
- Waivers: <WAIVER-… IDs, or none>
"""


class SectionError(Exception):
    pass


def _toml_ids(path: Path, table: str) -> set[str]:
    if not path.is_file():
        return set()
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as error:
        raise SectionError(f"{path.name} cannot be read: {error}") from error
    return {entry.get("id") for entry in data.get(table, []) if isinstance(entry, dict)}


def _known_ids(repo: Path) -> dict[str, tuple[set[str], Path]]:
    model = repo / THREAT_MODEL
    threats = set(ID_PATTERNS["Threats"].findall(model.read_text())) if model.is_file() else set()
    return {
        "Controls": (_toml_ids(repo / CONTROL_REGISTER, "control"), CONTROL_REGISTER),
        "Threats": (threats, THREAT_MODEL),
        "Waivers": (_toml_ids(repo / WAIVER_REGISTER, "waiver"), WAIVER_REGISTER),
    }


def check(repo: Path, tier: str, body: str) -> list[str]:
    """The problems of one pull request body at one tier; an empty list passes."""
    if tier not in TIERS:
        raise SectionError(f"tier must be one of {', '.join(TIERS)}, not {tier!r}")
    match = SECTION.search(body)
    if not match:
        return [f"a {tier} pull request needs a ## Security section"] if tier in REQUIRED_TIERS else []
    values = {name.strip(): value.strip() for name, value in FIELD_LINE.findall(match.group(1))}
    known = _known_ids(Path(repo))
    problems = []
    for field in FIELDS:
        if field not in values:
            problems.append(f"{field}: the field is missing from the Security section")
            continue
        value = values[field]
        if value.strip("`").lower() in PLACEHOLDERS:
            problems.append(f"{field}: give a value, or none; {value or 'an empty value'} is a placeholder")
            continue
        if value.lower() == "none":
            if field in NOT_NONE_AT_HIGH_TIERS and tier in REQUIRED_TIERS:
                problems.append(f"{field}: a {tier} pull request needs the tests that prove its controls")
            continue
        if field in ID_PATTERNS:
            ids = ID_PATTERNS[field].findall(value)
            if not ids:
                problems.append(f"{field}: give IDs such as {ID_EXAMPLES[field]}, or none")
            ids_known, source = known[field]
            problems += [f"{field}: {i} is not in {source.as_posix()}" for i in ids if i not in ids_known]
    return problems


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise SectionError(message)


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = _Parser(prog="pr_sections.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    check_cmd = commands.add_parser("check")
    check_cmd.add_argument("--repo", default=".")
    check_cmd.add_argument("--tier", required=True)
    check_cmd.add_argument("--body-file", required=True)
    try:
        args = parser.parse_args(argv)
        repo = Path(args.repo)
        if args.tier not in TIERS:
            raise SectionError(f"tier must be one of {', '.join(TIERS)}, not {args.tier!r}")
        skipped = skip_unless(repo, "security_section")
        if skipped:
            stdout.write(json.dumps(skipped) + "\n")
            return 0
        try:
            body = Path(args.body_file).read_text()
        except OSError as error:
            raise SectionError(f"the body file cannot be read: {error}") from error
        problems = check(repo, args.tier, body)
    except (SectionError, ConfigError) as error:
        stderr.write(json.dumps({"error": str(error)}) + "\n")
        return 2
    stdout.write(json.dumps({"tier": args.tier, "problems": problems}, indent=2) + "\n")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
