#!/usr/bin/env python3
"""Compare exact token streams returned by xAI's TokenizeText API."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import string
import subprocess
import sys
import time
from collections.abc import Iterable, Sequence
from importlib.metadata import version
from pathlib import Path
from types import SimpleNamespace
from typing import Protocol

sys.dont_write_bytecode = True
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from tokenizer_corpus import CORPUS_REVISION, pinned_corpus

DEFAULT_MODELS = [
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-multi-agent",
    "grok-4.3",
    "grok-build-0.1",
    "grok-4.5",
]


def fingerprint_fixtures() -> dict[str, str]:
    rng = random.Random(20260805)
    random_ascii = "".join(
        rng.choice(string.ascii_letters + string.digits + string.punctuation + " \t\n")
        for _ in range(4096)
    )
    return {
        "ascii": "Pack my box with five dozen liquor jugs. Version 12.003 costs $4.99; HTTP/2 foo_bar-baz.",
        "code": 'const parseHTTP2=(x:string):Record<string,unknown>=>JSON.parse(`{"snake_case":${x},"emoji":"🦬"}`);\n\treturn parseHTTP2("42");',
        "controls": "<|im_start|><|im_end|><|endoftext|><think></think>[DONE]<tool_call></tool_call>",
        "multilingual": "café naïve Straße Ελληνικά русский 中文 日本語 한국어 العربية हिन्दी 👩🏽‍💻🦬 antidisestablishmentarianism",
        "random-ascii-4096": random_ascii,
        "whitespace": "a  b   c\td\n\ne\r\nf /usr/local/bin ~/.config foo::bar 00000123456789",
    }


class TokenRecord(Protocol):
    token_id: int
    string_token: str
    token_bytes: bytes


def canonical_token_digest(tokens: Iterable[TokenRecord]) -> str:
    digest = hashlib.sha256()
    for token in tokens:
        record = json.dumps(
            [
                int(token.token_id),
                str(token.string_token),
                base64.b64encode(bytes(token.token_bytes)).decode("ascii"),
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf8")
        digest.update(len(record).to_bytes(4, "big"))
        digest.update(record)
    return digest.hexdigest()


def combined_digest(samples: Sequence[dict[str, object]]) -> str:
    digest = hashlib.sha256()
    for sample in samples:
        record = json.dumps(
            [sample["fixture"], sample["tokens"], sample["digest"]],
            separators=(",", ":"),
        ).encode("utf8")
        digest.update(len(record).to_bytes(4, "big"))
        digest.update(record)
    return digest.hexdigest()


def contextimate_profile(
    samples: Sequence[dict[str, object]],
) -> dict[str, dict[str, float | int]]:
    by_name = {str(sample["fixture"]): sample for sample in samples}

    def aggregate(names: list[str]) -> dict[str, float | int]:
        chars = sum(int(by_name[name]["chars"]) for name in names)
        tokens = sum(int(by_name[name]["tokens"]) for name in names)
        return {
            "chars": chars,
            "tokens": tokens,
            "charsPerToken": round(chars / tokens, 4),
            "recommendedDenominator": round(chars / tokens, 1),
        }

    return {
        "text": aggregate(
            ["contextimate:instructions-core", "contextimate:instructions-design"]
        ),
        "session": aggregate(
            ["contextimate:session-code", "contextimate:session-tests"]
        ),
    }


def api_key() -> str:
    if value := os.environ.get("XAI_API_KEY"):
        return value
    auth_path = Path.home() / ".pi" / "agent" / "auth.json"
    try:
        entry = json.loads(auth_path.read_text()).get("xai")
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("set XAI_API_KEY or sign in to xAI through Pi") from error
    if not isinstance(entry, dict) or not isinstance(entry.get("access"), str):
        raise RuntimeError("set XAI_API_KEY or sign in to xAI through Pi")
    expires = entry.get("expires")
    if isinstance(expires, (int, float)) and expires <= time.time() * 1000:
        raise RuntimeError("the Pi xAI login has expired; refresh it in Pi")
    return entry["access"]


def token_error(error: Exception) -> str:
    code = getattr(error, "code", None)
    if callable(code):
        status = code()
        return f"{type(error).__name__}: {getattr(status, 'name', str(status))}"
    return type(error).__name__


def tokenize(
    client: object, model: str, text: str, retries: int
) -> tuple[str, Sequence[object]]:
    # The public helper returns only tokens. The pinned SDK's generated stub keeps the
    # resolved model, which is required to distinguish stable model IDs from aliases.
    from xai_sdk.proto import tokenize_pb2

    token_client = client.tokenize
    stub = getattr(token_client, "_stub", None)
    if stub is None or not hasattr(stub, "TokenizeText"):
        raise RuntimeError("the pinned xai-sdk TokenizeText contract has changed")
    for attempt in range(retries + 1):
        try:
            response = stub.TokenizeText(
                tokenize_pb2.TokenizeTextRequest(text=text, model=model)
            )
            return response.model, response.tokens
        except Exception as error:
            if "RESOURCE_EXHAUSTED" not in str(error) or attempt == retries:
                raise RuntimeError(token_error(error)) from error
            time.sleep(15)
    raise RuntimeError("unreachable TokenizeText retry state")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fingerprint exact xAI token streams. Network calls occur only when this script is run.",
    )
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        help="model or alias; repeat for more than one",
    )
    parser.add_argument(
        "--file",
        action="append",
        type=Path,
        default=[],
        help="additional UTF-8 corpus file",
    )
    parser.add_argument("--json", action="store_true", help="emit structured JSON")
    parser.add_argument(
        "--contextimate-corpus",
        action="store_true",
        help="also count the pinned public corpus used for Contextimate profiles; requires a source checkout",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=4,
        help="rate-limit retries per call (default: 4)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="test fingerprinting without xAI or xai-sdk",
    )
    return parser.parse_args()


def self_test() -> None:
    first = [SimpleNamespace(token_id=1, string_token="a", token_bytes=b"a")]
    same = [SimpleNamespace(token_id=1, string_token="a", token_bytes=b"a")]
    changed = [SimpleNamespace(token_id=2, string_token="a", token_bytes=b"a")]
    assert canonical_token_digest(first) == canonical_token_digest(same)
    assert canonical_token_digest(first) != canonical_token_digest(changed)
    assert len(fingerprint_fixtures()["random-ascii-4096"]) == 4096
    print("xAI tokenizer fingerprint self-test passed")


def main() -> None:
    args = parse_args()
    if args.self_test:
        self_test()
        return
    if args.retries < 0:
        raise RuntimeError("--retries must be non-negative")

    fixtures = fingerprint_fixtures()
    if args.contextimate_corpus:
        fixtures.update(
            {f"contextimate:{name}": text for name, text in pinned_corpus().items()}
        )
    for path in args.file:
        name = f"file:{path.name}"
        if name in fixtures:
            raise RuntimeError(f"duplicate corpus name: {name}")
        fixtures[name] = path.read_text()

    try:
        from xai_sdk import Client
    except ImportError as error:
        raise RuntimeError(
            "install the pinned SDK with: uv run --with 'xai-sdk==1.17.0'"
        ) from error

    client = Client(api_key=api_key())
    rows: list[dict[str, object]] = []
    for requested_model in args.models or DEFAULT_MODELS:
        samples: list[dict[str, object]] = []
        resolved_models: set[str] = set()
        for fixture, text in fixtures.items():
            resolved_model, tokens = tokenize(
                client, requested_model, text, args.retries
            )
            resolved_models.add(resolved_model)
            samples.append(
                {
                    "fixture": fixture,
                    "chars": len(text),
                    "tokens": len(tokens),
                    "digest": canonical_token_digest(tokens),
                }
            )
            time.sleep(1)
        row: dict[str, object] = {
            "requestedModel": requested_model,
            "resolvedModels": sorted(resolved_models),
            "fingerprint": combined_digest(samples),
            "samples": samples,
        }
        if args.contextimate_corpus:
            row["contextimateProfile"] = contextimate_profile(samples)
        rows.append(row)

    groups: dict[str, list[str]] = {}
    for row in rows:
        groups.setdefault(str(row["fingerprint"]), []).append(
            str(row["requestedModel"])
        )
    result = {
        "corpusVersion": "2026-08-05.1",
        "corpus": [
            {
                "fixture": name,
                "chars": len(text),
                "sha256": hashlib.sha256(text.encode("utf8")).hexdigest(),
            }
            for name, text in fixtures.items()
        ],
        "contextimateCorpusRevision": CORPUS_REVISION
        if args.contextimate_corpus
        else None,
        "pythonVersion": sys.version.split()[0],
        "xaiSdkVersion": version("xai-sdk"),
        "models": rows,
        "groups": [
            {"fingerprint": key, "models": models} for key, models in groups.items()
        ],
    }
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return
    for group in result["groups"]:
        print(f"{str(group['fingerprint'])[:12]}  {', '.join(group['models'])}")
    if args.contextimate_corpus:
        for row in rows:
            profile = row["contextimateProfile"]
            print(
                f"{row['requestedModel']:<34} text ÷ {profile['text']['recommendedDenominator']:.1f}"
                f"  session ÷ {profile['session']['recommendedDenominator']:.1f}"
            )
    print("Use --json for resolved models and per-fixture counts.")


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        RuntimeError,
        UnicodeError,
        subprocess.CalledProcessError,
    ) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
