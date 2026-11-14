# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Give a change its Risk tier from the paths it changes (ADR 0014, module risk_tiers).

Commands:
  validate [--repo <path>]
      Check _context/controls/risk-map.toml: its schema, and that each glob
      matches at least one tracked file.
  classify [--repo <path>] (--base <ref> | --path <path>...) [--label-tier <tier>]
      Print the tier of the change. With --base, the paths come from
      `git diff --name-only --no-renames <merge-base> HEAD`, so a deleted or
      renamed file counts at its old path too. --label-tier is the tier of the
      PR's `risk:*` label, from a verified escalation: the result is the higher
      of the two, so a label can raise the tier but never lower it.

Rules:
  - Each path gets the highest tier of the globs that match it. A path that no
    glob matches is general.
  - Built-in floors make some paths at least sensitive, whatever the map says.
  - A changed .sql file whose SQL drops, renames or tightens what old code reads
    (DROP TABLE/COLUMN/..., RENAME, ALTER COLUMN ... TYPE, SET NOT NULL, TRUNCATE,
    DELETE FROM) is at least sensitive, with the rule `destructive-migration`,
    because a rollback runs old code against the new schema (ADR 0015).
  - The change gets the highest tier of its paths. No path: inert.
  - `boundaries` lists each [[boundary]] (a TB- ID of the Threat model) that a
    changed path is in, and `threat_model_changed` says whether the change
    edits _context/threat-model.md (work item C7).

With the module off, both commands print {"skipped": "risk_tiers is off"} and
exit 0. Prints one JSON document on stdout. On an error: exit code 1 and
{"error": ..., "problems": [...]} on stderr.
"""

import argparse
import json
import re
import subprocess
import sys
import tomllib
from functools import lru_cache
from pathlib import Path
from typing import TextIO

from factory_config import ConfigError, skip_unless

TIERS = ("authority", "sensitive", "general", "inert")  # the order of risk: authority is the highest
DEFAULT_TIER = "general"
EMPTY_TIER = "inert"
MAP_PATH = Path("_context") / "controls" / "risk-map.toml"
TEMPLATE = Path(__file__).resolve().parents[1] / "templates" / "controls" / "risk-map.toml"
TIER_KEYS = {"name", "paths"}
BOUNDARY_KEYS = {"id", "paths"}
BOUNDARY_ID = re.compile(r"^TB-\d+$")
THREAT_MODEL = "_context/threat-model.md"
# Built-in floors (ADR 0014): a repo map cannot lower these paths below sensitive.
FLOOR_TIER = "sensitive"
FLOORS = (
    ".github/**",
    ".claude/**",
    ".factory/**",
    "_context/controls/**",
    "_context/threat-model.md",
    "**/package.json",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/pnpm-workspace.yaml",
    "**/yarn.lock",
    "**/.npmrc",
    "**/pyproject.toml",
    "**/uv.lock",
    "**/requirements*.txt",
    "**/go.mod",
    "**/go.sum",
    "**/Cargo.toml",
    "**/Cargo.lock",
    # Infrastructure as code (work item C12): a change to the cloud is never general.
    "**/*.tf",
    "**/*.tfvars",
    "**/.terraform.lock.hcl",
)


class TierError(Exception):
    def __init__(self, problems: list[str] | str):
        self.problems = [problems] if isinstance(problems, str) else problems
        super().__init__("; ".join(self.problems))


# globs


@lru_cache(maxsize=None)
def _glob_regex(glob: str) -> re.Pattern:
    """`**/` is zero or more folders, `**` is anything, `*` and `?` stop at a slash."""
    out, index = [], 0
    while index < len(glob):
        if glob.startswith("**/", index):
            out.append("(?:.*/)?")
            index += 3
        elif glob.startswith("**", index):
            out.append(".*")
            index += 2
        elif glob[index] == "*":
            out.append("[^/]*")
            index += 1
        elif glob[index] == "?":
            out.append("[^/]")
            index += 1
        else:
            out.append(re.escape(glob[index]))
            index += 1
    return re.compile("".join(out) + r"\Z")


def glob_matches(glob: str, path: str) -> bool:
    return bool(_glob_regex(glob).match(path))


def _rank(tier: str) -> int:
    return TIERS.index(tier)


def _higher(first: str, second: str) -> str:
    return first if _rank(first) <= _rank(second) else second


# the map


def load_rules(repo: Path) -> list[tuple[str, str]]:
    """The (tier, glob) rules of the repo's map, after the schema checks."""
    path = Path(repo) / MAP_PATH
    if not path.is_file():
        raise TierError(f"risk_tiers is on, but {MAP_PATH} is missing")
    try:
        data = tomllib.loads(path.read_text())
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise TierError(f"{MAP_PATH} cannot be read: {error}") from error
    tiers = data.get("tier", [])
    if not isinstance(tiers, list):
        raise TierError(f"{MAP_PATH}: tier must be a list of [[tier]] tables")
    problems, rules, names, seen = [], [], [], {}
    for entry in tiers:
        if not isinstance(entry, dict):
            problems.append("each [[tier]] must be a table")
            continue
        name = entry.get("name")
        problems += [f"{name}: unknown key {key}" for key in entry if key not in TIER_KEYS]
        if name not in TIERS:
            problems.append(f"unknown tier {name}; use one of {', '.join(TIERS)}")
            continue
        if name in names:
            problems.append(f"{name} is listed more than once")
        names.append(name)
        paths = entry.get("paths")
        if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
            problems.append(f"{name} has no paths: give a list of globs")
            continue
        for glob in paths:
            if glob in seen and seen[glob] != name:
                problems.append(f"{glob} is in more than one tier ({seen[glob]} and {name})")
            seen[glob] = name
            rules.append((name, glob))
    if problems:
        raise TierError(problems)
    return rules


def load_boundaries(repo: Path) -> list[tuple[str, str]]:
    """The (TB- ID, glob) pairs of the Risk map's [[boundary]] tables, after the schema checks."""
    path = Path(repo) / MAP_PATH
    if not path.is_file():
        return []
    try:
        data = tomllib.loads(path.read_text())
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise TierError(f"{MAP_PATH} cannot be read: {error}") from error
    entries = data.get("boundary", [])
    if not isinstance(entries, list):
        raise TierError(f"{MAP_PATH}: boundary must be a list of [[boundary]] tables")
    problems, pairs, ids = [], [], []
    for entry in entries:
        if not isinstance(entry, dict):
            problems.append("each [[boundary]] must be a table")
            continue
        boundary = entry.get("id")
        if not isinstance(boundary, str) or not BOUNDARY_ID.match(boundary):
            problems.append(f"{boundary} is not a trust boundary ID like TB-2")
            continue
        if boundary in ids:
            problems.append(f"{boundary} is listed more than once")
        ids.append(boundary)
        problems += [f"{boundary}: unknown key {key}" for key in entry if key not in BOUNDARY_KEYS]
        paths = entry.get("paths")
        if not isinstance(paths, list) or not paths or not all(isinstance(g, str) and g for g in paths):
            problems.append(f"{boundary} has no paths: give a list of globs")
            continue
        pairs += [(boundary, glob) for glob in paths]
    if problems:
        raise TierError(problems)
    return pairs


def _tracked_files(repo: Path) -> list[str]:
    return _git(repo, "ls-files").splitlines()


def validate(repo: Path) -> list[str]:
    try:
        rules = load_rules(repo)
    except TierError as error:
        return error.problems
    try:
        boundaries = load_boundaries(repo)
    except TierError as error:
        return error.problems
    files = _tracked_files(repo)
    return [f"{glob} in {owner} matches no file" for owner, glob in rules + boundaries
            if not any(glob_matches(glob, f) for f in files)]


# classification


def tier_of(path: str, rules: list[tuple[str, str]]) -> tuple[str, str]:
    """The tier of one path and the rule that set it."""
    best = None
    for tier, glob in rules:
        if glob_matches(glob, path) and (best is None or _rank(tier) < _rank(best[0])):
            best = (tier, glob)
    for glob in FLOORS:
        if glob_matches(glob, path) and (best is None or _rank(FLOOR_TIER) < _rank(best[0])):
            best = (FLOOR_TIER, f"floor:{glob}")
    return best or (DEFAULT_TIER, "default")


# Destructive migrations (ADR 0015, R9). A rollback runs the code of the last good tag against the
# new schema, so a change that drops, renames or tightens what old code reads needs the Release
# approval. The check reads the SQL of each changed .sql file in the checkout, without comments.
SQL_COMMENTS = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)
DESTRUCTIVE_SQL = re.compile(
    r"\bDROP\s+(?:TABLE|COLUMN|SCHEMA|TYPE|VIEW|CONSTRAINT|SEQUENCE|MATERIALIZED\s+VIEW)\b"
    r"|\bRENAME\b"
    r"|\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b"
    r"|\bSET\s+NOT\s+NULL\b"
    r"|\bTRUNCATE\b"
    r"|\bDELETE\s+FROM\b",
    re.IGNORECASE,
)
DESTRUCTIVE_RULE = "destructive-migration"


def destructive_sql(text: str) -> list[str]:
    """The destructive statements in a migration, comments left out."""
    return [match.group(0) for match in DESTRUCTIVE_SQL.finditer(SQL_COMMENTS.sub(" ", text))]


def _migration_floor(repo: Path, path: str, tier: str, rule: str) -> tuple[str, str]:
    if not path.endswith(".sql") or _rank(tier) <= _rank(FLOOR_TIER):
        return tier, rule
    try:
        text = (repo / path).read_text(errors="replace")
    except OSError:
        return tier, rule  # a deleted file counts by its path only
    return (FLOOR_TIER, DESTRUCTIVE_RULE) if destructive_sql(text) else (tier, rule)


def classify(repo: Path, paths: list[str], label_tier: str | None) -> dict:
    if label_tier is not None and label_tier not in TIERS:
        raise TierError(f"unknown label tier {label_tier}; use one of {', '.join(TIERS)}")
    rules = load_rules(repo)
    by_tier: dict[str, list[str]] = {}
    reasons_by_tier: dict[str, list[dict]] = {}
    for path in sorted(set(paths)):
        tier, rule = _migration_floor(repo, path, *tier_of(path, rules))
        by_tier.setdefault(tier, []).append(path)
        reasons_by_tier.setdefault(tier, []).append({"path": path, "tier": tier, "rule": rule})
    path_tier = min(by_tier, key=_rank) if by_tier else EMPTY_TIER
    tier = _higher(path_tier, label_tier) if label_tier else path_tier
    return {
        "tier": tier,
        "path_tier": path_tier,
        "label_tier": label_tier,
        "source": "paths" if tier == path_tier else "escalation",
        "paths": {t: by_tier[t] for t in TIERS if t in by_tier},
        "reasons": reasons_by_tier.get(path_tier, []),
        "boundaries": _crossed(load_boundaries(repo), sorted(set(paths))),
        "threat_model_changed": THREAT_MODEL in paths,
    }


def _crossed(boundaries: list[tuple[str, str]], paths: list[str]) -> list[dict]:
    """Each trust boundary that a changed path is in, with those paths."""
    crossed: dict[str, list[str]] = {}
    for boundary, glob in boundaries:
        for path in paths:
            if glob_matches(glob, path) and path not in crossed.setdefault(boundary, []):
                crossed[boundary].append(path)
    return [{"id": b, "paths": found} for b, found in crossed.items() if found]


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    if result.returncode != 0:
        raise TierError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def changed_paths(repo: Path, base: str) -> list[str]:
    merge_base = _git(repo, "merge-base", base, "HEAD").strip()
    return [line for line in _git(repo, "diff", "--name-only", "--no-renames", merge_base, "HEAD").splitlines() if line]


# the command line


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise TierError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="risk_tier.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    commands.add_parser("validate").add_argument("--repo", default=".")
    classify_cmd = commands.add_parser("classify")
    classify_cmd.add_argument("--repo", default=".")
    classify_cmd.add_argument("--base")
    classify_cmd.add_argument("--path", action="append", default=[])
    classify_cmd.add_argument("--label-tier")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    try:
        args = build_parser().parse_args(argv)
        repo = Path(args.repo)
        skipped = skip_unless(repo, "risk_tiers")
        if skipped:
            result = skipped
        elif args.command == "validate":
            problems = validate(repo)
            if problems:
                raise TierError(problems)
            result = {"valid": True}
        else:
            if bool(args.base) == bool(args.path):
                raise TierError("give either --base <ref> or one or more --path")
            paths = changed_paths(repo, args.base) if args.base else args.path
            result = classify(repo, paths, args.label_tier)
    except (TierError, ConfigError) as error:
        stderr.write(json.dumps({"error": str(error), "problems": error.problems}) + "\n")
        return 1
    stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
