#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extract the official football scene textures into the local, git-ignored assets directory.

Usage:
    python tools/extract-scene-textures.py --ab "<...>/Arknights_Data/StreamingAssets/AB/Windows"

Requires UnityPy, lz4, and Pillow. The output contains copyrighted client assets; do not commit it.
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT / "assets" / "ui" / "scene"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ab", required=True, help="Arknights client AB/Windows directory")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output directory (default: assets/ui/scene)")
    args = parser.parse_args()
    ab = Path(args.ab)
    out = Path(args.out)
    if not ab.is_dir():
        parser.error(f"AB directory does not exist: {ab}")

    try:
        import UnityPy
    except ImportError:
        parser.error("Install dependencies first: pip install UnityPy lz4 Pillow")

    sys.path.insert(0, str(TOOLS))
    try:
        import aklz4  # noqa: F401  (import registers the Arknights LZ4AK decoder)
    except ImportError:
        print("Warning: tools/aklz4.py not found; custom-compressed bundles may fail to decode.", file=sys.stderr)

    jobs = [
        (ab / "arts" / "maps" / "multi_player" / "res.ab", None),
        (ab / "activity" / "[uc]multiv3.ab",
         {"ground_base_tile", "land_poly_albedo", "act3vmulti_entry_ground_atlas"}),
    ]
    out.mkdir(parents=True, exist_ok=True)
    saved = 0
    for path, wanted in jobs:
        if not path.is_file():
            print(f"skip (not found): {path}")
            continue
        try:
            env = UnityPy.load(str(path))
        except Exception as exc:
            print(f"bundle load failed: {path.name}: {exc}", file=sys.stderr)
            continue
        for obj in env.objects:
            if obj.type.name not in ("Texture2D", "Sprite"):
                continue
            try:
                data = obj.read()
                name = getattr(data, "m_Name", "?")
                if wanted and name not in wanted:
                    continue
                image = getattr(data, "image", None)
                if image is None:
                    continue
                target = out / f"{name.replace('/', '_')}.png"
                image.save(target)
                print(f"saved {name}: {image.width}x{image.height} -> {target}")
                saved += 1
            except Exception:
                continue
    print(f"done: {saved} texture(s); output is local-only and ignored by Git")


if __name__ == "__main__":
    main()
