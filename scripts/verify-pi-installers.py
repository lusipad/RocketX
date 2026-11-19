"""Match the runtime tested by prepare:pi-runtime against the actual desktop installers."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


def digest(file):
    result = hashlib.sha256()
    with file.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            result.update(part)
    return result.hexdigest()


def verify(root, expected, bridge_hash):
    markers = list(root.rglob("pi-runtime/generated/runtime.sha256"))
    if len(markers) != 1:
        raise ValueError(f"expected one installed Pi runtime marker, found {markers}")
    marker = markers[0]
    if marker.read_text().strip() != expected or digest(marker.with_name("runtime.tar.gz")) != expected:
        raise ValueError("packaged Pi runtime differs from the one that passed the isolated session test")
    bridge = marker.parents[2] / "pi_app_server.mjs"
    if digest(bridge) != bridge_hash:
        raise ValueError("installed Pi bridge differs from tested bridge")


def inspect(installer, expected, bridge_hash):
    with TemporaryDirectory(prefix="rocketx-inspect-pi-") as temp:
        root = Path(temp)
        if installer.suffix == ".dmg":
            subprocess.run(["hdiutil", "attach", str(installer), "-readonly", "-nobrowse", "-mountpoint", temp], check=True)
            try:
                verify(root, expected, bridge_hash)
            finally:
                subprocess.run(["hdiutil", "detach", temp], check=True)
        else:
            if installer.suffix == ".exe":
                seven_zip = shutil.which("7z") or str(Path(os.environ["ProgramFiles"]) / "7-Zip/7z.exe")
                subprocess.run([seven_zip, "x", "-y", "-bd", "-bso0", f"-o{root}", str(installer)], check=True)
            elif installer.suffix == ".msi":
                subprocess.run(["msiexec.exe", "/a", str(installer), "/qn", f"TARGETDIR={root}"], check=True)
            elif installer.suffix == ".deb":
                subprocess.run(["dpkg-deb", "-x", str(installer), temp], check=True)
            elif installer.suffix == ".AppImage":
                subprocess.run([str(installer), "--appimage-extract"], cwd=root, stdout=subprocess.DEVNULL, check=True)
            elif installer.suffix == ".rpm":
                # Jammy rpm2cpio 4.17 exits 1 when rpm-rs omits the optional archive-size tag.
                # libarchive reads the actual compressed payload. verify() still hashes the extracted files.
                subprocess.run(["bsdtar", "-xf", str(installer), "-C", temp], check=True)
            verify(root, expected, bridge_hash)
        print(f"Matched Pi runtime and bridge in {installer.name}", flush=True)


if __name__ == "__main__":
    tauri = Path(__file__).resolve().parents[1] / "apps/desktop/src-tauri"
    generated = tauri / "resources/pi-runtime/generated"
    expected = (generated / "runtime.sha256").read_text().strip()
    if digest(generated / "runtime.tar.gz") != expected:
        raise ValueError("invalid staged runtime digest")
    bridge_hash = digest(tauri / "src/pi_app_server.mjs")
    target = Path(os.environ.get("CARGO_TARGET_DIR", tauri / "target")).resolve()
    if sys.platform == "darwin":
        target /= "universal-apple-darwin"
    bundle = target / "release/bundle"
    patterns = {
        "win32": ["nsis/*_full-setup.exe", "nsis/*-setup.exe", "msi/*.msi"],
        "darwin": ["dmg/*.dmg"],
        "linux": ["appimage/*.AppImage", "deb/*.deb", "rpm/*.rpm"],
    }[sys.platform]
    for pattern in patterns:
        files = list(bundle.glob(pattern))
        if pattern == "nsis/*-setup.exe":
            files = [file for file in files if not file.name.endswith("_full-setup.exe")]
        if len(files) != 1:
            raise ValueError(f"expected one {pattern} in {bundle}, found {files}")
        inspect(files[0], expected, bridge_hash)
