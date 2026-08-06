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

from tokenizer_corpus import CORPUS_FILES, CORPUS_REVISION, count_summary, pinned_corpus


@dataclass(frozen=True)
class ArtifactSpec:
    repository: str
    revision: str
    filename: str
    sha256: str
    core_sha256: str | None = None
    bpe_sha256: str | None = None
    pattern_sha256: str | None = None


@dataclass(frozen=True)
class TokenizerSpec:
    label: str
    representative: ArtifactSpec
    family_members: tuple[ArtifactSpec, ...] = ()
    token_stream_sha256: str | None = None


KIMI_HASH = "b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103"
GLM_45_HASH = "9340665016419c825c4bdabbcc9acc43b7ca2c68ce142724afa829abb1be5efd"
GLM_5_HASH = "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d"
COMMAND_CORE_HASH = "2bcc46184ba3b57d82c76cdeb373c32e65cb570633a7237e1b01c175faf3758e"
KIMI_CONFIG_HASH = "12fcab43d2b6068f46769f5ff373960bf7c17a94d7abbc50e2491306b2f6cf58"
KIMI_PATTERN_HASH = "de5781783b193d5ccf5b1b28edfa70fa816ce78d54603fdc422cfd8d4ea4411f"


def tokenizer_family(
    label: str,
    bpe_sha256: str,
    token_stream_sha256: str,
    artifact_groups: Sequence[tuple[str, Sequence[tuple[str, str]]]],
) -> TokenizerSpec:
    artifacts = tuple(
        ArtifactSpec(
            repository, revision, "tokenizer.json", sha256, bpe_sha256=bpe_sha256
        )
        for sha256, members in artifact_groups
        for repository, revision in members
    )
    return TokenizerSpec(
        label,
        artifacts[0],
        artifacts[1:],
        token_stream_sha256=token_stream_sha256,
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
    tokenizer_family(
        "DeepSeek",
        "22acf98589f19423735aafc33361a4d1d0273a05fd8b9b8be74023afb6b8c882",
        "fc92ce91342c67f51ff9f576b966759714efe91fe088124cd386c17eb51b2abd",
        (
            (
                "621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41",
                (
                    (
                        "deepseek-ai/DeepSeek-V3",
                        "e815299b0bcbac849fa540c768ef21845365c9eb",
                    ),
                    (
                        "deepseek-ai/DeepSeek-V3-0324",
                        "e9b33add76883f293d6bf61f6bd89b497e80e335",
                    ),
                ),
            ),
            (
                "ecb6f9fc369894346f0511f4074ca75cee5cd5f3b06d02f1ba35fcd39f8e121d",
                (
                    (
                        "deepseek-ai/DeepSeek-R1",
                        "56d4cbbb4d29f4355bab4b9a39ccb717a14ad5ad",
                    ),
                    (
                        "deepseek-ai/DeepSeek-R1-0528",
                        "4236a6af538feda4548eca9ab308586007567f52",
                    ),
                ),
            ),
            (
                "32b34a41212e92f62e859cbbea121ae705a1fabbf157d9acf22d134ecd8dcf70",
                (
                    (
                        "deepseek-ai/DeepSeek-V3.1",
                        "c0781d039fb7a1ba2abc4add0bdc293e92d2b8db",
                    ),
                    (
                        "deepseek-ai/DeepSeek-V3.1-Terminus",
                        "19510d6dc61f79dbd925bd51ee8a9081c509a4b6",
                    ),
                    (
                        "deepseek-ai/DeepSeek-V3.2-Exp",
                        "194c67e12b1b0d6df0ef373ddcf215bc84027409",
                    ),
                ),
            ),
            (
                "cd050be35cae877f8f0aa847f45aa87e23835a56ca32b29b28545597852784e5",
                (
                    (
                        "deepseek-ai/DeepSeek-V3.2",
                        "a7e62ac04ecb2c0a54d736dc46601c5606cf10a6",
                    ),
                ),
            ),
            (
                "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf",
                (
                    (
                        "deepseek-ai/DeepSeek-V4-Flash",
                        "60d8d70770c6776ff598c94bb586a859a38244f1",
                    ),
                    (
                        "deepseek-ai/DeepSeek-V4-Flash-0731",
                        "7872f01b1d1fe23eabc4c98b48bffcef5a386062",
                    ),
                    (
                        "deepseek-ai/DeepSeek-V4-Pro",
                        "b5968e9190ef611bbf34a7229255be88a0e937c1",
                    ),
                ),
            ),
        ),
    ),
    tokenizer_family(
        "Qwen 2.5/3",
        "6e2c42439170bc898d8412d52f3c47361ec4bd134c1cc008fbdd86ac99259a8b",
        "0cbd8118040023d731f5ccc639adb182bc553575a5d13c86e1c49929a59fb0ea",
        (
            (
                "c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
                (
                    (
                        "Qwen/Qwen2.5-7B-Instruct",
                        "a09a35458c702b33eeacc393d103063234e8bc28",
                    ),
                    (
                        "Qwen/Qwen2.5-72B-Instruct",
                        "495f39366efef23836d0cfae4fbe635880d2be31",
                    ),
                    (
                        "Qwen/Qwen2.5-Coder-7B-Instruct",
                        "c03e6d358207e414f1eca0bb1891e29f1db0e242",
                    ),
                    (
                        "Qwen/Qwen2.5-VL-7B-Instruct",
                        "cc594898137f460bfe9f0759e9844b3ce807cfb5",
                    ),
                ),
            ),
            (
                "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
                (
                    ("Qwen/Qwen3-8B", "b968826d9c46dd6066d109eabc6255188de91218"),
                    ("Qwen/Qwen3-14B", "40c069824f4251a91eefaf281ebe4c544efd3e18"),
                    (
                        "Qwen/Qwen3-30B-A3B",
                        "ad44e777bcd18fa416d9da3bd8f70d33ebb85d39",
                    ),
                    ("Qwen/Qwen3-32B", "9216db5781bf21249d130ec9da846c4624c16137"),
                    (
                        "Qwen/Qwen3-235B-A22B",
                        "8efa61729e24bd65b1d152b5ab5409052aa80e65",
                    ),
                    (
                        "Qwen/Qwen3-30B-A3B-Instruct-2507",
                        "0d7cf23991f47feeb3a57ecb4c9cee8ea4a17bfe",
                    ),
                    (
                        "Qwen/Qwen3-235B-A22B-Instruct-2507",
                        "ac9c66cc9b46af7306746a9250f23d47083d689e",
                    ),
                    (
                        "Qwen/Qwen3-Next-80B-A3B-Instruct",
                        "9c7f2fbe84465e40164a94cc16cd30b6999b0cc7",
                    ),
                    (
                        "Qwen/Qwen3-Next-80B-A3B-Thinking",
                        "e502dd4100cc68c0de57643fd4317ec93a128670",
                    ),
                ),
            ),
            (
                "19564a48c4f71a2a1b937cce34c737a1e662b171c5f5d7edf641a15cd896f07d",
                (
                    (
                        "Qwen/Qwen3-30B-A3B-Thinking-2507",
                        "144afc2f379b542fdd4e85a1fcd5e1f79112d95d",
                    ),
                    (
                        "Qwen/Qwen3-235B-A22B-Thinking-2507",
                        "6cbffae6d8e28b986a6b17bd36f42f9fa0f1f0a5",
                    ),
                    (
                        "Qwen/Qwen3-Coder-30B-A3B-Instruct",
                        "b2cff646eb4bb1d68355c01b18ae02e7cf42d120",
                    ),
                    (
                        "Qwen/Qwen3-Coder-480B-A35B-Instruct",
                        "9d90cf8fca1bf7b7acca42d3fc9ae694a2194069",
                    ),
                    (
                        "Qwen/Qwen3-Coder-Next",
                        "a7fbcb5c0e12d62a448eaa0e260346bf5dcc0feb",
                    ),
                ),
            ),
            (
                "a5d85b6dcc535e6b93115a9ef287e6132fdbf30270da6218194ba742261173c7",
                (
                    (
                        "Qwen/Qwen3-VL-8B-Instruct",
                        "0c351dd01ed87e9c1b53cbc748cba10e6187ff3b",
                    ),
                    (
                        "Qwen/Qwen3-VL-8B-Thinking",
                        "92f3c4b4feadd3a016ef468d103bb5f58b2a2c6b",
                    ),
                    (
                        "Qwen/Qwen3-VL-30B-A3B-Instruct",
                        "9c4b90e1e4ba969fd3b5378b57d966d725f1b86c",
                    ),
                    (
                        "Qwen/Qwen3-VL-30B-A3B-Thinking",
                        "d0ed0380729be07a546fdefafbb4fe411f341e92",
                    ),
                    (
                        "Qwen/Qwen3-VL-32B-Instruct",
                        "0cfaf48183f594c314753d30a4c4974bc75f3ccb",
                    ),
                    (
                        "Qwen/Qwen3-VL-235B-A22B-Instruct",
                        "710c13861be6c466e66de3f484069440b8f31389",
                    ),
                    (
                        "Qwen/Qwen3-VL-235B-A22B-Thinking",
                        "6664affde68449468deb7527186455c7450c13c0",
                    ),
                ),
            ),
        ),
    ),
    tokenizer_family(
        "Qwen 3.5",
        "e23b06565b8e5ec64f5ab300b6c2a2c3ed3f5f8acb16b02f5f03bd811bbb8317",
        "1b9ddcbd8e88d46091ec9398b4dc9e71e52369581c9701c17f527ad80ee943a1",
        (
            (
                "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42",
                (
                    ("Qwen/Qwen3.5-9B", "c202236235762e1c871ad0ccb60c8ee5ba337b9a"),
                    ("Qwen/Qwen3.5-27B", "fc05daec18b0a78c049392ed2e771dde82bdf654"),
                    (
                        "Qwen/Qwen3.5-35B-A3B",
                        "59d61f3ce65a6d9863b86d2e96597125219dc754",
                    ),
                    (
                        "Qwen/Qwen3.5-122B-A10B",
                        "dc4d348443bc740c68e2d77492492c11606384d5",
                    ),
                    (
                        "Qwen/Qwen3.5-397B-A17B",
                        "8472618112abcbd45acbcdc58436aff4233c23f7",
                    ),
                ),
            ),
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


def tokenizer_bpe_sha256(path: str) -> str:
    with open(path) as handle:
        model = json.load(handle)["model"]
    merges = [
        merge if isinstance(merge, list) else merge.split(" ", 1)
        for merge in model["merges"]
    ]
    encoded = json.dumps(
        {"vocab": model["vocab"], "merges": merges},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


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
    if spec.bpe_sha256 is not None:
        bpe_hash = tokenizer_bpe_sha256(artifact)
        if bpe_hash != spec.bpe_sha256:
            raise RuntimeError(
                f"{spec.repository} tokenizer BPE hash changed: {bpe_hash}"
            )
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
        source = hf_hub_download(
            spec.representative.repository,
            "tokenization_kimi.py",
            revision=spec.representative.revision,
        )
        pattern = extract_kimi_pattern(source)
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
            pat_str=pattern,
            mergeable_ranks=ranks,
            special_tokens=special,
        )
        return lambda text: encoding.encode(text, allowed_special="all")

    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(artifact)
    return lambda text: tokenizer.encode(text, add_special_tokens=False).ids


def token_stream_sha256(
    encode: Callable[[str], Sequence[int]], texts: dict[str, str]
) -> str:
    streams = [[name, list(encode(texts[name]))] for name in sorted(texts)]
    encoded = json.dumps(streams, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


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
        if spec.token_stream_sha256 is not None:
            stream_hash = token_stream_sha256(encode, texts)
            if stream_hash != spec.token_stream_sha256:
                raise RuntimeError(
                    f"{spec.representative.repository} token stream changed: {stream_hash}"
                )
            for member in spec.family_members:
                member_encode = load_encoder(
                    TokenizerSpec(spec.label, member), hf_hub_download
                )
                member_hash = token_stream_sha256(member_encode, texts)
                if member_hash != spec.token_stream_sha256:
                    raise RuntimeError(
                        f"{member.repository} token stream differs: {member_hash}"
                    )
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
            "text": count_summary(
                samples, ["instructions-core", "instructions-design"]
            ),
            "session": count_summary(samples, ["session-code", "session-tests"]),
        }
        if spec.representative.filename == "tiktoken.model":
            row["configurationSha256"] = KIMI_CONFIG_HASH
        if spec.representative.bpe_sha256 is not None:
            row["bpeSha256"] = spec.representative.bpe_sha256
        if spec.token_stream_sha256 is not None:
            row["tokenStreamSha256"] = spec.token_stream_sha256
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
