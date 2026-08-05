#!/usr/bin/env python3
"""Reproduce Contextimate's pinned open-tokenizer calibration."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from importlib.metadata import version
from importlib.util import find_spec
from pathlib import Path

sys.dont_write_bytecode = True
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from tokenizer_corpus import CORPUS_FILES, CORPUS_REVISION, pinned_corpus


@dataclass(frozen=True)
class ArtifactSpec:
    repository: str
    revision: str
    filename: str
    sha256: str
    core_sha256: str | None = None
    pattern_sha256: str | None = None


@dataclass(frozen=True)
class TokenizerSpec:
    label: str
    representative: ArtifactSpec
    family_members: tuple[ArtifactSpec, ...] = ()


KIMI_HASH = "b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103"
GLM_45_HASH = "9340665016419c825c4bdabbcc9acc43b7ca2c68ce142724afa829abb1be5efd"
GLM_5_HASH = "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d"
COMMAND_CORE_HASH = "2bcc46184ba3b57d82c76cdeb373c32e65cb570633a7237e1b01c175faf3758e"
KIMI_CONFIG_HASH = "12fcab43d2b6068f46769f5ff373960bf7c17a94d7abbc50e2491306b2f6cf58"
KIMI_PATTERN_HASH = "de5781783b193d5ccf5b1b28edfa70fa816ce78d54603fdc422cfd8d4ea4411f"
KIMI_PATTERN = "|".join(
    [
        r"[\p{Han}]+",
        r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
        r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
        r"\p{N}{1,3}",
        r" ?[^\s\p{L}\p{N}]+[\r\n]*",
        r"\s*[\r\n]+",
        r"\s+(?!\S)",
        r"\s+",
    ]
)

TOKENIZERS = [
    TokenizerSpec(
        "Kimi",
        ArtifactSpec(
            "moonshotai/Kimi-K2.5",
            "4d01dfe0332d63057c186e0b262165819efb6611",
            "tiktoken.model",
            KIMI_HASH,
            pattern_sha256=KIMI_PATTERN_HASH,
        ),
        (
            ArtifactSpec(
                "moonshotai/Kimi-K2-Instruct",
                "fd1984e2b7a3350dbf7305fe73a4ede25c14de50",
                "tiktoken.model",
                KIMI_HASH,
                pattern_sha256=KIMI_PATTERN_HASH,
            ),
            ArtifactSpec(
                "moonshotai/Kimi-K2-Instruct-0905",
                "ac6c49f04883bd0a0598b790693a72061c676629",
                "tiktoken.model",
                KIMI_HASH,
                pattern_sha256=KIMI_PATTERN_HASH,
            ),
            ArtifactSpec(
                "moonshotai/Kimi-K2.6",
                "7eb5002f6aadc958aed6a9177b7ed26bb94011bb",
                "tiktoken.model",
                KIMI_HASH,
                pattern_sha256=KIMI_PATTERN_HASH,
            ),
            ArtifactSpec(
                "moonshotai/Kimi-K2.7-Code",
                "74797c9c62378b951a1f6fcf5c4631024e9b8bef",
                "tiktoken.model",
                KIMI_HASH,
                pattern_sha256=KIMI_PATTERN_HASH,
            ),
            ArtifactSpec(
                "moonshotai/Kimi-K3",
                "9f62e4e9fffbd0a83ddd60e1c209d828994b3569",
                "tiktoken.model",
                KIMI_HASH,
                pattern_sha256=KIMI_PATTERN_HASH,
            ),
        ),
    ),
    TokenizerSpec(
        "GLM 4.5",
        ArtifactSpec(
            "zai-org/GLM-4.5",
            "cbb2c7cfb52fa128a9660cb1a7a78e017899e115",
            "tokenizer.json",
            GLM_45_HASH,
        ),
        (
            ArtifactSpec(
                "zai-org/GLM-4.5-Air",
                "a24ceef6ce4f3536971efe9b778bdaa1bab18daa",
                "tokenizer.json",
                GLM_45_HASH,
            ),
            ArtifactSpec(
                "zai-org/GLM-4.5V",
                "ed47433b37111465ec527affaaddceff371bca04",
                "tokenizer.json",
                GLM_45_HASH,
            ),
            ArtifactSpec(
                "zai-org/GLM-4.6",
                "be72194883d968d7923a07e2f61681ea9a2826d1",
                "tokenizer.json",
                GLM_45_HASH,
            ),
            ArtifactSpec(
                "zai-org/GLM-4.6V",
                "4e2d47eb0b41c5280d8294b17cef9e94fdcfff46",
                "tokenizer.json",
                GLM_45_HASH,
            ),
            ArtifactSpec(
                "zai-org/GLM-4.6V-Flash",
                "411bb4d77144a3f03accbf4b780f5acb8b7cde4e",
                "tokenizer.json",
                GLM_45_HASH,
            ),
            ArtifactSpec(
                "zai-org/GLM-4.7",
                "602d01efcdd332c5238ca4bcede555defbe83eb7",
                "tokenizer.json",
                GLM_45_HASH,
            ),
        ),
    ),
    TokenizerSpec(
        "GLM 5",
        ArtifactSpec(
            "zai-org/GLM-5",
            "4e6698ba8e85059d749020e3c4d2123719f23926",
            "tokenizer.json",
            GLM_5_HASH,
        ),
        (
            ArtifactSpec(
                "zai-org/GLM-4.7-Flash",
                "7dd20894a642a0aa287e9827cb1a1f7f91386b67",
                "tokenizer.json",
                GLM_5_HASH,
            ),
            ArtifactSpec(
                "zai-org/GLM-5.1",
                "26e1bd6e011feb778d25ae34b09b07074139d92d",
                "tokenizer.json",
                GLM_5_HASH,
            ),
            ArtifactSpec(
                "zai-org/GLM-5.2",
                "b4734de4facf877f85769a911abafc5283eab3d9",
                "tokenizer.json",
                GLM_5_HASH,
            ),
        ),
    ),
    TokenizerSpec(
        "Command R",
        ArtifactSpec(
            "mlx-community/c4ai-command-r-08-2024-4bit",
            "563c818b2a8358765f78d30156f6e36f93b57110",
            "tokenizer.json",
            "f7e773a231706a3ee5d05050ff27aa122a19df09ee7dd59eafa906b7487035b9",
            COMMAND_CORE_HASH,
        ),
        (
            ArtifactSpec(
                "mlx-community/c4ai-command-r-plus-08-2024-4bit",
                "c1793cf166ecc2e82bca7979d72cc91a95dd4d76",
                "tokenizer.json",
                "c69a7ea6c0927dfac8c349186ebcf0466a4723c21cbdb2e850cf559f0bee92b8",
                COMMAND_CORE_HASH,
            ),
        ),
    ),
    TokenizerSpec(
        "North Mini Code",
        ArtifactSpec(
            "CohereLabs/North-Mini-Code-1.0",
            "d11e61a842617a22dc328552fa5bb86231ee4f37",
            "tokenizer.json",
            "14bd1c49d7d11874921d324986713df4be21cd06060530c497dacef99919b7a5",
        ),
    ),
]


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_kimi_pattern(source_path: str) -> str:
    with open(source_path) as handle:
        tree = ast.parse(handle.read())
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == "pat_str"
            for target in node.targets
        ):
            continue
        value = node.value
        if (
            not isinstance(value, ast.Call)
            or not isinstance(value.func, ast.Attribute)
            or value.func.attr != "join"
            or len(value.args) != 1
        ):
            break
        try:
            parts = ast.literal_eval(value.args[0])
        except (TypeError, ValueError):
            break
        if isinstance(parts, list) and all(isinstance(part, str) for part in parts):
            return "|".join(parts)
    raise RuntimeError("Kimi tokenizer source no longer contains a literal pat_str")


def check_artifact(
    spec: ArtifactSpec, hf_hub_download: Callable[..., str]
) -> dict[str, str]:
    artifact = hf_hub_download(spec.repository, spec.filename, revision=spec.revision)
    actual_hash = sha256(artifact)
    if actual_hash != spec.sha256:
        raise RuntimeError(f"{spec.repository} artifact hash changed: {actual_hash}")
    result = {
        "repository": spec.repository,
        "revision": spec.revision,
        "sha256": actual_hash,
    }
    if spec.core_sha256 is not None:
        with open(artifact) as handle:
            model = json.load(handle)["model"]
        encoded = json.dumps(
            model, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
        core_hash = hashlib.sha256(encoded).hexdigest()
        if core_hash != spec.core_sha256:
            raise RuntimeError(
                f"{spec.repository} tokenizer core hash changed: {core_hash}"
            )
        result["coreSha256"] = core_hash
    if spec.pattern_sha256 is not None:
        source = hf_hub_download(
            spec.repository, "tokenization_kimi.py", revision=spec.revision
        )
        pattern_hash = hashlib.sha256(extract_kimi_pattern(source).encode()).hexdigest()
        if pattern_hash != spec.pattern_sha256:
            raise RuntimeError(
                f"{spec.repository} tokenizer pattern changed: {pattern_hash}"
            )
        result["patternSha256"] = pattern_hash
    return result


def load_encoder(
    spec: TokenizerSpec,
    hf_hub_download: Callable[..., str],
) -> Callable[[str], Sequence[int]]:
    artifact = hf_hub_download(
        spec.representative.repository,
        spec.representative.filename,
        revision=spec.representative.revision,
    )
    if spec.representative.filename == "tiktoken.model":
        local_pattern_hash = hashlib.sha256(KIMI_PATTERN.encode()).hexdigest()
        if local_pattern_hash != KIMI_PATTERN_HASH:
            raise RuntimeError(
                f"local Kimi tokenizer pattern changed: {local_pattern_hash}"
            )
        config = hf_hub_download(
            spec.representative.repository,
            "tokenizer_config.json",
            revision=spec.representative.revision,
        )
        actual_config_hash = sha256(config)
        if actual_config_hash != KIMI_CONFIG_HASH:
            raise RuntimeError(
                f"Kimi tokenizer config hash changed: {actual_config_hash}"
            )
        with open(config) as handle:
            added = json.load(handle)["added_tokens_decoder"]
        import tiktoken
        from tiktoken.load import load_tiktoken_bpe

        ranks = load_tiktoken_bpe(artifact)
        mapped = {int(token_id): value["content"] for token_id, value in added.items()}
        special = {
            mapped.get(token_id, f"<|reserved_token_{token_id}|>"): token_id
            for token_id in range(len(ranks), len(ranks) + 256)
        }
        encoding = tiktoken.Encoding(
            name="kimi-contextimate-calibration",
            pat_str=KIMI_PATTERN,
            mergeable_ranks=ranks,
            special_tokens=special,
        )
        return lambda text: encoding.encode(text, allowed_special="all")

    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(artifact)
    return lambda text: tokenizer.encode(text, add_special_tokens=False).ids


def aggregate(
    samples: dict[str, dict[str, float | int]], names: list[str]
) -> dict[str, float | int]:
    chars = sum(int(samples[name]["chars"]) for name in names)
    tokens = sum(int(samples[name]["tokens"]) for name in names)
    return {
        "chars": chars,
        "tokens": tokens,
        "charsPerToken": round(chars / tokens, 4),
        "recommendedDenominator": round(chars / tokens, 1),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Count the repository's public calibration corpus with pinned open tokenizers.",
    )
    parser.add_argument("--json", action="store_true", help="emit structured JSON")
    parser.add_argument(
        "--list-corpus",
        action="store_true",
        help="list corpus files without downloading tokenizers",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.list_corpus:
        print(
            json.dumps({"revision": CORPUS_REVISION, "files": CORPUS_FILES}, indent=2)
        )
        return
    dependencies = ("huggingface_hub", "tiktoken", "tokenizers")
    if any(find_spec(dependency) is None for dependency in dependencies):
        raise RuntimeError(
            "run with: uv run --with 'huggingface-hub==1.26.0' --with 'tokenizers==0.22.2' "
            "--with 'tiktoken==0.13.0'"
        )
    from huggingface_hub import hf_hub_download

    texts = pinned_corpus()
    rows = []
    for spec in TOKENIZERS:
        artifacts = [
            check_artifact(member, hf_hub_download)
            for member in (spec.representative, *spec.family_members)
        ]
        encode = load_encoder(spec, hf_hub_download)
        samples = {}
        for name, text in texts.items():
            tokens = len(encode(text))
            samples[name] = {
                "chars": len(text),
                "tokens": tokens,
                "charsPerToken": round(len(text) / tokens, 4),
            }
        row = {
            "profile": spec.label,
            "familyArtifacts": artifacts,
            "samples": samples,
            "text": aggregate(samples, ["instructions-core", "instructions-design"]),
            "session": aggregate(samples, ["session-code", "session-tests"]),
        }
        if spec.representative.filename == "tiktoken.model":
            row["configurationSha256"] = KIMI_CONFIG_HASH
        rows.append(row)

    result = {
        "corpusVersion": "2026-08-05.1",
        "corpusRevision": CORPUS_REVISION,
        "corpusFiles": CORPUS_FILES,
        "pythonVersion": sys.version.split()[0],
        "dependencies": {
            "huggingface-hub": version("huggingface-hub"),
            "tiktoken": version("tiktoken"),
            "tokenizers": version("tokenizers"),
        },
        "profiles": rows,
    }
    if args.json:
        print(json.dumps(result, indent=2))
        return
    for row in rows:
        print(
            f"{row['profile']:<18} text ÷ {row['text']['recommendedDenominator']:.1f}"
            f"  session ÷ {row['session']['recommendedDenominator']:.1f}"
        )
    print("Use --json for artifact hashes and per-corpus counts.")


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
