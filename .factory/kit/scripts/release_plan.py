# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Plan a Release from git: its PRs, issues, version and Risk tier (ADR 0015).

Commands:
  contents [--repo <path>] --base <ref> --head <ref>
      The PRs merged between production (--base) and the release branch or the
      main branch (--head), from their merge commits "Merge pull request #N from
      owner/<branch>". The issue of a PR is the number that starts its branch
      name, for example 7 in `7-add-login`. A cherry-pick (`git cherry-pick -x`)
      keeps the PR and names the commit it copies. A commit on the main line that
      no PR merged is a direct commit. Also lists the changed paths.
  version [--repo <path>] --production <ref> [--major | --hotfix]
      Propose the version of the next Release from the vX.Y.Z tags. A cut is the
      next minor (or major) version; the first is 0.1.0. A hotfix is the next
      patch of the line that production runs. Prints the release branch too.
  rollback-target [--repo <path>] --production <ref>
      The last good release tag to redeploy: the newest vX.Y.Z tag in
      production when its head has no release tag (its deploy failed), else
      the tag before the current one.
  summary --name vX.Y.Z --contents-file <json> --issues-file <json> --releases-file <json>
      Group the issues of `contents` by Issue type, and leave out the issues that
      another Release shipped. `issues` is a list of tracker Issues; `releases`
      is the tracker `release list`. `add` is the issues to add to the Release.
  tier [--repo <path>] --base <ref> --head <ref> [--label-tier <tier>]...
      The Risk tier of the whole Release: the highest tier of its changed paths
      and of its PRs' `risk:*` labels. With risk_tiers off it prints
      {"skipped": "risk_tiers is off"}.
  eval-reports [--repo <path>] --base <ref> --head <ref>
      Only in a Marketplace repo (ADR 0011). For each plugin that the Release
      changes, its version, its previous version, its tag `<plugin>-vX.Y.Z` and
      the newest committed report of a full eval run on that version. `missing`
      names a changed plugin with no such report; `unbumped` names a changed
      plugin whose version did not change. A report of a `--case` run or a
      partial run does not count. Elsewhere it prints
      {"skipped": "not a Marketplace repo"}.

Prints one JSON document on stdout. On an error: exit code 1 and
{"error": ...} on stderr.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import TextIO

import risk_tier
from factory_config import ConfigError, skip_unless

MERGE_SUBJECT = re.compile(r"^Merge pull request #(?P<number>\d+) from [^/\s]+/(?P<branch>\S+)$")
ISSUE_BRANCH = re.compile(r"^(?P<issue>\d+)-")
CHERRY_PICK = re.compile(r"\(cherry picked from commit (?P<sha>[0-9a-f]{40})\)")
VERSION_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
TYPES = ("feature", "fix", "chore")
TYPE_PREFIX = "type:"
FIELD, RECORD = "\x1f", "\x1e"


class PlanError(Exception):
    pass


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    if result.returncode != 0:
        raise PlanError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def _commit(repo: Path, ref: str) -> str:
    result = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], cwd=repo, capture_output=True, text=True)
    if result.returncode != 0:
        raise PlanError(f"unknown ref {ref}")
    return result.stdout.strip()


# contents


def contents(repo: Path, base: str, head: str) -> dict:
    base_sha, head_sha = _commit(repo, base), _commit(repo, head)
    span = f"{base_sha}..{head_sha}"
    main_line = set(_git(repo, "rev-list", "--first-parent", span).split())
    prs, direct = [], []
    log = _git(repo, "log", f"--format=%H{FIELD}%P{FIELD}%s{FIELD}%b{RECORD}", span)
    for record in filter(str.strip, log.split(RECORD)):
        sha, parents, subject, body = record.strip("\n").split(FIELD, 3)
        merge = MERGE_SUBJECT.match(subject)
        if merge:
            branch = merge["branch"]
            issue = ISSUE_BRANCH.match(branch)
            picked = CHERRY_PICK.search(body)
            prs.append({
                "number": int(merge["number"]),
                "branch": branch,
                "commit": sha,
                "issue": int(issue["issue"]) if issue else None,
                "cherry_pick_of": picked["sha"] if picked else None,
            })
        elif sha in main_line:
            direct.append({"commit": sha, "subject": subject})
    merge_base = _git(repo, "merge-base", base_sha, head_sha).strip()
    paths = sorted(filter(None, _git(repo, "diff", "--name-only", "--no-renames", merge_base, head_sha).splitlines()))
    prs.sort(key=lambda pr: pr["number"])
    return {
        "base": base_sha,
        "head": head_sha,
        "prs": prs,
        "issues": sorted({pr["issue"] for pr in prs if pr["issue"] is not None}),
        "direct_commits": list(reversed(direct)),
        "paths": paths,
    }


# version


def _versions(tags: str) -> list[tuple[int, int, int]]:
    return [tuple(int(part) for part in match.groups()) for match in map(VERSION_TAG.match, tags.split()) if match]


def _tag(version: tuple[int, int, int]) -> str:
    return "v{}.{}.{}".format(*version)


def version(repo: Path, production: str, major: bool = False, hotfix: bool = False) -> dict:
    if major and hotfix:
        raise PlanError("a hotfix is a patch version; it cannot be major")
    every = _versions(_git(repo, "tag", "--list"))
    if hotfix:
        shipped = _versions(_git(repo, "tag", "--list", "--merged", _commit(repo, production)))
        if not shipped:
            raise PlanError(f"{production} has no release tag, so there is no line to hotfix")
        x, y, _ = current = max(shipped)
        patch = max(v[2] for v in every if v[:2] == (x, y)) + 1
        proposal, previous = (x, y, patch), _tag(current)
    elif not every:
        proposal, previous = (0, 1, 0), None
    else:
        highest = max(every)
        proposal = (highest[0] + 1, 0, 0) if major else (highest[0], highest[1] + 1, 0)
        previous = _tag(highest)
    return {"version": "{}.{}.{}".format(*proposal), "branch": f"release/{proposal[0]}.{proposal[1]}", "previous": previous}


# rollback target (ADR 0015, R5)


def rollback_target(repo: Path, production: str) -> dict:
    """The last good release tag. When the production head has no release tag, its deploy failed in
    perform-release, so the newest tag in production is still good. Else the tag before the current one."""
    head = _commit(repo, production)
    shipped = sorted(_versions(_git(repo, "tag", "--list", "--merged", head)), reverse=True)
    on_head = _versions(_git(repo, "tag", "--points-at", head))
    current = max(on_head) if on_head else None
    earlier = [v for v in shipped if current is None or v < current]
    if not earlier:
        raise PlanError(f"{production} has no earlier release to roll back to")
    return {"target": _tag(earlier[0]), "current": _tag(current) if current else None, "production": head}


# summary


def _type_of(issue: dict) -> str:
    types = [label[len(TYPE_PREFIX):] for label in issue["labels"] if label.startswith(TYPE_PREFIX)]
    known = [t for t in types if t in TYPES]
    if len(types) > 1:
        raise PlanError(f"#{issue['number']} has more than one type label: {', '.join(types)}")
    return known[0] if known else "untyped"


def summary(plan: dict, issues: list[dict], releases: list[dict], name: str) -> dict:
    by_number = {issue["number"]: issue for issue in issues}
    missing = [n for n in plan["issues"] if n not in by_number]
    if missing:
        raise PlanError("the issues file has no " + ", ".join(f"#{n}" for n in missing))
    shipped = {n for release in releases if release["name"] != name for n in release["issues"]}
    current = {n for release in releases if release["name"] == name for n in release["issues"]}
    remaining = [n for n in plan["issues"] if n not in shipped]
    types: dict[str, list[int]] = {t: [] for t in (*TYPES, "untyped")}
    for number in remaining:
        types[_type_of(by_number[number])].append(number)
    return {
        "name": name,
        "types": types,
        "add": [n for n in remaining if n not in current],
        "already_released": sorted(shipped.intersection(plan["issues"])),
        "prs_without_issue": [pr["number"] for pr in plan["prs"] if pr["issue"] is None],
        "cherry_picks": [
            {"number": pr["number"], "commit": pr["commit"], "cherry_pick_of": pr["cherry_pick_of"]}
            for pr in plan["prs"] if pr["cherry_pick_of"]
        ],
        "direct_commits": plan["direct_commits"],
    }


# eval reports (ADR 0011): a Marketplace Release ships only plugin versions with a full layer 3 report

MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json"
PLUGIN_PATH = re.compile(r"^plugins/(?P<name>[^/]+)/(?P<rest>.+)$")
REPORT_PATH = re.compile(r"^plugins/(?P<name>[^/]+)/evals/results/[^/]+/aggregate-result\.json$")


def _show(repo: Path, sha: str, path: str) -> str | None:
    result = subprocess.run(["git", "show", f"{sha}:{path}"], cwd=repo, capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def _plugin_version(repo: Path, sha: str, name: str) -> str | None:
    text = _show(repo, sha, f"plugins/{name}/.claude-plugin/plugin.json")
    try:
        return json.loads(text).get("version") if text else None
    except json.JSONDecodeError as error:
        raise PlanError(f"plugins/{name}/.claude-plugin/plugin.json at {sha[:12]} is not valid JSON") from error


def _full_report(repo: Path, sha: str, name: str, version: str) -> str | None:
    """The newest committed report of a full run on this plugin version: no case filter, not partial."""
    paths = [p for p in _git(repo, "ls-tree", "-r", "--name-only", sha, f"plugins/{name}/evals/results/").splitlines() if REPORT_PATH.match(p)]
    for path in sorted(paths, reverse=True):
        try:
            report = json.loads(_show(repo, sha, path) or "")
        except json.JSONDecodeError:
            continue
        suite = report.get("suite") or {}
        plugins = {(p.get("name"), p.get("version")) for p in suite.get("plugins") or []}
        if (name, version) in plugins and not report.get("partial") and not suite.get("caseFilter"):
            return path
    return None


def eval_reports(repo: Path, base: str, head: str) -> dict:
    base_sha, head_sha = _commit(repo, base), _commit(repo, head)
    if _show(repo, head_sha, MARKETPLACE_MANIFEST) is None:
        return {"skipped": "not a Marketplace repo"}
    plan = contents(repo, base_sha, head_sha)
    changed = sorted({
        match["name"] for match in map(PLUGIN_PATH.match, plan["paths"])
        if match and not match["rest"].startswith("evals/results/")
    })
    plugins, missing, unbumped = [], [], []
    for name in changed:
        version, previous = _plugin_version(repo, head_sha, name), _plugin_version(repo, base_sha, name)
        if version is None:
            continue  # the Release removes the plugin
        found = _full_report(repo, head_sha, name, version)
        plugins.append({"name": name, "version": version, "previous": previous, "report": found, "tag": f"{name}-v{version}"})
        if version == previous:
            unbumped.append(name)
        elif found is None:
            missing.append(name)
    return {"plugins": plugins, "missing": missing, "unbumped": unbumped}


# tier


def tier(repo: Path, base: str, head: str, label_tiers: list[str]) -> dict:
    skipped = skip_unless(repo, "risk_tiers")
    if skipped:
        return skipped
    for label in label_tiers:
        if label not in risk_tier.TIERS:
            raise PlanError(f"unknown label tier {label}; use one of {', '.join(risk_tier.TIERS)}")
    label = min(label_tiers, key=risk_tier.TIERS.index) if label_tiers else None
    return risk_tier.classify(repo, contents(repo, base, head)["paths"], label)


# the command line


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise PlanError(message)


def _read_json(path: str):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise PlanError(f"cannot read {path}: {error}") from error


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="release_plan.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    for name in ("contents", "tier", "eval-reports"):
        command = commands.add_parser(name)
        command.add_argument("--repo", default=".")
        command.add_argument("--base", required=True)
        command.add_argument("--head", required=True)
        if name == "tier":
            command.add_argument("--label-tier", action="append", default=[])
    version_cmd = commands.add_parser("version")
    version_cmd.add_argument("--repo", default=".")
    version_cmd.add_argument("--production", required=True)
    version_cmd.add_argument("--major", action="store_true")
    version_cmd.add_argument("--hotfix", action="store_true")
    rollback_cmd = commands.add_parser("rollback-target")
    rollback_cmd.add_argument("--repo", default=".")
    rollback_cmd.add_argument("--production", required=True)
    summary_cmd = commands.add_parser("summary")
    summary_cmd.add_argument("--name", required=True)
    summary_cmd.add_argument("--contents-file", required=True)
    summary_cmd.add_argument("--issues-file", required=True)
    summary_cmd.add_argument("--releases-file", required=True)
    return parser


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    try:
        args = build_parser().parse_args(argv)
        if args.command == "contents":
            result = contents(Path(args.repo), args.base, args.head)
        elif args.command == "version":
            result = version(Path(args.repo), args.production, major=args.major, hotfix=args.hotfix)
        elif args.command == "summary":
            plan = _read_json(args.contents_file)
            result = summary(plan, _read_json(args.issues_file), _read_json(args.releases_file), args.name)
        elif args.command == "rollback-target":
            result = rollback_target(Path(args.repo), args.production)
        elif args.command == "eval-reports":
            result = eval_reports(Path(args.repo), args.base, args.head)
        else:
            result = tier(Path(args.repo), args.base, args.head, args.label_tier)
    except (PlanError, ConfigError, risk_tier.TierError) as error:
        stderr.write(json.dumps({"error": str(error)}) + "\n")
        return 1
    stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
