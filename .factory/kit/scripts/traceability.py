# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Check the trace from a pull request to its work item and Spec (ADR 0014, module traceability).

Commands:
  issue --body-file <file>
      Print the GitHub issue number that the pull request body closes, or
      nothing. CI uses it to fetch the issue labels.
  source --body-file <file>
      Print the number on the `Source issue: #n` line of a Deferred finding
      issue body, or nothing. CI uses it to fetch the labels of the source issue.
  check [--repo <path>] --tier <tier> --body-file <file> [--labels-file <json>]
      The body must name a work item: `Closes #n` (or Fixes, Resolves) or
      `Refs: <id>`. Unless the tier is `inert`, the issue or its parent must
      have `spec-approved` or `spec-waived`. `--labels-file` holds
      {"issue": [labels], "parent": [labels] or null}; it is needed for a
      `#n` link. For an issue with the label `deferred` (a Deferred finding), it
      can also hold "source": {"issue": [labels], "parent": [labels] or null},
      the labels of the source issue and of its parent. The Spec label can then
      come from the source issue or its parent. A `Refs:` link to another
      tracker skips the Spec check, with a note. Exit 0 when the trace holds, 1 with problems, 2 on an error. With
      the module off, prints {"skipped": "traceability is off"} and exits 0.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import TextIO

from factory_config import ConfigError, skip_unless

TIERS = ("authority", "sensitive", "general", "inert")
CLOSES = re.compile(r"^\s*(?:closes|fixes|resolves)\s+#(\d+)\b", re.IGNORECASE | re.MULTILINE)
SOURCE = re.compile(r"^Source issue:\s*#(\d+)\b", re.IGNORECASE | re.MULTILINE)
REFS = re.compile(r"^\s*Refs:\s*(\S+)", re.MULTILINE)
SPEC_LABELS = {"spec-approved", "spec-waived"}
DEFERRED = "deferred"


class TraceError(Exception):
    pass


def work_item(body: str) -> dict | None:
    """The work item that a body names: a GitHub issue, or a ref to another tracker."""
    if match := CLOSES.search(body):
        return {"kind": "issue", "id": match.group(1)}
    if match := REFS.search(body):
        return {"kind": "ref", "id": match.group(1)}
    return None


def source_issue(body: str) -> str | None:
    """The number on the `Source issue: #n` line of a Deferred finding issue body."""
    match = SOURCE.search(body)
    return match.group(1) if match else None


def check(body: str, tier: str, labels: dict | None) -> list[str]:
    if tier not in TIERS:
        raise TraceError(f"tier must be one of {', '.join(TIERS)}, not {tier!r}")
    item = work_item(body)
    if item is None:
        return ["the pull request names no work item: add `Closes #<n>` or `Refs: <id>`"]
    if tier == "inert" or item["kind"] == "ref":
        return []
    if labels is None:
        raise TraceError(f"the labels of issue #{item['id']} are needed to check its Spec: give --labels-file")
    found = set(labels.get("issue") or []) | set(labels.get("parent") or [])
    deferred = DEFERRED in (labels.get("issue") or [])
    if deferred:
        source = labels.get("source") or {}
        found |= set(source.get("issue") or []) | set(source.get("parent") or [])
    if found & SPEC_LABELS:
        return []
    if deferred:
        return [
            f"issue #{item['id']} has no approved Spec: neither it nor its parent, nor its source issue"
            " or the parent of that, has `spec-approved` or `spec-waived`"
        ]
    return [f"issue #{item['id']} has no approved Spec: neither it nor its parent has `spec-approved` or `spec-waived`"]


def notes(body: str, tier: str) -> list[str]:
    item = work_item(body)
    if item and item["kind"] == "ref" and tier != "inert":
        return [f"{item['id']} is in another tracker, so CI cannot check its Spec"]
    return []


def _labels(path: str | None) -> dict | None:
    if path is None:
        return None
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise TraceError(f"the labels file cannot be read: {error}") from error
    if not isinstance(data, dict) or not _label_pair(data):
        raise TraceError('the labels file must hold {"issue": [labels], "parent": [labels] or null}')
    if data.get("source") is not None and not (isinstance(data["source"], dict) and _label_pair(data["source"])):
        raise TraceError('the "source" key of the labels file must hold {"issue": [labels], "parent": [labels] or null}')
    return data


def _label_pair(data: dict) -> bool:
    return isinstance(data.get("issue"), list) and (data.get("parent") is None or isinstance(data.get("parent"), list))


def _body(path: str) -> str:
    try:
        return Path(path).read_text()
    except OSError as error:
        raise TraceError(f"the body file cannot be read: {error}") from error


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise TraceError(message)


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = _Parser(prog="traceability.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    commands.add_parser("issue").add_argument("--body-file", required=True)
    commands.add_parser("source").add_argument("--body-file", required=True)
    check_cmd = commands.add_parser("check")
    check_cmd.add_argument("--repo", default=".")
    check_cmd.add_argument("--tier", required=True)
    check_cmd.add_argument("--body-file", required=True)
    check_cmd.add_argument("--labels-file")
    try:
        args = parser.parse_args(argv)
        if args.command == "issue":
            item = work_item(_body(args.body_file))
            stdout.write((item["id"] if item and item["kind"] == "issue" else "") + "\n")
            return 0
        if args.command == "source":
            stdout.write((source_issue(_body(args.body_file)) or "") + "\n")
            return 0
        skipped = skip_unless(Path(args.repo), "traceability")
        if skipped:
            stdout.write(json.dumps(skipped) + "\n")
            return 0
        body = _body(args.body_file)
        problems = check(body, args.tier, _labels(args.labels_file))
        result = {"tier": args.tier, "work_item": work_item(body), "problems": problems, "notes": notes(body, args.tier)}
    except (TraceError, ConfigError) as error:
        stderr.write(json.dumps({"error": str(error)}) + "\n")
        return 2
    stdout.write(json.dumps(result, indent=2) + "\n")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
