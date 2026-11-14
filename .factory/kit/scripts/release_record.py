# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Build the Release record of one Release (ADR 0014 and 0015, module release_record).

The Release record is the evidence for one version: each pull request in the
Release with its issue, Issue type, Risk tier and factory review record; the
Release approval; the Control traceability matrix; the current Waivers; the
SBOM digest; and the Control modules that were on. `gaps` lists what an
auditor would ask about. perform-release (ADR 0015, R4.3) attaches the record
to the forge release.

Commands:
  build --name vX.Y.Z --release-pr <n> --contents <json> --prs <json> --tier <json>
        [--approval <json>] [--matrix <json>] [--waivers <toml>] [--baseline <sha>]
        [--sbom-digest <digest>] [--modules <json>] [--today YYYY-MM-DD] [--format md|json]
      --contents is `release_plan.py contents`, --tier is `release_plan.py tier`,
      --approval is `release_approval.py check`, --matrix is
      `controls.py matrix --format json`, --modules is `factory_config.py
      validate`. --prs is a list of {number, title, issue, issue_type, tier,
      review_record}: review_record is the body of the factory's last review on
      that pull request. --baseline names the baseline commit of a first Release.
      Exit 0 when the record has no gaps, 1 when it has gaps, 2 on an error.
"""

import argparse
import datetime
import json
import re
import sys
from pathlib import Path
from typing import TextIO

import waivers as waiver_register

NAME = re.compile(r"^v\d+\.\d+\.\d+$")
NOT_PROVEN = ("failing", "untested")


class RecordError(Exception):
    pass


def _approval(approval: dict | None) -> dict | None:
    if approval is None or "skipped" in approval:
        return None
    review = approval.get("review") or {}
    approved = approval.get("required") and approval.get("approved")
    return {
        "required": bool(approval.get("required")),
        "approved_by": review.get("author") if approved else None,
        "time": review.get("time") if approved else None,
        "threshold": approval.get("threshold"),
    }


def build(name, release_pr, contents, prs, tier, approval, matrix, waivers, baseline, sbom_digest, modules, today) -> dict:
    gaps = []
    by_number = {pr["number"]: pr for pr in prs}
    rows = []
    for pr in contents["prs"]:
        data = by_number.get(pr["number"])
        if data is None:
            gaps.append(f"PR #{pr['number']} is in the Release, but no PR data was given for it")
            continue
        if not (data.get("review_record") or "").strip():
            gaps.append(f"PR #{pr['number']} has no factory review record")
        rows.append({**data, "commit": pr["commit"], "cherry_pick_of": pr.get("cherry_pick_of")})
    for commit in contents.get("direct_commits", []):
        gaps.append(f"commit {commit['commit'][:7]} ({commit['subject']}) reached the Release with no pull request and no Machine gate")

    recorded_approval = _approval(approval)
    if approval and approval.get("required") and not approval.get("approved"):
        gaps.append("the Release needs a Release approval and has none: " + "; ".join(approval.get("reasons") or []))

    controls = None
    if matrix is not None:
        rows_controls = matrix.get("controls", [])
        summary: dict[str, int] = {}
        for row in rows_controls:
            summary[row["status"]] = summary.get(row["status"], 0) + 1
            if row["status"] in NOT_PROVEN:
                gaps.append(f"Control {row['id']} is {row['status']}")
        controls = {"summary": summary, "controls": rows_controls}

    current = [
        {"id": w.get("id"), "covers": w.get("covers"), "expires": w["expires"].isoformat(), "approved_by": w.get("approved_by")}
        for w in waiver_register.current(waivers, today)
    ]
    release = {
        "name": name,
        "pull_request": release_pr,
        "base": contents["base"],
        "head": contents["head"],
        "tier": tier.get("tier") if tier else None,
    }
    if baseline:
        release["baseline"] = baseline
    return {
        "release": release,
        "pull_requests": rows,
        "direct_commits": contents.get("direct_commits", []),
        "release_approval": recorded_approval,
        "controls": controls,
        "waivers": current,
        "sbom_digest": sbom_digest,
        "control_modules": modules,
        "gaps": gaps,
    }


def _cell(value: object) -> str:
    return str(value if value is not None else "").replace("|", "\\|").replace("\n", " ")


def to_markdown(record: dict) -> str:
    r = record["release"]
    lines = [f"# Release record {r['name']}", ""]
    lines.append(f"- Release pull request: #{r['pull_request']}")
    lines.append(f"- Commits: `{r['base'][:7]}..{r['head'][:7]}`")
    lines.append(f"- Risk tier: {r['tier'] or 'off'}")
    if r.get("baseline"):
        lines.append(f"- Baseline (reviewed under the old G3): `{r['baseline']}`")
    if record["sbom_digest"]:
        lines.append(f"- SBOM: `{record['sbom_digest']}`")
    if record["control_modules"] is not None:
        lines.append(f"- Control modules: {', '.join(record['control_modules']) or 'none'}")

    lines += ["", "## Pull requests", "", "| PR | Title | Issue | Type | Tier | Review record |", "|---|---|---|---|---|---|"]
    for pr in record["pull_requests"]:
        issue = f"#{pr['issue']}" if pr.get("issue") else ""
        title = _cell(pr.get("title"))
        if pr.get("cherry_pick_of"):
            title += f" (cherry-pick of `{pr['cherry_pick_of'][:7]}`)"
        lines.append(f"| #{pr['number']} | {title} | {issue} | {_cell(pr.get('issue_type'))} | {_cell(pr.get('tier'))} | {_cell(pr.get('review_record'))} |")

    lines += ["", "## Release approval", ""]
    approval = record["release_approval"]
    if approval is None:
        lines.append("Not recorded: the `release_approval` module is off.")
    elif not approval["required"]:
        lines.append(f"Not required: the Release is below the `{approval['threshold']}` threshold.")
    elif approval["approved_by"]:
        lines.append(f"Approved by {approval['approved_by']} at {approval['time']}.")
    else:
        lines.append("Required, and missing.")

    lines += ["", "## Controls", ""]
    controls = record["controls"]
    if controls is None:
        lines.append("Not recorded: no traceability matrix was given.")
    else:
        lines += ["| Control | Title | Status |", "|---|---|---|"]
        lines += [f"| {c['id']} | {_cell(c['title'])} | {c['status']} |" for c in controls["controls"]]

    lines += ["", "## Waivers", ""]
    lines += [f"- {w['id']}: {_cell(json.dumps(w['covers']))}, until {w['expires']}, approved by {w['approved_by']}" for w in record["waivers"]] or ["None current."]

    lines += ["", "## Gaps", ""]
    lines += [f"- {gap}" for gap in record["gaps"]] or ["None."]
    return "\n".join(lines) + "\n"


def _json(path: str | None, what: str):
    if path is None:
        return None
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RecordError(f"the {what} file cannot be read: {error}") from error


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise RecordError(message)


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = _Parser(prog="release_record.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    b = commands.add_parser("build")
    for option in ("--name", "--contents", "--prs", "--tier"):
        b.add_argument(option, required=True)
    b.add_argument("--release-pr", type=int, required=True)
    for option in ("--approval", "--matrix", "--waivers", "--baseline", "--sbom-digest", "--modules", "--today"):
        b.add_argument(option)
    b.add_argument("--format", choices=("md", "json"), default="md")
    try:
        args = parser.parse_args(argv)
        if not NAME.match(args.name):
            raise RecordError(f"--name must be vX.Y.Z, not {args.name!r}")
        today = datetime.date.fromisoformat(args.today) if args.today else datetime.datetime.now(datetime.UTC).date()
        tier = _json(args.tier, "tier")
        modules = _json(args.modules, "modules")
        record = build(
            name=args.name,
            release_pr=args.release_pr,
            contents=_json(args.contents, "contents"),
            prs=_json(args.prs, "PR data"),
            tier=None if tier is None or "skipped" in tier else tier,
            approval=_json(args.approval, "approval"),
            matrix=_json(args.matrix, "matrix"),
            waivers=waiver_register.load_file(Path(args.waivers)) if args.waivers else [],
            baseline=args.baseline,
            sbom_digest=args.sbom_digest,
            modules=modules.get("modules") if isinstance(modules, dict) else None,
            today=today,
        )
    except (RecordError, waiver_register.WaiverError, KeyError, TypeError, ValueError) as error:
        stderr.write(json.dumps({"error": str(error)}) + "\n")
        return 2
    stdout.write(to_markdown(record) if args.format == "md" else json.dumps(record, indent=2) + "\n")
    return 1 if record["gaps"] else 0


if __name__ == "__main__":
    sys.exit(main())
