#!/usr/bin/env python3
"""Verify profiled OpenRouter and Vercel routes against their public catalogs."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EVIDENCE = (
    PROJECT_ROOT / "docs/contextimate-family-calibration-evidence-2026-08-05.json"
)
PI_AI_DATA = (
    PROJECT_ROOT
    / "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data"
)
CATALOGS = (
    ("openrouter", "https://openrouter.ai/api/v1/models"),
    ("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1/models"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check profiled relay IDs against public model catalogs.",
    )
    parser.add_argument(
        "--evidence",
        type=Path,
        default=DEFAULT_EVIDENCE,
        help="checked-in calibration evidence to verify",
    )
    parser.add_argument("--json", action="store_true", help="emit current mappings")
    return parser.parse_args()


def load_object(path: Path) -> dict[str, Any]:
    try:
        payload: Any = json.loads(path.read_text())
    except FileNotFoundError:
        raise RuntimeError(f"missing {path}; run npm run link-pi if needed") from None
    if not isinstance(payload, dict):
        raise RuntimeError(f"expected a JSON object in {path}")
    return payload


def model_records(value: Any) -> list[dict[str, str]]:
    if isinstance(value, list):
        return [record for item in value for record in model_records(item)]
    if not isinstance(value, dict):
        return []
    if all(isinstance(value.get(key), str) for key in ("provider", "id", "api")):
        return [
            {
                "provider": value["provider"],
                "id": value["id"],
                "api": value["api"],
            }
        ]
    return [record for item in value.values() for record in model_records(item)]


def profiled_model_ids(evidence: dict[str, Any]) -> set[str]:
    route_evidence = evidence.get("openFamilyPiRoutes")
    if not isinstance(route_evidence, dict):
        raise RuntimeError("evidence omitted openFamilyPiRoutes")
    families = route_evidence.get("families")
    if not isinstance(families, list):
        raise RuntimeError("route evidence omitted families")
    result: set[str] = set()
    for family in families:
        if not isinstance(family, dict) or not isinstance(family.get("groups"), list):
            raise RuntimeError("route evidence contains a malformed family")
        for group in family["groups"]:
            if not isinstance(group, dict) or not isinstance(group.get("label"), str):
                raise RuntimeError("route evidence contains a malformed group")
            ids = group.get("modelIds")
            if not isinstance(ids, list) or not all(
                isinstance(item, str) for item in ids
            ):
                raise RuntimeError("route evidence contains malformed model IDs")
            if group["label"] != "fallback chars/4":
                result.update(ids)
    return result


def pinned_repositories(evidence: dict[str, Any]) -> set[str]:
    tokenizers = evidence.get("openTokenizers")
    if not isinstance(tokenizers, dict) or not isinstance(
        tokenizers.get("profiles"), list
    ):
        raise RuntimeError("evidence omitted open tokenizer profiles")
    repositories: set[str] = set()
    for profile in tokenizers["profiles"]:
        if not isinstance(profile, dict) or not isinstance(
            profile.get("familyArtifacts"), list
        ):
            raise RuntimeError("evidence contains malformed tokenizer artifacts")
        for artifact in profile["familyArtifacts"]:
            if not isinstance(artifact, dict) or not isinstance(
                artifact.get("repository"), str
            ):
                raise RuntimeError("evidence contains a malformed tokenizer artifact")
            repositories.add(artifact["repository"])
    return repositories


def normalized_model_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def artifact_for_name(name: str, repositories: set[str]) -> str:
    normalized = normalized_model_name(name)
    candidates = [
        repository
        for repository in repositories
        if normalized_model_name(repository.rsplit("/", 1)[-1])
        in (normalized, normalized.removesuffix("thinking"))
    ]
    if len(candidates) != 1:
        raise RuntimeError(
            f"could not resolve relay model name to one artifact: {name}"
        )
    return candidates[0]


def fetch_models(endpoint: str) -> dict[str, dict[str, Any]]:
    request = urllib.request.Request(
        endpoint,
        headers={"User-Agent": "pine-of-glass-contextimate-calibration"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload: Any = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{endpoint} returned HTTP {error.code}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"{endpoint} request failed: {error.reason}") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise RuntimeError(f"{endpoint} returned malformed JSON")
    models: dict[str, dict[str, Any]] = {}
    for model in payload["data"]:
        if isinstance(model, dict) and isinstance(model.get("id"), str):
            models[model["id"]] = model
    return models


def current_resolutions(evidence: dict[str, Any]) -> dict[str, Any]:
    profiled_ids = profiled_model_ids(evidence)
    repositories = pinned_repositories(evidence)
    repositories_by_lower = {repository.lower() for repository in repositories}
    catalogs = []
    for provider, endpoint in CATALOGS:
        records = model_records(load_object(PI_AI_DATA / f"{provider}.json"))
        route_ids = sorted(
            {record["id"] for record in records if record["id"] in profiled_ids}
        )
        live = fetch_models(endpoint)
        missing = [model_id for model_id in route_ids if model_id not in live]
        if missing:
            raise RuntimeError(
                f"{provider} omitted profiled routes: {', '.join(missing)}"
            )
        if provider == "openrouter":
            routes = [
                {
                    "id": model_id,
                    "canonicalSlug": live[model_id].get("canonical_slug"),
                    "huggingFaceId": live[model_id].get("hugging_face_id"),
                }
                for model_id in route_ids
            ]
            if any(
                not isinstance(route["huggingFaceId"], str)
                or route["huggingFaceId"].lower() not in repositories_by_lower
                for route in routes
            ):
                raise RuntimeError("OpenRouter did not resolve to a pinned artifact")
        else:
            routes = []
            for model_id in route_ids:
                name = live[model_id].get("name")
                if not isinstance(name, str):
                    raise RuntimeError("Vercel omitted a profiled model name")
                routes.append(
                    {
                        "id": model_id,
                        "name": name,
                        "artifact": artifact_for_name(name, repositories),
                    }
                )
        catalogs.append({"provider": provider, "endpoint": endpoint, "routes": routes})
    return {"checkedAt": date.today().isoformat(), "catalogs": catalogs}


def main() -> None:
    args = parse_args()
    evidence = load_object(args.evidence)
    current = current_resolutions(evidence)
    if args.json:
        print(json.dumps(current, indent=2))
        return
    expected = evidence.get("relayAliasResolutions")
    if (
        not isinstance(expected, dict)
        or expected.get("catalogs") != current["catalogs"]
    ):
        raise RuntimeError("relay alias resolutions differ; inspect --json output")
    counts = ", ".join(
        f"{catalog['provider']} {len(catalog['routes'])}"
        for catalog in current["catalogs"]
    )
    print(f"relay alias resolutions match checked evidence: {counts}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
