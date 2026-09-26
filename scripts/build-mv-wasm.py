"""Build the browser-only MV core and matching Go runtime (Go 1.22+)."""
import os
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parent.parent
module = root / "browser" / "mvcore"
env = dict(os.environ, GOOS="js", GOARCH="wasm")
subprocess.run(["go", "build", "-mod=readonly", "-trimpath", "-ldflags=-s -w",
                "-o", str(root / "src/ui/mv-core.wasm"), "."], cwd=module, env=env, check=True)
goroot = Path(subprocess.check_output(["go", "env", "GOROOT"], text=True).strip())
runtime = goroot / "lib/wasm/wasm_exec.js"
if not runtime.exists():
    runtime = goroot / "misc/wasm/wasm_exec.js"
shutil.copyfile(runtime, root / "src/ui/mv-go.js")
print("Built src/ui/mv-core.wasm and src/ui/mv-go.js")
