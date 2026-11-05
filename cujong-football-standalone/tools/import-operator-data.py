#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Import local Arknights operator/skill tables into a git-ignored runtime catalog.

This tool deliberately reads user-supplied local JSON tables rather than downloading game data.
It preserves sourced attributes and descriptions, while flagging inferred skill behavior.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "assets" / "local" / "operators.generated.json"
PROFESSION_MAP = {
    "PIONEER": "vanguard", "WARRIOR": "guard", "TANK": "defender",
    "SNIPER": "sniper", "CASTER": "caster", "MEDIC": "medic",
    "SUPPORT": "supporter", "SPECIAL": "specialist",
}
FORCE_NAMES = ("force", "push_strength", "pushStrength", "shift_force", "forceLevel")


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except Exception as exc:
        raise ValueError(f"cannot parse {path}: {exc}") from exc


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def number(value, default=None):
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default


def first_number(mapping, names, default=None):
    for name in names:
        if name in mapping:
            val = number(mapping.get(name))
            if val is not None:
                return val
    return default


def latest_attributes(entry):
    """Read the highest-level frame of the highest phase in an Arknights character table."""
    candidates = []
    phases = entry.get("phases") or []
    for phase_index, phase in enumerate(phases):
        if not isinstance(phase, dict):
            continue
        frames = phase.get("attributesKeyFrames") or phase.get("attributes_key_frames") or []
        for frame in frames:
            data = frame.get("data") or frame.get("attributes") or {}
            if isinstance(data, dict):
                candidates.append((phase_index, number(frame.get("level"), 0), data))
    if candidates:
        return max(candidates, key=lambda row: (row[0], row[1]))[2]

    # A few client versions flatten the final frame at the character root.
    frames = entry.get("attributesKeyFrames") or entry.get("attributes_key_frames") or []
    flattened = []
    for frame in frames:
        data = frame.get("data") or frame.get("attributes") or {}
        if isinstance(data, dict):
            flattened.append((number(frame.get("level"), 0), data))
    if flattened:
        return max(flattened, key=lambda pair: pair[0])[1]
    return entry.get("attributes") or entry.get("stats") or {}


def normalize_id(raw_id):
    return re.sub(r"^char_", "", str(raw_id))


def guess_force_level(description, blackboard):
    for key, value in blackboard.items():
        if any(term.lower() in key.lower() for term in FORCE_NAMES):
            parsed = number(value)
            if parsed is not None:
                return max(0, int(parsed))
    text = re.sub(r"<[^>]+>", "", str(description or ""))
    if "极大力" in text or "非常大力" in text:
        return 4
    if "较大力" in text or "大力" in text:
        return 3
    if "中等力度" in text or "中等力" in text:
        return 2
    if "小力" in text or "稍微推动" in text:
        return 1
    return 1


def classify_skill(skill, skill_id):
    levels = skill.get("levels") or []
    level = levels[-1] if levels else skill
    sp_data = level.get("spData") or level.get("sp_data") or {}
    blackboard_list = level.get("blackboard") or level.get("blackBoard") or []
    blackboard = {
        str(row.get("key")): row.get("value")
        for row in blackboard_list if isinstance(row, dict) and row.get("key") is not None
    }
    description = level.get("description") or skill.get("description") or skill.get("name") or ""
    text = re.sub(r"<[^>]+>", "", str(description))
    duration = first_number(blackboard, ("duration", "time", "stun_duration", "stunDuration"), number(level.get("duration"), 0))
    sp_cost = first_number(sp_data, ("spCost", "sp_cost", "cost"), first_number(level, ("spCost", "sp_cost"), 20))
    initial_sp = first_number(sp_data, ("initSp", "initSP", "initialSp", "initial_sp"), 0)
    max_charge = first_number(sp_data, ("maxChargeTime", "max_charge_time"), 1)
    effect = {"type": "attack-buff", "attackMultiplier": 1.0, "duration": max(0, duration or 0)}
    confidence = "generic-fallback"

    if any(term in text for term in ("击退", "推开", "推移", "推动", "牵引", "拖拽", "位移")):
        effect = {"type": "push", "forceLevel": guess_force_level(text, blackboard), "range": 3}
        confidence = "text-inferred"
    elif any(term in text for term in ("眩晕", "寒冷", "冻结")):
        effect = {"type": "stun", "duration": max(1, duration or 2), "range": first_number(blackboard, ("range", "radius"), 2)}
        confidence = "text-inferred"
    elif any(term in text for term in ("治疗", "恢复生命", "回复生命", "生命值")) and any(term in text for term in ("友方", "目标", "生命值恢复")):
        effect = {"type": "heal", "amount": first_number(blackboard, ("heal", "healing", "heal_scale"), 0), "range": first_number(blackboard, ("range", "radius"), 2)}
        confidence = "text-inferred"
    elif any(term in text for term in ("攻击力提升", "攻击力提高", "攻击速度提升", "攻击速度提高")):
        effect = {
            "type": "attack-buff",
            "attackMultiplier": 1 + first_number(blackboard, ("atk", "attack", "atk_scale"), 0),
            "duration": max(1, duration or 8),
        }
        confidence = "blackboard-inferred"

    skill_name = (levels[0].get("name") if levels and isinstance(levels[0], dict) else None) or skill.get("name", str(skill_id))
    return {
        "id": str(skill_id),
        "name": skill_name,
        "description": text,
        "spCost": max(1, round(sp_cost or 20)),
        "initialSp": max(0, round(initial_sp or 0)),
        "maxChargeTime": max(1, round(max_charge or 1)),
        # In this engine the SP threshold is the charge gate; no separate invented
        # duration-based cooldown is added on top of the original SP mechanics.
        "cooldownSeconds": 0,
        "duration": max(0, duration or 0),
        "blackboard": blackboard,
        "effect": effect,
        "effectMapping": confidence,
    }


def convert_operator(operator_id, entry, skill_table):
    profession_code = str(entry.get("profession") or entry.get("professionType") or "").upper()
    profession = PROFESSION_MAP.get(profession_code, "guard")
    attrs = latest_attributes(entry)
    rarity_raw = first_number(entry, ("rarity",), 2)
    rarity = int(rarity_raw) + 1 if 0 <= rarity_raw <= 5 else int(rarity_raw)
    cost = first_number(attrs, ("cost", "deployCost", "initialCost", "deploy_cost"), None)
    if cost is None:
        cost = first_number(entry, ("cost", "deployCost", "initialCost", "costs"), 12)
    attack_time = first_number(attrs, ("baseAttackTime", "base_attack_time"), first_number(entry, ("baseAttackTime", "base_attack_time"), 1.5))
    if attack_time and attack_time > 0:
        attack_interval = round(float(attack_time), 3)
    else:
        attack_interval = 1.5
    skill_defs = []
    for slot in (entry.get("skills") or []):
        skill_id = slot.get("skillId") or slot.get("skill_id") or slot.get("id")
        if not skill_id:
            continue
        skill_entry = skill_table.get(skill_id, {}) if isinstance(skill_table, dict) else {}
        skill_defs.append(classify_skill(skill_entry, skill_id))
    max_attrs = attrs
    hp = first_number(max_attrs, ("maxHp", "max_hp", "hp", "maxHP"), first_number(entry, ("maxHp", "max_hp"), 1200))
    atk = first_number(max_attrs, ("atk", "attack", "attackPower"), first_number(entry, ("atk", "attack"), 300))
    defense = first_number(max_attrs, ("def", "defense", "defence"), first_number(entry, ("def", "defense"), 0))
    resistance = first_number(max_attrs, ("magicResistance", "magic_resistance", "res", "resistance"), first_number(entry, ("magicResistance", "resistance"), 0))
    block_count = first_number(max_attrs, ("blockCnt", "blockCount", "block_count"), first_number(entry, ("blockCnt", "blockCount", "block_count"), 1))
    deploy_range = 2 if entry.get("rangeId") or entry.get("range_id") else 1
    redeploy_seconds = first_number(entry, ("redeployTime", "respawnTime", "redeploySeconds"), 70)
    initial_sp = max((skill.get("initialSp", 0) for skill in skill_defs), default=0)
    return {
        "id": normalize_id(operator_id),
        "name": entry.get("name") or normalize_id(operator_id),
        "profession": profession,
        "rarity": rarity,
        "cost": max(1, round(cost)),
        "attack": round(atk),
        "hp": round(hp),
        "defense": round(defense),
        "resistance": round(resistance),
        "attackInterval": attack_interval,
        "blockCount": max(0, round(block_count)),
        "range": deploy_range,
        "redeploySeconds": max(1, round(redeploy_seconds)),
        "initialSp": initial_sp,
        "maxSp": max([30] + [skill["spCost"] for skill in skill_defs]),
        "skills": skill_defs,
        "dataSource": "local-client-character-and-skill-tables",
        "skillEffects": "mapped-from-local-blackboard-and-description",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--character-table", required=True, help="local character_table.json")
    parser.add_argument("--skill-table", required=True, help="local skill_table.json")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--include-npcs", action="store_true", help="also include non-playable entries with skill data")
    args = parser.parse_args()

    character_path = Path(args.character_table)
    skill_path = Path(args.skill_table)
    if not character_path.is_file() or not skill_path.is_file():
        parser.error("Character and skill table paths must both exist.")

    try:
        characters = read_json(character_path)
        skills = read_json(skill_path)
    except ValueError as exc:
        parser.error(str(exc))
    if not isinstance(characters, dict) or not isinstance(skills, dict):
        parser.error("Both source tables must have JSON object roots.")

    operators = []
    for operator_id, entry in characters.items():
        if not isinstance(entry, dict):
            continue
        if operator_id.startswith("token_") or operator_id.startswith("trap_"):
            continue
        if not args.include_npcs and not (operator_id.startswith("char_") or operator_id[:3].isdigit()):
            continue
        if not entry.get("name") or not entry.get("profession"):
            continue
        operators.append(convert_operator(operator_id, entry, skills))
    operators.sort(key=lambda item: (item["name"], item["id"]))

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "status": "imported-local-data",
        "sourceFiles": {
            "characterTable": {"name": character_path.name, "sha256": sha256_file(character_path)},
            "skillTable": {"name": skill_path.name, "sha256": sha256_file(skill_path)},
        },
        "operatorCount": len(operators),
        "skillEffectNote": "Operator attributes and SP fields come from local JSON. Complex skill effects are inferred from text/blackboard and require review before being called exact.",
        "operators": operators,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("Exported %d operators to %s" % (len(operators), output_path))
    print("Effects derived by text/blackboard rules are heuristic; review skillEffects/effectMapping before treating them as exact.")
    if not operators:
        raise SystemExit("No playable operators were found; check that the supplied tables are from a compatible client version.")


if __name__ == "__main__":
    main()
