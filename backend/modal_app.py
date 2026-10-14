from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
DATA = "/data"

app = modal.App("sep-counselor")
volume = modal.Volume.from_name("sep-counselor", create_if_missing=True)

gemini_secret = modal.Secret.from_name("gemini")
auth_secret = modal.Secret.from_name("app-auth")

PYTHON = "3.13"

WEB_DEPS = ["fastapi==0.143.0", "pydantic==2.14.1", "google-genai==2.30.1"]
TEST_DEPS = ["pytest==9.1.1", "httpx==0.28.1"]
CORPUS_DEPS = ["requests==2.34.2", "beautifulsoup4==4.15.0", "lxml==6.1.3"]
RETRIEVAL_CPU_DEPS = [
    "numpy==2.5.4",
    "scipy==1.18.1",
    "bm25s==0.3.13",
    "PyStemmer==3.1.0",
    "rapidfuzz==3.14.6",
    "jellyfish==1.2.1",
]


def _with_backend(image: modal.Image, include_tests: bool = False) -> modal.Image:
    # Added last and without copy, so backend edits never rebuild earlier layers.
    ignore = ["**/__pycache__", "**/.pytest_cache", *([] if include_tests else ["tests"])]
    return image.add_local_dir(ROOT / "backend", "/root/backend", ignore=ignore)


_python_base = modal.Image.debian_slim(python_version=PYTHON).uv_pip_install(*WEB_DEPS)

web_image = _with_backend(
    _python_base.apt_install("curl", "ca-certificates")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    .add_local_file(ROOT / "frontend/package.json", "/app/frontend/package.json", copy=True)
    .add_local_file(ROOT / "frontend/package-lock.json", "/app/frontend/package-lock.json", copy=True)
    .run_commands("cd /app/frontend && npm ci")
    .add_local_dir(ROOT / "frontend", "/app/frontend", copy=True, ignore=["node_modules", "dist"])
    .run_commands("cd /app/frontend && npm test -- --run && npm run build")
)

ci_image = _with_backend(
    _python_base.uv_pip_install(*TEST_DEPS, *CORPUS_DEPS, *RETRIEVAL_CPU_DEPS), include_tests=True
)
