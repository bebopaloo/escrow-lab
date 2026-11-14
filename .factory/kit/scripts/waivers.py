# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""The Waiver register (ADR 0014, module waivers).

A Waiver is a recorded, time-limited acceptance of one risk. Only a person
writes one: the guard hook and the deny rules stop the factory from writing
_context/controls/waivers.toml.

Commands:
  check [--repo <path>] [--today YYYY-MM-DD]
      Check the register: the schema, unique IDs, what each Waiver covers, and
      its dates. A Waiver that has expired, has no expiry date, or lasts longer
      than the `waiver_max_days` setting fails. Prints the current Waivers.

A Waiver covers one of:
  kind = "finding"  file, category and an optional ref: a review finding
  kind = "check"    name: a CI check
  kind = "control"  id: a Control that is not met yet

With the module off, prints {"skipped": "waivers is off"} and exits 0. A
missing register is an empty register. On an error: exit code 1 and
{"error": ..., "problems": [...]} on stderr.
"""

import argparse
import datetime
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import TextIO

from factory_config import ConfigError, resolve_repo, skip_unless

REGISTER = Path("_context") / "controls" / "waivers.toml"
TEMPLATE = Path(__file__).resolve().parents[1] / "templates" / "controls" / "waivers.toml"
WAIVER_ID = re.compile(r"^WAIVER-\d+$")
KEYS = {"id", "reason", "risk", "owner", "approved_by", "created", "expires", "covers"}
REQUIRED = ("reason", "risk", "owner", "approved_by")
COVER_KEYS = {
    "finding": ({"kind", "file", "category", "ref"}, ("file", "category")),
    "check": ({"kind", "name"}, ("name",)),
    "control": ({"kind", "id"}, ("id",)),
}


class WaiverError(Exception):
    def __init__(self, problems: list[str] | str):
        self.problems = [problems] if isinstance(problems, str) else problems
        super().__init__("; ".join(self.problems))


def load_file(path: Path) -> list[dict]:
    """The [[waiver]] tables of one file. A missing file has none."""
    path = Path(path)
    if not path.is_file():
        return []
    try:
        return load_text(path.read_text())
    except OSError as error:
        raise WaiverError(f"{path.name} cannot be read: {error}") from error
    except WaiverError as error:
        raise WaiverError(f"{path.name} cannot be read: {error}") from error


def load_text(text: str) -> list[dict]:
    """The [[waiver]] tables of a TOML text."""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise WaiverError(str(error)) from error
    entries = data.get("waiver", [])
    if not isinstance(entries, list):
        raise WaiverError("waiver must be a list of [[waiver]] tables")
    return entries


def load(repo: Path) -> list[dict]:
    return load_file(Path(repo) / REGISTER)


def max_days(repo: Path) -> int:
    return resolve_repo(Path(repo))["settings"]["waiver_max_days"]


def _date(value: object) -> datetime.date | None:
    return value if isinstance(value, datetime.date) and not isinstance(value, datetime.datetime) else None


def check(entries: list[dict], today: datetime.date, limit: int) -> list[str]:
    problems, seen = [], set()
    for entry in entries:
        if not isinstance(entry, dict):
            problems.append("each [[waiver]] must be a table")
            continue
        waiver = entry.get("id")
        if not isinstance(waiver, str) or not WAIVER_ID.match(waiver):
            problems.append(f"{waiver} is not a Waiver ID like WAIVER-7")
            continue
        if waiver in seen:
            problems.append(f"{waiver} is listed more than once")
        seen.add(waiver)
        problems += [f"{waiver}: unknown key {key}" for key in entry if key not in KEYS]
        problems += [f"{waiver}: {key} is missing" for key in REQUIRED if not entry.get(key)]
        problems += _cover_problems(waiver, entry.get("covers"))
        created, expires = entry.get("created"), entry.get("expires")
        if created is not None and _date(created) is None:
            problems.append(f"{waiver}: created must be a date, such as 2026-11-14")
            continue
        if created is None:
            problems.append(f"{waiver}: created is missing")
        if expires is None:
            problems.append(f"{waiver} has no expires date")
            continue
        if _date(expires) is None:
            problems.append(f"{waiver}: expires must be a date, such as 2027-01-31")
            continue
        if expires <= today:
            problems.append(f"{waiver} expired on {expires.isoformat()}")
        if created is not None:
            if expires < created:
                problems.append(f"{waiver} expires before it was created")
            elif (expires - created).days > limit:
                problems.append(f"{waiver} lasts {(expires - created).days} days; the limit is {limit}")
    return problems


def _cover_problems(waiver: str, covers: object) -> list[str]:
    if not isinstance(covers, dict):
        return [f"{waiver}: covers is missing; give a [waiver.covers] table"]
    kind = covers.get("kind")
    if kind not in COVER_KEYS:
        return [f"{waiver}: covers.kind must be finding, check or control"]
    allowed, required = COVER_KEYS[kind]
    problems = [f"{waiver}: unknown key covers.{key}" for key in covers if key not in allowed]
    problems += [f"{waiver}: a {kind} waiver needs covers.{key}" for key in required if not covers.get(key)]
    return problems


def current(entries: list[dict], today: datetime.date) -> list[dict]:
    """The Waivers that have not expired, in register order."""
    return [e for e in entries if isinstance(e, dict) and _date(e.get("expires")) and e["expires"] > today]


def covering(finding: dict, entries: list[dict], today: datetime.date) -> str | None:
    """The ID of the first current finding Waiver that covers this verified finding, or None."""
    for entry in current(entries, today):
        covers = entry.get("covers") or {}
        if covers.get("kind") != "finding":
            continue
        if covers.get("file") != finding.get("file") or covers.get("category") != finding.get("category"):
            continue
        if covers.get("ref") and covers["ref"] not in (finding.get("refs") or []):
            continue
        return entry.get("id")
    return None


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise WaiverError(message)


def _today(value: str | None) -> datetime.date:
    if value is None:
        return datetime.datetime.now(datetime.UTC).date()
    try:
        return datetime.date.fromisoformat(value)
    except ValueError as error:
        raise WaiverError(f"--today must be YYYY-MM-DD, not {value!r}") from error


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = _Parser(prog="waivers.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    check_cmd = commands.add_parser("check")
    check_cmd.add_argument("--repo", default=".")
    check_cmd.add_argument("--today")
    try:
        args = parser.parse_args(argv)
        repo = Path(args.repo)
        skipped = skip_unless(repo, "waivers")
        if skipped:
            stdout.write(json.dumps(skipped) + "\n")
            return 0
        today = _today(args.today)
        entries = load(repo)
        problems = check(entries, today, max_days(repo))
        if problems:
            raise WaiverError(problems)
        stdout.write(json.dumps({"valid": True, "current": [e["id"] for e in current(entries, today)]}) + "\n")
    except (WaiverError, ConfigError) as error:
        stderr.write(json.dumps({"error": str(error), "problems": error.problems}) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
