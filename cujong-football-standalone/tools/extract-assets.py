#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从本机《明日方舟》PC 客户端解出运行所需的官方素材到 assets/。

用法:
    python tools/extract-assets.py --ab "<…>/StreamingAssets/AB/Windows" [--groups ui,scene,audio,chibi]

依赖:  pip install UnityPy lz4 Pillow

⚠ 解出的素材版权归鹰角网络 / Yostar，仅供个人学习；**不要把它们提交到公开仓库**（.gitignore 已排除）。
"""
import argparse, os, sys, io, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"


def load_env(ab_path):
    """注册 LZ4AK（明日方舟自定义压缩）后再交给 UnityPy。"""
    try:
        import UnityPy
    except ImportError:
        sys.exit("需要 UnityPy：pip install UnityPy lz4 Pillow")
    # 明日方舟的 AB 用 LZ4AK（compressionType 常被识别为 LZHAM），需要注册解压器
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import aklz4  # noqa: F401  （导入即注册）
    except ImportError:
        print("⚠ 未找到 aklz4.py：若报 LZHAM 解压失败，请把上游 tools/local-extract/aklz4.py 放到 tools/ 下")
    return UnityPy


def save_texture(obj, out_dir: Path, only=None):
    d = obj.read()
    name = getattr(d, "m_Name", "?")
    if only and name not in only:
        return False
    img = getattr(d, "image", None)
    if img is None:
        return False
    out_dir.mkdir(parents=True, exist_ok=True)
    img.save(out_dir / f"{name.replace('/', '_')}.png")
    return True


def group_ui(UnityPy, AB: Path):
    """足球 HUD（ui/footballcup）+ 比赛风格图标（arts/ui/[uc]multiv3.ab）"""
    n = 0
    fb = AB / "ui/footballcup/battle/football_cup_battle_ui_plugin.ab"
    if fb.exists():
        for o in UnityPy.load(str(fb)).objects:
            if o.type.name in ("Texture2D", "Sprite"):
                n += save_texture(o, ASSETS / "ui/football")
    st = AB / "arts/ui/[uc]multiv3.ab"
    if st.exists():
        for o in UnityPy.load(str(st)).objects:
            if o.type.name in ("Texture2D", "Sprite"):
                d = o.read()
                nm = getattr(d, "m_Name", "")
                if nm.startswith("buff_icon_"):
                    n += save_texture(o, ASSETS / "ui/style")
        # footballcup 里更全的 HUD（含 flag 等）
    print(f"[ui] {n} 张")


def group_scene(UnityPy, AB: Path):
    """战场地面/背景贴图 + 地面地块"""
    n = 0
    jobs = [
        (AB / "arts/maps/multi_player/res.ab", None),
        (AB / "activity/[uc]multiv3.ab", {"ground_base_tile", "land_poly_albedo", "act3vmulti_entry_ground_atlas"}),
    ]
    for path, only in jobs:
        if not path.exists():
            print(f"  跳过（不存在）: {path.name}")
            continue
        for o in UnityPy.load(str(path)).objects:
            if o.type.name in ("Texture2D", "Sprite"):
                n += save_texture(o, ASSETS / "ui/scene", only)
    print(f"[scene] {n} 张")


def group_audio(AB: Path):
    """得分/失分音效：客户端里是 .ab，需要 UnityPy 解 AudioClip。"""
    import UnityPy
    n = 0
    for name in ("act1multi.ab", "act2multi.ab"):
        p = AB / "audio/custom_se" / name
        if not p.exists():
            continue
        for o in UnityPy.load(str(p)).objects:
            if o.type.name != "AudioClip":
                continue
            d = o.read()
            nm = getattr(d, "m_Name", "clip")
            samples = getattr(d, "samples", None)
            if not samples:
                continue
            (ASSETS / "ui/audio").mkdir(parents=True, exist_ok=True)
            for key, buf in samples.items():
                (ASSETS / "ui/audio" / f"{nm}.wav").write_bytes(buf if isinstance(buf, bytes) else bytes(buf))
                n += 1
                break
    print(f"[audio] {n} 个")


def group_chibi(UnityPy, AB: Path):
    """Extract Spine packages into /chibi/<operator-id>/ paths expected by the browser loader."""
    n = 0
    root = AB / "chararts"
    if not root.is_dir():
        print("  chararts/ 不存在")
        return

    for ab in sorted(root.glob("char_*.ab")):
        operator_id = ab.stem.removeprefix("char_").replace("#", "_")
        out = ASSETS / "chibi" / operator_id
        try:
            env = UnityPy.load(str(ab))
        except Exception as exc:
            print(f"  [chibi] skip {ab.name}: {exc}")
            continue

        skels = []
        atlases = []
        texture_objects = []
        for obj in env.objects:
            try:
                data = obj.read()
            except Exception:
                continue
            name = getattr(data, "m_Name", "")
            if obj.type.name == "TextAsset":
                if name.endswith(".skel"):
                    skels.append((name, data.m_Script))
                elif name.endswith(".atlas"):
                    atlas_text = data.m_Script
                    if not isinstance(atlas_text, str):
                        atlas_text = bytes(atlas_text).decode("utf-8", "ignore")
                    atlases.append((name, atlas_text.replace("#", "_")))
            elif obj.type.name == "Texture2D":
                image = getattr(data, "image", None)
                if image is not None:
                    texture_objects.append((name.replace("#", "_"), image))

        if not skels:
            continue

        out.mkdir(parents=True, exist_ok=True)
        # Prefer the matching build_char_<id> skeleton; otherwise use the first valid skeleton.
        wanted = f"build_char_{operator_id}".lower()
        chosen = next((x for x in skels if x[0].replace("#", "_").lower().startswith(wanted)), skels[0])
        skel_bytes = chosen[1]
        if isinstance(skel_bytes, str):
            skel_bytes = skel_bytes.encode("latin-1", "ignore")
        else:
            skel_bytes = bytes(skel_bytes)
        (out / f"{operator_id}.skel").write_bytes(skel_bytes)

        # Spine atlas page names must agree with the texture filenames listed by /__chibi.
        atlas_text = atlases[0][1] if atlases else ""
        page_names = []
        for line in atlas_text.splitlines():
            stripped = line.strip()
            if stripped.lower().endswith(".png") and ":" not in stripped:
                page_names.append(stripped)
        if not page_names:
            page_names = [f"{operator_id}.png"]

        used_textures = set()
        for page_index, original_page in enumerate(page_names):
            page_stem = Path(original_page).stem.replace("#", "_").lower()
            matched = next(
                (x for x in texture_objects
                 if Path(x[0]).stem.lower() == page_stem
                 or x[0].lower() == original_page.lower()),
                None,
            )
            # Some client bundles strip ".png" from the Unity texture name.
            if matched is None:
                matched = next((x for x in texture_objects if Path(x[0]).stem.lower() in page_stem
                                or page_stem in Path(x[0]).stem.lower()), None)
            if matched is None and len(page_names) == 1 and texture_objects:
                matched = texture_objects[0]
            if matched:
                filename = f"{operator_id}.png" if len(page_names) == 1 else f"{operator_id}-{page_index:02d}.png"
                matched[1].save(out / filename)
                used_textures.add(matched[0])
                atlas_text = atlas_text.replace(original_page, filename)

        if atlas_text:
            (out / f"{operator_id}.atlas").write_text(atlas_text, encoding="utf-8")
        n += 1
        if not (out / f"{operator_id}.png").exists():
            print(f"  [chibi] warning: {operator_id} skeleton extracted without its atlas page texture")

    print(f"[chibi] {n} operator package(s), normalized to assets/chibi/<operator-id>/")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ab", required=True, help="…/Arknights_Data/StreamingAssets/AB/Windows")
    ap.add_argument("--groups", default="ui,scene,audio,chibi")
    a = ap.parse_args()
    AB = Path(a.ab)
    if not AB.is_dir():
        sys.exit(f"AB 目录不存在: {AB}")
    ASSETS.mkdir(parents=True, exist_ok=True)
    UnityPy = load_env(AB)
    groups = {g.strip() for g in a.groups.split(",") if g.strip()}
    if "ui" in groups: group_ui(UnityPy, AB)
    if "scene" in groups: group_scene(UnityPy, AB)
    if "audio" in groups: group_audio(AB)
    if "chibi" in groups: group_chibi(UnityPy, AB)
    print("完成。运行: python serve.py")


if __name__ == "__main__":
    main()
