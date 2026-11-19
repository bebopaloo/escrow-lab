# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Read a repo's Control modules from .claude/factory.json (ADR 0014).

Commands:
  validate [--repo <path>]          print the resolved controls; exit 1 and every
                                    problem on stderr when the config is invalid
  enabled <module> [--repo <path>]  exit 0 when the module is on, 1 when it is off,
                                    2 on an error (an invalid config fails closed)
  settings [--repo <path>]          print the settings, with defaults filled in
  docs [--repo <path>]              print the `docs` key: the documents that the release
                                    review checks; exit 1 when the key is invalid
  profile <name>                    print the modules of a Control profile
  catalogue                         print every module, its needs and its profiles

A module can need keys of the repo config too (`needs_keys` in the catalogue). The
module finding_deferral needs the `releases` key; a config without it is invalid.

The catalogue of modules, settings and profiles is templates/controls/profiles.toml.
Other factory scripts import `skip_unless` to check their module first.

The optional `docs` key is a list of repo-relative paths of files. Only `docs` and
`validate` read it: an invalid `docs` key turns no safety check off, so it stops no
other reader (ADR 0014 covers the `controls` key only).

Prints one JSON document on stdout. On an error: `{"error": ..., "problems": [...]}`
on stderr.
"""

import argparse
import json
import sys
import tomllib
from pathlib import Path
from typing import TextIO

PLUGIN_DIR = Path(__file__).resolve().parents[1]
CATALOGUE = PLUGIN_DIR / "templates" / "controls" / "profiles.toml"
CONTROLS_KEYS = {"profile", "modules", "settings"}
CUSTOM = "custom"
TIER_KEYS = ("authority", "sensitive", "general", "inert", "default")
KINDS = {"integer", "text", "tier", "tier_levels"}


class ConfigError(Exception):
    def __init__(self, problems: list[str] | str):
        self.problems = [problems] if isinstance(problems, str) else problems
        super().__init__("; ".join(self.problems))


# the catalogue


def load_catalogue(path: Path = CATALOGUE) -> dict:
    try:
        return tomllib.loads(path.read_text())
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ConfigError(f"the catalogue {path} cannot be read: {error}") from error


def unmet_needs(modules: list[str], catalogue: dict) -> list[str]:
    chosen = set(modules)
    return [
        f"{module} needs {need}"
        for module in modules
        if module in catalogue["modules"]
        for need in catalogue["modules"][module]["needs"]
        if need not in chosen
    ]


def unmet_keys(modules: list[str], config: dict, catalogue: dict) -> list[str]:
    return [
        f"{module} needs the {key} key"
        for module in modules
        if module in catalogue["modules"]
        for key in catalogue["modules"][module].get("needs_keys", [])
        if not config.get(key)
    ]


def check_catalogue(catalogue: dict) -> list[str]:
    """Problems in the catalogue itself; the tests keep this list empty."""
    modules = catalogue.get("modules", {})
    problems = [
        f"module {name} needs the unknown module {need}"
        for name, module in modules.items()
        for need in module.get("needs", [])
        if need not in modules
    ]
    for name, module in modules.items():
        keys = module.get("needs_keys", [])
        if not isinstance(keys, list) or not all(isinstance(key, str) and key for key in keys):
            problems.append(f"module {name} has needs_keys that is not a list of key names")
    for name, setting in catalogue.get("settings", {}).items():
        if setting.get("module") not in modules:
            problems.append(f"setting {name} belongs to the unknown module {setting.get('module')}")
        if setting.get("kind") not in KINDS:
            problems.append(f"setting {name} has the unknown kind {setting.get('kind')}")
        else:
            problems += _check_setting(name, setting, setting.get("default"))
    for name, profile in catalogue.get("profiles", {}).items():
        problems += [f"profile {name} has the unknown module {m}" for m in profile["modules"] if m not in modules]
        problems += [f"profile {name}: {problem}" for problem in unmet_needs(profile["modules"], catalogue)]
    if CUSTOM in catalogue.get("profiles", {}):
        problems.append(f"the profile name {CUSTOM} is reserved")
    return problems


# settings


def _whole_number(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_setting(name: str, setting: dict, value: object) -> list[str]:
    kind = setting["kind"]
    low, high = setting.get("min"), setting.get("max")
    if kind == "text":
        return [] if isinstance(value, str) and value.strip() else [f"{name} must be text"]
    if kind == "tier":
        tiers = [key for key in TIER_KEYS if key != "default"]
        return [] if value in tiers else [f"{name} must be one of {', '.join(tiers)}"]
    if kind == "integer":
        if not _whole_number(value):
            return [f"{name} must be a whole number"]
        return [] if low <= value <= high else [f"{name} must be {low} to {high}"]
    if not isinstance(value, dict):
        return [f"{name} must be a table"]
    problems = [f"{name} has an unknown key {key}" for key in value if key not in TIER_KEYS]
    for key, level in value.items():
        if key in TIER_KEYS and not (_whole_number(level) and low <= level <= high):
            problems.append(f"{name}.{key} must be {low} to {high}")
    return problems


def _settings(values: object, catalogue: dict) -> tuple[dict, list[str]]:
    known = catalogue["settings"]
    merged = {name: setting["default"] for name, setting in known.items()}
    if values is None:
        return merged, []
    if not isinstance(values, dict):
        return merged, ["settings must be a table"]
    problems = []
    for name, value in values.items():
        if name not in known:
            problems.append(f"unknown setting {name}")
            continue
        found = _check_setting(name, known[name], value)
        problems += found
        if not found:
            merged[name] = value
    return merged, problems


# a repo's controls


def _read_config(repo: Path) -> dict:
    path = repo / ".claude" / "factory.json"
    if not path.is_file():
        return {}
    try:
        config = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigError(f"{path} cannot be read: {error}") from error
    if not isinstance(config, dict):
        raise ConfigError(f"{path} must hold a JSON object")
    return config


def docs_for(repo: Path) -> list[str]:
    """The `docs` key: repo-relative paths of files. [] when absent; ConfigError when invalid."""
    repo = Path(repo)
    docs = _read_config(repo).get("docs")
    if docs is None:
        return []
    if not isinstance(docs, list) or not all(isinstance(item, str) and item.strip() for item in docs):
        raise ConfigError("docs must be a list of repo-relative paths")
    root = repo.resolve()
    problems = []
    for item in docs:
        target = (root / item).resolve()
        if Path(item).is_absolute() or not target.is_relative_to(root):
            problems.append(f"docs: {item} is not inside the repo")
        elif not target.is_file():
            problems.append(f"docs: {item} is not a file that exists")
    if problems:
        raise ConfigError(problems)
    return docs


def resolve(config: dict, catalogue: dict) -> dict:
    """The controls of one repo config: profile, modules, changes from the profile, settings."""
    if "controls" not in config:
        settings, _ = _settings(None, catalogue)
        return {"profile": "none", "modules": [], "added": [], "removed": [], "settings": settings}
    controls = config["controls"]
    if not isinstance(controls, dict):
        raise ConfigError("controls must be a table")

    problems = [f"unknown key {key} in controls" for key in controls if key not in CONTROLS_KEYS]
    profiles = catalogue["profiles"]
    profile = controls.get("profile")
    if profile != CUSTOM and profile not in profiles:
        problems.append(f"unknown profile {profile}; use one of {sorted(profiles)} or {CUSTOM}")

    modules = controls.get("modules")
    if not isinstance(modules, list) or not all(isinstance(m, str) for m in modules):
        problems.append("controls must have modules: a list of module names")
        modules = []
    problems += [f"unknown module {m}" for m in modules if m not in catalogue["modules"]]
    problems += [f"{m} is listed more than once" for m in sorted(set(modules)) if modules.count(m) > 1]
    problems += unmet_needs(modules, catalogue)
    problems += unmet_keys(modules, config, catalogue)

    settings, setting_problems = _settings(controls.get("settings"), catalogue)
    problems += setting_problems
    if problems:
        raise ConfigError(problems)

    ordered = [m for m in catalogue["modules"] if m in modules]
    base = profiles[profile]["modules"] if profile in profiles else []
    return {
        "profile": profile,
        "modules": ordered,
        "added": [m for m in ordered if m not in base],
        "removed": [m for m in catalogue["modules"] if m in base and m not in modules],
        "settings": settings,
    }


def resolve_repo(repo: Path, catalogue: dict | None = None) -> dict:
    return resolve(_read_config(Path(repo)), catalogue or load_catalogue())


def skip_unless(repo: Path, module: str, catalogue: dict | None = None) -> dict | None:
    """None when `module` is on; a skip result for the caller to print when it is off.

    Raises ConfigError for an unknown module or an invalid config, so a control
    never skips silently because of a typing mistake.
    """
    catalogue = catalogue or load_catalogue()
    if module not in catalogue["modules"]:
        raise ConfigError(f"unknown module {module}")
    if module in resolve_repo(repo, catalogue)["modules"]:
        return None
    return {"skipped": f"{module} is off"}


# the command line


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ConfigError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="factory_config.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    for name in ("validate", "settings", "docs"):
        commands.add_parser(name).add_argument("--repo", default=".")
    enabled = commands.add_parser("enabled")
    enabled.add_argument("module")
    enabled.add_argument("--repo", default=".")
    commands.add_parser("profile").add_argument("name")
    commands.add_parser("catalogue")
    return parser


def _catalogue_listing(catalogue: dict) -> dict:
    return {
        "modules": [
            {
                "name": name,
                "summary": module["summary"],
                "needs": module["needs"],
                "needs_keys": module.get("needs_keys", []),
                "profiles": [p for p, profile in catalogue["profiles"].items() if name in profile["modules"]],
                "settings": [s for s, setting in catalogue["settings"].items() if setting["module"] == name],
            }
            for name, module in catalogue["modules"].items()
        ],
        "profiles": {name: profile["summary"] for name, profile in catalogue["profiles"].items()},
    }


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    command = None
    try:
        args = build_parser().parse_args(argv)
        command = args.command
        catalogue = load_catalogue()
        if command == "enabled":
            result = skip_unless(Path(args.repo), args.module, catalogue)
            stdout.write(json.dumps({"module": args.module, "enabled": result is None}) + "\n")
            return 0 if result is None else 1
        if command == "validate":
            result = resolve_repo(Path(args.repo), catalogue)
            docs_for(Path(args.repo))
        elif command == "docs":
            result = {"docs": docs_for(Path(args.repo))}
        elif command == "settings":
            result = resolve_repo(Path(args.repo), catalogue)["settings"]
        elif command == "profile":
            if args.name not in catalogue["profiles"]:
                raise ConfigError(f"unknown profile {args.name}")
            result = {"profile": args.name, "modules": catalogue["profiles"][args.name]["modules"]}
        else:
            result = _catalogue_listing(catalogue)
    except ConfigError as error:
        stderr.write(json.dumps({"error": str(error), "problems": error.problems}) + "\n")
        return 2 if command == "enabled" else 1
    stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
