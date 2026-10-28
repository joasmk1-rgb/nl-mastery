#!/usr/bin/env python3
"""Build a 3,000-entry Spanish-French list from ELELex and Apertium candidates."""
from __future__ import annotations

import csv
import re
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ELELEX = ROOT / "data/reference/ELELex.tsv"
DICT = ROOT / "data/reference/sources_es/apertium_fra_spa.dix"
EXISTING = ROOT / "data/es"
OUTPUT = ROOT / "data/es/VOCAB_ES.csv"
LIMIT = 3000
LEVELS = ["a1", "a2", "b1", "b2", "c1"]


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("_", " ")).strip().lower()


def dictionary() -> dict[str, list[tuple[str, str]]]:
    out: dict[str, list[tuple[str, str]]] = defaultdict(list)
    root = ET.parse(DICT).getroot()
    for entry in root.iter("e"):
        pair = entry.find("p")
        if pair is None:
            continue
        left, right = pair.find("l"), pair.find("r")
        if left is None or right is None:
            continue
        fr, es = clean("".join(left.itertext())), clean("".join(right.itertext()))
        if not fr or not es or len(fr) > 80 or len(es) > 50:
            continue
        tags = {x.attrib.get("n", "") for x in right.findall("s")}
        category = ("verbe" if "vblex" in tags else "nom" if "n" in tags
                    else "adjectif" if "adj" in tags else "adverbe" if "adv" in tags
                    else "mot-outil")
        out[es].append((fr, category))
    return out


def main() -> None:
    translations = dictionary()
    overrides: dict[str, tuple[str, str]] = {}
    file_categories = {"NOMES.csv": "nom", "VERBESES.csv": "verbe", "ADJES.csv": "adjectif"}
    for filename, category in file_categories.items():
        with (EXISTING / filename).open(encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f, delimiter=";"):
                fr = clean(row.get("fr", ""))
                for es in (clean(x) for x in row.get("es", "").split("/")):
                    if es and fr:
                        overrides[es] = (fr, category)

    candidates: dict[str, dict[str, str | float]] = {}
    with ELELEX.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            word = clean(row.get("word", ""))
            tag = row.get("tag", "")
            if not word or len(word) > 45 or not re.fullmatch(r"[a-záéíóúüñ]+(?: [a-záéíóúüñ]+)?", word):
                continue
            if tag.startswith("NP"):
                continue
            if tag.startswith(("NC", "NP")):
                category = "nom"
            elif tag.startswith(("AQ", "AO")):
                category = "adjectif"
            elif tag.startswith(("VM", "VA", "VS")):
                category = "verbe"
            elif tag.startswith(("RG", "RN")):
                category = "adverbe"
            else:
                category = "mot-outil"
            frs = overrides.get(word)
            pairs = translations.get(word, [])
            fr = frs[0] if frs else " / ".join(dict.fromkeys(x[0] for x in pairs[:3]))
            if not fr:
                continue
            docs = {level: float(row.get(f"nb_doc@{level}") or 0) for level in LEVELS}
            levels = [level for level in LEVELS if docs[level] >= 3]
            if not levels and not any(docs.values()):
                continue
            level = (levels[0] if levels else max(LEVELS, key=lambda x: docs[x])).upper()
            freq = float(row.get("total_freq@total") or 0)
            # For homographs, prefer the entry with an existing translation and stronger corpus frequency.
            old = candidates.get(word)
            score = freq + (1e12 if frs else 0)
            if old and float(old["score"]) >= score:
                continue
            candidates[word] = {"fr": fr, "categorie": frs[1] if frs else (pairs[0][1] if pairs else category),
                                "freq": freq, "niveauCECR": level, "level_rank": LEVELS.index(level.lower()), "score": score,
                                "source": "existante" if frs else "apertium_a_verifier"}

    # Preserve the complete starter lists even when ELELex does not contain a lemma.
    for word, (fr, category) in overrides.items():
        if word not in candidates:
            candidates[word] = {"fr": fr, "categorie": category, "freq": 0,
                                "niveauCECR": "B2", "level_rank": 3, "score": 1e12,
                                "source": "existante"}

    ordered = sorted(candidates.items(), key=lambda p: (p[1]["source"] != "existante",
                                                       int(p[1]["level_rank"]), -float(p[1]["freq"]), p[0]))[:LIMIT]
    rows = [{"id": f"S{i}", "fr": value["fr"], "es": word, "freq": f"{value['freq']:.4f}",
             "categorie": value["categorie"], "niveauCECR": value["niveauCECR"],
             "niveauCECRSource": "elelex", "traductionSource": value["source"]}
            for i, (word, value) in enumerate(ordered, 1)]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter=";", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(rows)} Spanish words written; {sum(r['traductionSource']=='existante' for r in rows)} existing translations; "
          f"{sum(r['traductionSource']!='existante' for r in rows)} Apertium candidates")


if __name__ == "__main__":
    main()
