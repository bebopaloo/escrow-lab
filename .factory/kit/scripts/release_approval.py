# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Decide the Release approval of one release pull request (ADR 0014 and 0015, module release_approval).

A release pull request into `production` needs a Release approval when its
Risk tier is at or above the `release_approval_threshold` setting (default
`sensitive`). A valid Release approval is a review that:
  - has the state `approved`;
  - is by the Operator (the `operator` login in .claude/factory.json), never a bot;
  - is on the current head commit of the release pull request;
  - has a body that starts with the `release_approval_text` setting.
The Operator's latest review on the head commit decides: a later
`changes_requested` or `dismissed` review cancels an approval, and a comment
does not.

Commands:
  check [--repo <path>] --reviews <json> --head-sha <sha> (--tier <tier> | --tier-file <json>)
      `--reviews` is the Forge adapter's `pr reviews` output. `--tier-file` is the
      output of `release_plan.py tier`. Exit 0 when the release needs no approval
      or has a valid one, 1 when it needs one and has none, 2 on an error. With
      the module off, prints {"skipped": "release_approval is off"} and exits 0.

Prints one JSON document on stdout: required, approved, tier, threshold, the
review that counts, and the reasons when it is not approved.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import TextIO

from factory_config import ConfigError, resolve_repo, skip_unless

TIERS = ("authority", "sensitive", "general", "inert")
SHA = re.compile(r"^[0-9a-f]{40}$")
REVIEW_KEYS = {"author", "state", "commit", "body", "time"}
DECIDING = {"approved", "changes_requested", "dismissed"}


class ApprovalError(Exception):
    pass


def _config(repo: Path) -> tuple[str, str, str]:
    path = Path(repo) / ".claude" / "factory.json"
    try:
        operator = json.loads(path.read_text()).get("operator")
    except (OSError, json.JSONDecodeError) as error:
        raise ApprovalError(f"the factory config cannot be read: {error}") from error
    if not operator:
        raise ApprovalError("the factory config has no operator login; run context-init apply --operator <login>")
    settings = resolve_repo(Path(repo))["settings"]
    return operator, settings["release_approval_threshold"], settings["release_approval_text"]


def decide(repo: Path, reviews: list[dict], head_sha: str, tier: str) -> dict:
    if tier not in TIERS:
        raise ApprovalError(f"tier must be one of {', '.join(TIERS)}, not {tier!r}")
    operator, threshold, text = _config(repo)
    required = TIERS.index(tier) <= TIERS.index(threshold)
    result = {"required": required, "tier": tier, "threshold": threshold, "review": None, "reasons": []}
    if not required:
        return {**result, "approved": True}

    reasons = []
    for r in reviews:
        if r["state"] != "approved":
            continue
        when = f"the approval by {r['author']} at {r['time']}"
        if r["author"] != operator:
            reasons.append(f"{when} is not by the Operator {operator}")
        elif r["commit"] != head_sha:
            reasons.append(f"{when} is not on the head commit {head_sha[:7]}")
    if not any(r["state"] == "approved" for r in reviews):
        reasons.append("there is no approved review on the release pull request")

    deciding = sorted(
        (r for r in reviews if r["author"] == operator and r["commit"] == head_sha and r["state"] in DECIDING),
        key=lambda r: r["time"],
    )
    latest = deciding[-1] if deciding else None
    if latest and latest["state"] == "approved":
        if latest["body"].strip().startswith(text):
            return {**result, "approved": True, "review": latest, "reasons": []}
        reasons.append(f"the Operator's approval does not start with the approval text: {text!r}")
    elif latest:
        reasons.append(f"the Operator's latest review on the head commit is {latest['state']}")
    return {**result, "approved": False, "review": latest, "reasons": reasons}


def _load_json(path: str, what: str) -> object:
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ApprovalError(f"the {what} file cannot be read: {error}") from error


def _reviews(data: object) -> list[dict]:
    if not isinstance(data, list) or not all(isinstance(r, dict) and set(r) == REVIEW_KEYS for r in data):
        raise ApprovalError("the reviews file must be the Forge adapter's `pr reviews` output: a list of review objects")
    return data


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ApprovalError(message)


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = _Parser(prog="release_approval.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    check = commands.add_parser("check")
    check.add_argument("--repo", default=".")
    check.add_argument("--reviews", required=True)
    check.add_argument("--head-sha", required=True)
    tier = check.add_mutually_exclusive_group(required=True)
    tier.add_argument("--tier")
    tier.add_argument("--tier-file")
    try:
        args = parser.parse_args(argv)
        repo = Path(args.repo)
        skipped = skip_unless(repo, "release_approval")
        if skipped:
            stdout.write(json.dumps(skipped) + "\n")
            return 0
        if not SHA.match(args.head_sha):
            raise ApprovalError(f"--head-sha must be a full 40-character commit sha, not {args.head_sha!r}")
        if args.tier_file:
            doc = _load_json(args.tier_file, "tier")
            if not isinstance(doc, dict) or "tier" not in doc:
                raise ApprovalError("the tier file must be the output of release_plan.py tier")
            release_tier = doc["tier"]
        else:
            release_tier = args.tier
        result = decide(repo, _reviews(_load_json(args.reviews, "reviews")), args.head_sha, release_tier)
    except (ApprovalError, ConfigError) as error:
        stderr.write(json.dumps({"error": str(error)}) + "\n")
        return 2
    stdout.write(json.dumps(result, indent=2) + "\n")
    return 0 if result["approved"] else 1


if __name__ == "__main__":
    sys.exit(main())
