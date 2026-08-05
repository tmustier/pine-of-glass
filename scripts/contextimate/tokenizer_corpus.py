"""Pinned public corpus shared by manual tokenizer calibration scripts."""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS_REVISION = "556dd115a77839773e143afc0d982afa59eb7479"
CORPUS_FILES = {
    "config-json": ["package.json", "tsconfig.json"],
    "instructions-core": ["AGENTS.md", "docs/agent-coding-standard.md"],
    "instructions-design": ["docs/design-language.md"],
    "session-code": [
        "extensions/_lib/heuristics.ts",
        "extensions/_lib/tool-payloads.ts",
    ],
    "session-tests": [
        "tests/contextimate/heuristics.test.ts",
        "tests/contextimate/provider-check.test.ts",
    ],
}


def pinned_corpus() -> dict[str, str]:
    def read(path: str) -> str:
        return subprocess.run(
            ["git", "-C", str(ROOT), "show", f"{CORPUS_REVISION}:{path}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    return {
        name: "\n".join(read(path) for path in files)
        for name, files in CORPUS_FILES.items()
    }
