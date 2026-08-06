#!/usr/bin/env python3
"""Verify profiled OpenRouter and Vercel routes against their public catalogs."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

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


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def fetch_models(endpoint: str) -> dict[str, dict[str, Any]]:
    request = urllib.request.Request(
        endpoint,
        headers={"User-Agent": "pine-of-glass-contextimate-calibration"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload: Any = json.load(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise RuntimeError(f"{endpoint} returned malformed JSON")
    return {
        model["id"]: model
        for model in payload["data"]
        if isinstance(model, dict) and isinstance(model.get("id"), str)
    }


def model_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def main() -> None:
    args = parse_args()
    evidence = read_json(args.evidence)
    profiled_ids = {
        model_id
        for family in evidence["openFamilyPiRoutes"]["families"]
        for group in family["groups"]
        if group["label"] != "fallback chars/4"
        for model_id in group["modelIds"]
    }
    repositories = {
        artifact["repository"]
        for profile in evidence["openTokenizers"]["profiles"]
        for artifact in profile["familyArtifacts"]
    }
    repositories_by_lower = {repository.lower() for repository in repositories}
    repositories_by_key = {
        model_key(repository.rsplit("/", 1)[-1]): repository
        for repository in repositories
    }

    catalogs = []
    for provider, endpoint in CATALOGS:
        installed = read_json(PI_AI_DATA / f"{provider}.json")
        route_ids = sorted(
            {
                model_id
                for models in installed.values()
                for model_id in models
                if model_id in profiled_ids
            }
        )
        live = fetch_models(endpoint)
        missing = [model_id for model_id in route_ids if model_id not in live]
        if missing:
            raise RuntimeError(
                f"{provider} omitted profiled routes: {', '.join(missing)}"
            )

        routes = []
        for model_id in route_ids:
            model = live[model_id]
            if provider == "openrouter":
                artifact = model.get("hugging_face_id")
                if (
                    not isinstance(artifact, str)
                    or artifact.lower() not in repositories_by_lower
                ):
                    raise RuntimeError(
                        f"OpenRouter did not resolve {model_id} to a pinned artifact"
                    )
                route = {"id": model_id, "huggingFaceId": artifact}
                canonical_slug = model.get("canonical_slug")
                if canonical_slug != model_id:
                    if not isinstance(canonical_slug, str):
                        raise RuntimeError(
                            f"OpenRouter omitted the canonical slug for {model_id}"
                        )
                    route["canonicalSlug"] = canonical_slug
            else:
                name = model.get("name")
                if not isinstance(name, str):
                    raise RuntimeError(f"Vercel omitted the name for {model_id}")
                key = model_key(name)
                if model_id == "deepseek/deepseek-v3.2-thinking":
                    key = key.removesuffix("thinking")
                artifact = repositories_by_key.get(key)
                if artifact is None:
                    raise RuntimeError(
                        f"Vercel model name did not match a pinned artifact: {name}"
                    )
                route = {"id": model_id, "name": name, "artifact": artifact}
            routes.append(route)
        catalogs.append({"provider": provider, "endpoint": endpoint, "routes": routes})

    current = {"checkedAt": date.today().isoformat(), "catalogs": catalogs}
    if args.json:
        print(json.dumps(current, indent=2))
    elif evidence.get("relayAliasResolutions", {}).get("catalogs") != catalogs:
        raise RuntimeError("relay alias resolutions differ; inspect --json output")
    else:
        counts = ", ".join(
            f"{catalog['provider']} {len(catalog['routes'])}" for catalog in catalogs
        )
        print(f"relay alias resolutions match checked evidence: {counts}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
