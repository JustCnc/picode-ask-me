#!/usr/bin/env python3
"""Build a deterministic plugin ZIP from an explicit runtime allowlist, then hash it.

Determinism: fixed DOS timestamp (1980-01-01), sorted entry order, STORE (no compression),
Unix 0644 attributes, no extra fields. Two runs over the same sources produce the same bytes.

The archive is what `picode plugins install-local <path>` (or the Desktop "install from local"
picker) imports directly; no HTTP server and no catalogue are needed for that path.

`--marketplace` additionally writes a loopback catalogue next to the archive. Its zip URL is the
HTTP origin given by --base-url (PiCode accepts plain http only for loopback hosts in
`zip-source.ts`; HTTPS is allowed everywhere). The digest is computed from the bytes just written,
so no digest is committed in the source tree.

Usage: python scripts/pack.py [--out <dir>] [--marketplace] [--base-url <url>]
"""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
MARKETPLACE_FILE = "marketplace.json"
MARKETPLACE_ID = "picode-ask-me-local"
# Served by `python -m http.server` on loopback; only used to fill in URLs, never trusted.
DEFAULT_BASE_URL = "http://127.0.0.1:8765"
ENTRIES = (
    ".picode-plugin/plugin.json",
    "package.json",
    "README.md",
    "src/native.mjs",
    "src/questions.mjs",
)
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def build(target: Path) -> str:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in ENTRIES:
            data = (ROOT / name).read_bytes()
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_STORED
            # Unix + 0644: same mode on every machine, unlike the host filesystem's umask.
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    return hashlib.sha256(target.read_bytes()).hexdigest()


def normalize_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SystemExit(f"--base-url must be an absolute http(s) URL: {value}")
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"


def write_marketplace(out_dir: Path, version: str, zip_name: str, digest: str, base_url: str) -> Path:
    manifest = {
        "name": MARKETPLACE_ID,
        "description": "Local-use catalogue for picode-ask-me; served from loopback only.",
        "plugins": [
            {
                "name": "picode-ask-me",
                "description": "Ask the user structured questions through the PiCode native plugin Host API.",
                "version": version,
                "source": {
                    "source": "url",
                    "type": "zip",
                    "url": f"{base_url}/{zip_name}",
                    "sha256": digest,
                },
            }
        ],
    }
    target = out_dir / MARKETPLACE_FILE
    target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return target


MANIFEST_ENTRY = ".picode-plugin/plugin.json"


def read_version() -> str:
    """package.json 与清单各持一份版本：只 bump 一处会产出与清单不符的包名。"""
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    manifest = json.loads((ROOT / MANIFEST_ENTRY).read_text(encoding="utf-8"))
    if manifest.get("version") != version:
        raise SystemExit(
            f"version mismatch: package.json is {version}, "
            f"{MANIFEST_ENTRY} is {manifest.get('version')!r}",
        )
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "dist"), help="output directory")
    parser.add_argument(
        "--marketplace",
        action="store_true",
        help="also write marketplace.json for the loopback catalogue path",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"origin that serves the archive over loopback http (default: {DEFAULT_BASE_URL})",
    )
    args = parser.parse_args()
    if not args.marketplace and args.base_url != DEFAULT_BASE_URL:
        # 没有 catalogue 时 base-url 无处可写：报错比静默丢弃好。
        parser.error("--base-url only applies together with --marketplace")

    version = read_version()
    # 先校验再落盘：参数/版本错了不该留下半成品。
    base_url = normalize_base_url(args.base_url) if args.marketplace else None
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"picode-ask-me-{version}.zip"

    digest = build(target)
    Path(f"{target}.sha256").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    print(f"zip: {target}")
    print(f"sha256: {digest}")
    print(f"size: {target.stat().st_size} bytes")
    catalogue = out_dir / MARKETPLACE_FILE
    if base_url is None:
        # 上次的 catalogue 会指向这次不再构建的 zip。
        catalogue.unlink(missing_ok=True)
    else:
        print(f"catalogue: {write_marketplace(out_dir, version, target.name, digest, base_url)}")
        print(f"zip url: {base_url}/{target.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())