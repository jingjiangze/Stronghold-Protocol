#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate committed fallback vectors and, optionally, local official assets."""
import argparse
import json
import re
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "assets" / "public"
LOCAL = ROOT / "assets"


def fail(message):
    print(f"FAIL: {message}")
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-official", action="store_true",
                        help="fail unless the current local client asset set is present")
    args = parser.parse_args()

    manifest_path = PUBLIC / "manifest.json"
    icons_path = PUBLIC / "icons.svg"
    if not manifest_path.is_file() or not icons_path.is_file():
        fail("public asset manifest or sprite symbol sheet is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        icons_root = ET.parse(icons_path).getroot()
    except Exception as exc:
        fail(f"invalid public asset manifest/SVG: {exc}")

    ns = "{http://www.w3.org/2000/svg}"
    symbol_ids = {element.attrib["id"] for element in icons_root.iter()
                  if element.tag == ns + "symbol" and "id" in element.attrib}
    expected = {
        "balls": 10,
        "styles": 6,
        "roles": 8,
    }
    for section, count in expected.items():
        entries = manifest.get(section, [])
        if len(entries) != count:
            fail(f"manifest.{section} has {len(entries)} entries; expected {count}")
        for entry in entries:
            icon = entry.get("icon", entry.get("path", ""))
            if "#" not in icon:
                fail(f"{section}/{entry.get('id')} icon has no SVG symbol fragment: {icon}")
            path, fragment = icon.split("#", 1)
            target = ROOT / path
            if not target.is_file():
                fail(f"{section}/{entry.get('id')} file missing: {path}")
            if fragment not in symbol_ids:
                fail(f"{section}/{entry.get('id')} SVG symbol missing: #{fragment}")
    for entry in manifest.get("styles", []):
        item = entry.get("carriedItem", {})
        icon = item.get("icon", "")
        if "#" not in icon:
            fail(f"style {entry.get('id')} has no carried-item icon")
        path, fragment = icon.split("#", 1)
        if not (ROOT / path).is_file() or fragment not in symbol_ids:
            fail(f"carried-item SVG resource missing: {icon}")

    scene = manifest.get("scene", {}).get("background", "")
    if not scene or not (ROOT / scene).is_file():
        fail(f"scene background missing: {scene}")
    try:
        ET.parse(ROOT / scene)
    except Exception as exc:
        fail(f"scene background is not valid SVG: {exc}")

    print(f"PASS: public fallback assets ({len(symbol_ids)} symbols; 10 balls, 6 styles/items, 8 roles; scene SVG valid)")

    # Official extracted files intentionally stay out of Git. Check only when explicitly requested.
    expected_operator_ids = ("002_amiya", "003_kalts", "009_12fce", "010_chen", "102_texas", "101_sora")
    missing = []
    for operator_id in expected_operator_ids:
        folder = LOCAL / "chibi" / operator_id
        for suffix in (".skel", ".atlas", ".png"):
            if not (folder / f"{operator_id}{suffix}").is_file():
                missing.append(f"chibi/{operator_id}/{operator_id}{suffix}")
    for asset in (
        "ui/football/hud_bg.png",
        "ui/football/match_over.png",
        "ui/football/img_ally_score.png",
        "ui/football/img_enemy_score.png",
        "ui/football/img_draw_score.png",
    ):
        if not (LOCAL / asset).is_file():
            missing.append(asset)
    if args.require_official and missing:
        print("PENDING: local official extraction incomplete:")
        for name in missing:
            print(f"  - {name}")
        raise SystemExit(2)
    if missing:
        print(f"PENDING: {len(missing)} local official files missing; public fallback is complete.")
    else:
        print("PASS: required local official asset subset found.")
    if not args.require_official and missing:
        print("Tip: run tools/extract-assets.py --ab <AB/Windows-path> to fill assets/ui and assets/chibi.")


if __name__ == "__main__":
    main()
