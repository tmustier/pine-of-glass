#!/usr/bin/env python3
"""Measure Contextimate's pinned corpus with Gemini countTokens."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

from tokenizer_corpus import CORPUS_FILES, CORPUS_REVISION, count_summary, pinned_corpus

DEFAULT_MODELS = (
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-computer-use-preview-10-2025",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
    "gemini-3-pro-image",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
)
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"


def count_tokens(model: str, text: str, api_key: str) -> int:
    model_path = urllib.parse.quote(model, safe="-._")
    request = urllib.request.Request(
        f"{ENDPOINT}/{model_path}:countTokens",
        data=json.dumps(
            {"contents": [{"role": "user", "parts": [{"text": text}]}]}
        ).encode(),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
            error_body = payload.get("error") if isinstance(payload, dict) else None
            message = (
                error_body.get("message", "request failed")
                if isinstance(error_body, dict)
                else "request failed"
            )
        except (json.JSONDecodeError, UnicodeError):
            message = "request failed"
        raise RuntimeError(
            f"{model}: countTokens returned HTTP {error.code}: {message}"
        ) from None
    except urllib.error.URLError as error:
        raise RuntimeError(
            f"{model}: countTokens request failed: {error.reason}"
        ) from None
    if not isinstance(payload, dict):
        raise RuntimeError(f"{model}: countTokens returned malformed JSON")
    total = payload.get("totalTokens")
    if type(total) is not int or total <= 0:
        raise RuntimeError(f"{model}: countTokens response omitted totalTokens")
    return total


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Count the repository's public calibration corpus with Gemini countTokens.",
    )
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        help="exact Gemini model id; repeat for multiple models",
    )
    parser.add_argument("--json", action="store_true", help="emit structured JSON")
    parser.add_argument(
        "--list-corpus",
        action="store_true",
        help="list corpus files without making provider calls",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.list_corpus:
        print(
            json.dumps({"revision": CORPUS_REVISION, "files": CORPUS_FILES}, indent=2)
        )
        return
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("set GEMINI_API_KEY or GOOGLE_API_KEY")

    texts = pinned_corpus()
    rows = []
    for model in args.models or DEFAULT_MODELS:
        samples = {}
        for name, text in texts.items():
            tokens = count_tokens(model, text, api_key)
            samples[name] = {
                "chars": len(text),
                "tokens": tokens,
                "charsPerToken": round(len(text) / tokens, 4),
            }
        counts = [[name, samples[name]["tokens"]] for name in sorted(samples)]
        rows.append(
            {
                "model": model,
                "countFingerprint": hashlib.sha256(
                    json.dumps(counts, separators=(",", ":")).encode()
                ).hexdigest(),
                "samples": samples,
                "text": count_summary(
                    samples, ["instructions-core", "instructions-design"]
                ),
                "session": count_summary(samples, ["session-code", "session-tests"]),
            }
        )

    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["countFingerprint"])].append(row)
    result = {
        "corpusVersion": "2026-08-05.1",
        "corpusRevision": CORPUS_REVISION,
        "corpusFiles": CORPUS_FILES,
        "endpoint": f"{ENDPOINT}/{{model}}:countTokens",
        "requestCoverage": "one user text part per corpus fixture",
        "groups": [
            {
                "countFingerprint": fingerprint,
                "models": [row["model"] for row in members],
                "samples": members[0]["samples"],
                "text": members[0]["text"],
                "session": members[0]["session"],
            }
            for fingerprint, members in grouped.items()
        ],
    }
    if args.json:
        print(json.dumps(result, indent=2))
        return
    for row in rows:
        print(
            f"{row['model']:<30} text ÷ {row['text']['recommendedDenominator']:.1f}"
            f"  session ÷ {row['session']['recommendedDenominator']:.1f}"
        )
    print("Use --json for per-corpus counts and count fingerprints.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
