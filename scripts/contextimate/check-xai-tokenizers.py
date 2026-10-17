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
import sys
import time
from importlib.metadata import version
from pathlib import Path

from tokenizer_corpus import CORPUS_REVISION, pinned_corpus

DEFAULT_MODELS = [
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-multi-agent",
    "grok-4.3",
    "grok-build-0.1",
    "grok-4.5",
]


if __name__ == "__main__":
    try:
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
        args = parser.parse_args()
        if args.retries < 0:
            raise RuntimeError("--retries must be non-negative")

        rng = random.Random(20260805)
        random_ascii = "".join(
            rng.choice(string.ascii_letters + string.digits + string.punctuation + " \t\n")
            for _ in range(4096)
        )
        fixtures = {
            "ascii": "Pack my box with five dozen liquor jugs. Version 12.003 costs $4.99; HTTP/2 foo_bar-baz.",
            "code": 'const parseHTTP2=(x:string):Record<string,unknown>=>JSON.parse(`{"snake_case":${x},"emoji":"🦬"}`);\n\treturn parseHTTP2("42");',
            "controls": "<|im_start|><|im_end|><|endoftext|><think></think>[DONE]<tool_call></tool_call>",
            "multilingual": "café naïve Straße Ελληνικά русский 中文 日本語 한국어 العربية हिन्दी 👩🏽‍💻🦬 antidisestablishmentarianism",
            "random-ascii-4096": random_ascii,
            "whitespace": "a  b   c\td\n\ne\r\nf /usr/local/bin ~/.config foo::bar 00000123456789",
        }
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

        key = os.environ.get("XAI_API_KEY")
        if not key:
            auth_path = Path.home() / ".pi" / "agent" / "auth.json"
            try:
                entry = json.loads(auth_path.read_text()).get("xai")
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError("set XAI_API_KEY or sign in to xAI through Pi") from error
            if isinstance(entry, dict) and isinstance(entry.get("access"), str):
                expires = entry.get("expires")
                if isinstance(expires, (int, float)) and expires <= time.time() * 1000:
                    raise RuntimeError("the Pi xAI login has expired; refresh it in Pi")
                key = entry["access"]
            else:
                raise RuntimeError("set XAI_API_KEY or sign in to xAI through Pi")
        client = Client(api_key=key)
        rows: list[dict[str, object]] = []
        groups: dict[str, dict[str, object]] = {}
        for requested_model in args.models or DEFAULT_MODELS:
            samples: list[dict[str, object]] = []
            resolved_models: set[str] = set()
            for fixture, text in fixtures.items():
                from xai_sdk.proto import tokenize_pb2

                stub = getattr(client.tokenize, "_stub", None)
                if stub is None or not hasattr(stub, "TokenizeText"):
                    raise RuntimeError("the pinned xai-sdk TokenizeText contract has changed")
                attempts_left = args.retries
                while True:
                    try:
                        response = stub.TokenizeText(
                            tokenize_pb2.TokenizeTextRequest(text=text, model=requested_model)
                        )
                        resolved_model, tokens = response.model, response.tokens
                        break
                    except Exception as error:
                        if "RESOURCE_EXHAUSTED" not in str(error) or attempts_left == 0:
                            code = getattr(error, "code", None)
                            status = code() if callable(code) else None
                            detail = getattr(status, "name", str(status)) if status else None
                            message = (
                                f"{type(error).__name__}: {detail}"
                                if detail
                                else type(error).__name__
                            )
                            raise RuntimeError(message) from error
                        attempts_left -= 1
                        time.sleep(15)
                resolved_models.add(resolved_model)
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
                sample_digest = digest.hexdigest()
                samples.append(
                    {
                        "fixture": fixture,
                        "chars": len(text),
                        "tokens": len(tokens),
                        "digest": sample_digest,
                    }
                )
                time.sleep(1)
            digest = hashlib.sha256()
            for sample in samples:
                record = json.dumps(
                    [sample["fixture"], sample["tokens"], sample["digest"]],
                    separators=(",", ":"),
                ).encode("utf8")
                digest.update(len(record).to_bytes(4, "big"))
                digest.update(record)
            fingerprint = digest.hexdigest()
            row: dict[str, object] = {
                "requestedModel": requested_model,
                "resolvedModels": sorted(resolved_models),
                "fingerprint": fingerprint,
            }
            if args.contextimate_corpus:
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

                row["contextimateProfile"] = {
                    "text": aggregate(
                        ["contextimate:instructions-core", "contextimate:instructions-design"]
                    ),
                    "session": aggregate(
                        ["contextimate:session-code", "contextimate:session-tests"]
                    ),
                }
            rows.append(row)
            fingerprint = str(row["fingerprint"])
            group = groups.setdefault(
                fingerprint,
                {"fingerprint": fingerprint, "models": [], "samples": samples},
            )
            group["models"].append(requested_model)
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
            "groups": list(groups.values()),
        }
        if args.json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
            raise SystemExit(0)
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
    except (OSError, RuntimeError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
