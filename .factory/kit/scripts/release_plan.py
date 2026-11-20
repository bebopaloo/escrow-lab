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
  security --contents-file <json> --prs-file <json> --dependencies-file <json>
      The `## Security` section of the release PR body, as Markdown on stdout (the
      only command that prints text, not JSON). `contents` is the output of
      `contents`; `prs` is a list of the `pr view` output of each PR in it (the
      body is read from it); `dependencies` is the output of `dependencies.py
      added --base origin/production` on the release head. Controls, Threats and
      Waivers are the IDs in the Security sections of those PRs. Each new
      dependency is named with the PRs whose body names it. Residual risk lists
      the direct commits. Every field of pr_sections.FIELDS is set, and Tests is
      never `none`, so the section passes `pr_sections.py check` at `authority`.
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

  deferred --contents-file <json> --issues-file <json> --events-file <json> --operator <login>
           [--waivers-file <toml>] [--today YYYY-MM-DD]
      The Deferred finding check (Spec 106). `issues` is `issue list --state all
      --label deferred`. `events` maps the number of each CANCELLED Deferred
      finding issue to {"events": issue label-events, "comments": issue comments}.
      A finding is carried when a PR of its `Source PRs:` line is in `contents.prs`
      and its issue number is not in `contents.issues`. It is cleared when its
      issue is CANCELLED, the last `state:cancelled` event is the Operator's, and
      the Operator's last comment at or after the `time` of that event gives the
      reason. A comment or an event without a valid `time` does not count. Pass `--waivers-file` only with
      `waivers` on (the register from the main branch): the reason must then name
      a current Waiver. It fails closed: 100 issues (the adapter limit) or a body
      without a `Source PRs:` line fails. Prints {failed, lines, carried, cleared};
      exit code 1 when `failed`.

Prints one JSON document on stdout, except `security`. On an error: exit code 1 and
{"error": ...} on stderr.
"""

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import TextIO

import dependencies
import pr_sections
import risk_tier
import waivers as waiver_register
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


# deferred: a Release must not carry the source PR of a Deferred finding without its fix (Spec 106)

ISSUE_CAP = 100
SOURCE_PRS = re.compile(r"^Source PRs:[ \t]*(?P<list>.*)$", re.MULTILINE)
WAIVER_REF = re.compile(r"\bWAIVER-\d+\b")


def _time(value) -> datetime.datetime | None:
    """An ISO 8601 time as an aware datetime (UTC when it has no zone), or None when it is not one."""
    try:
        moment = datetime.datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc)


def _written_since(comment: dict, moment: datetime.datetime) -> bool:
    written = _time(comment.get("time"))
    return written is not None and written >= moment


def _cleared(number: int, evidence: dict, operator: str, entries: list[dict] | None, today: datetime.date) -> dict | None:
    added = [e for e in evidence.get("events", []) if e["label"] == "state:cancelled" and e["action"] == "added"]
    if not added or added[-1]["author"] != operator:
        return None
    cancelled_at = _time(added[-1].get("time"))
    if cancelled_at is None:
        return None
    # Only a reason that the Operator wrote at or after the last cancel counts, so an old reason cannot clear a new cancel.
    comments = [
        c for c in evidence.get("comments", [])
        if c["author"] == operator and c["body"].strip() and _written_since(c, cancelled_at)
    ]
    if not comments:
        return None
    reason = comments[-1]["body"].strip()
    waiver = None
    if entries is not None:
        current = {w.get("id") for w in waiver_register.current(entries, today)}
        named = [w for w in WAIVER_REF.findall(reason) if w in current]
        if not named:
            return None
        waiver = named[0]
    return {"issue": number, "by": operator, "reason": reason, "waiver": waiver}


def deferred(plan: dict, issues: list[dict], events: dict, operator: str, waivers: list[dict] | None, today: datetime.date) -> dict:
    """Check the Deferred findings against `contents`. `waivers` is None with the waivers module off."""
    if len(issues) >= ISSUE_CAP:
        return {"failed": True, "lines": ["too many Deferred finding issues to check"], "carried": [], "cleared": []}
    in_release = {pr["number"] for pr in plan["prs"]}
    shipped = set(plan["issues"])
    carried, cleared, lines = [], [], []
    for issue in sorted((i for i in issues if "deferred" in i["labels"]), key=lambda i: i["number"]):
        number = issue["number"]
        line = SOURCE_PRS.search(issue.get("body") or "")
        sources = [int(n) for n in re.findall(r"#(\d+)", line["list"])] if line else []
        if not sources:
            carried.append({"issue": number, "title": issue["title"], "source_prs": []})
            lines.append(f"#{number} {issue['title']}: the body has no `Source PRs:` line with a PR, so the check cannot clear it")
            continue
        if number in shipped or not in_release.intersection(sources):
            continue
        if issue["issue_state"] == "CANCELLED":
            clearance = _cleared(number, events.get(str(number), {}), operator, waivers, today)
            if clearance:
                cleared.append(clearance)
                continue
        carried.append({"issue": number, "title": issue["title"], "source_prs": sources})
        carrying = ", ".join(f"#{n}" for n in sources if n in in_release)
        lines.append(f"#{number} {issue['title']}: the Release carries PR {carrying} without the fix issue #{number}")
    return {"failed": bool(carried), "lines": lines, "carried": carried, "cleared": cleared}


# security: the Security section of the release PR body (ADR 0014)

DEPENDENCY_FIELD = dependencies.FIELD


def _security_fields(body: str) -> dict[str, str]:
    match = pr_sections.SECTION.search(body)
    return {name.strip(): value.strip() for name, value in pr_sections.FIELD_LINE.findall(match.group(1))} if match else {}


def _ids(field: str, fields: list[dict[str, str]]) -> str:
    found = sorted({i for values in fields for i in pr_sections.ID_PATTERNS[field].findall(values.get(field, ""))})
    return ", ".join(found) or "none"


def security(plan: dict, prs: list[dict], added: list[dict]) -> str:
    """The `## Security` section for the release PR body. See the `security` command."""
    bodies = {pr["number"]: pr.get("body") or "" for pr in prs}
    numbers = sorted({pr["number"] for pr in plan["prs"]})
    missing = [n for n in numbers if n not in bodies]
    if missing:
        raise PlanError("the prs file has no body for " + ", ".join(f"#{n}" for n in missing))
    fields = {n: _security_fields(bodies[n]) for n in numbers}
    named = []
    for name in sorted({dep["name"] for dep in added}, key=str.lower):
        owners = [n for n in numbers if dependencies.is_named(name, fields[n].get(DEPENDENCY_FIELD, ""))]
        named.append(f"{name} ({', '.join(f'PR #{n}' for n in owners) or 'no pull request names it'})")
    direct = plan["direct_commits"]
    residual = (
        f"{len(direct)} direct commit{'s have' if len(direct) != 1 else ' has'} no pull request and no Machine gate: "
        + "; ".join(f"{c['commit'][:12]} {' '.join(c['subject'].split())}" for c in direct)
        if direct else "none"
    )
    gates = (
        f"Each of the {len(numbers)} pull request{'s' if len(numbers) != 1 else ''} in the Release passed its Machine gate; "
        if numbers else "The Release has no pull request; "
    )
    tests = gates + "CI runs on the release head; review-release reviews the whole Release"
    values = {
        "Controls": _ids("Controls", list(fields.values())),
        "Threats": _ids("Threats", list(fields.values())),
        DEPENDENCY_FIELD: "; ".join(named) or "none",
        "Tests": tests,
        "Residual risk": residual,
        "Waivers": _ids("Waivers", list(fields.values())),
    }
    return "## Security\n" + "".join(f"- {field}: {values[field]}\n" for field in pr_sections.FIELDS)


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
    security_cmd = commands.add_parser("security")
    security_cmd.add_argument("--contents-file", required=True)
    security_cmd.add_argument("--prs-file", required=True)
    security_cmd.add_argument("--dependencies-file", required=True)
    deferred_cmd = commands.add_parser("deferred")
    for option in ("--contents-file", "--issues-file", "--events-file", "--operator"):
        deferred_cmd.add_argument(option, required=True)
    deferred_cmd.add_argument("--waivers-file")
    deferred_cmd.add_argument("--today")
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
        elif args.command == "deferred":
            today = datetime.date.fromisoformat(args.today) if args.today else datetime.datetime.now(datetime.UTC).date()
            entries = waiver_register.load_file(Path(args.waivers_file)) if args.waivers_file else None
            result = deferred(_read_json(args.contents_file), _read_json(args.issues_file), _read_json(args.events_file),
                              args.operator, entries, today)
            stdout.write(json.dumps(result, indent=2) + "\n")
            return 1 if result["failed"] else 0
        elif args.command == "security":
            stdout.write(security(_read_json(args.contents_file), _read_json(args.prs_file), _read_json(args.dependencies_file)))
            return 0
        elif args.command == "rollback-target":
            result = rollback_target(Path(args.repo), args.production)
        elif args.command == "eval-reports":
            result = eval_reports(Path(args.repo), args.base, args.head)
        else:
            result = tier(Path(args.repo), args.base, args.head, args.label_tier)
    except (PlanError, ConfigError, risk_tier.TierError, waiver_register.WaiverError, ValueError, KeyError) as error:
        stderr.write(json.dumps({"error": str(error)}) + "\n")
        return 1
    stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
