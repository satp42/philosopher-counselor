from backend.modal_app import app, ci_image


@app.function(image=ci_image, timeout=900)
def run_tests(args: str = "") -> None:
    import subprocess
    import sys

    result = subprocess.run([sys.executable, "-m", "pytest", "-q", "backend/tests", *args.split()], cwd="/root")
    if result.returncode:
        raise SystemExit(result.returncode)


@app.local_entrypoint()
def main(args: str = "") -> None:
    run_tests.remote(args)
