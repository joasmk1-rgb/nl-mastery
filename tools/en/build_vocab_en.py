#!/usr/bin/env python3
"""Build the app's compact English word list from the local Apertium dictionary.

The generated file is a working draft: entries derived from the dictionary are
marked as such and must be reviewed before redistribution. Existing NOMEN.csv
translations are kept as hand-checked overrides.
"""
from __future__ import annotations

import csv
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

from wordfreq import top_n_list, zipf_frequency

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "data/reference/sources_en/apertium_fra_eng.dix"
EXISTING = ROOT / "data/en/NOMEN.csv"
OUTPUT = ROOT / "data/en/VOCAB_EN.csv"
LIMIT = 3000
PROFANITY = {"ass", "asshole", "bastard", "bitch", "bullshit", "crap", "cunt", "dick", "fuck", "fucking", "motherfucker", "piss", "pussy", "shit", "slut", "whore"}


def clean(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s.replace(";", ",")


def dictionary() -> dict[str, list[tuple[str, str]]]:
    out: dict[str, list[tuple[str, str]]] = defaultdict(list)
    tree = ET.parse(SOURCE)
    for entry in tree.iter("e"):
        pair = entry.find("p")
        if pair is None:
            continue
        left, right = pair.find("l"), pair.find("r")
        if left is None or right is None:
            continue
        fr = clean("".join(left.itertext()))
        en = clean("".join(right.itertext()))
        if not fr or not en or len(fr) > 60 or len(en) > 45:
            continue
        tags = " ".join(x.attrib.get("n", "") for x in left.findall("s"))
        category = ("verbe" if "vblex" in tags else "nom" if "n" in tags.split()
                    else "adjectif" if "adj" in tags.split()
                    else "adverbe" if "adv" in tags.split()
                    else "mot-outil")
        out[en].append((fr, category))
    return out


def main() -> None:
    translations = dictionary()
    overrides: dict[str, str] = {}
    with EXISTING.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            fr = clean(row.get("fr", ""))
            for en in (clean(x) for x in row.get("en", "").split("/")):
                if en and fr and re.fullmatch(r"[a-z]+(?:'[a-z]+)?", en):
                    overrides[en] = fr

    rows = []
    seen = set()
    # Wordfreq determines frequency and order; the bilingual dictionary supplies
    # candidate translations and POS. Frequencies are retained for the app's
    # established priority and CEFR cutoffs.
    for word in top_n_list("en", 180000):
        word = clean(word)
        if (not re.fullmatch(r"[a-z]+(?:'[a-z]+)?", word) or word in PROFANITY or word in seen
                or word not in translations and word not in overrides):
            continue
        freq = zipf_frequency(word, "en")
        if freq < 2.2:
            continue
        candidates = translations.get(word, [])
        fr = overrides.get(word) or " / ".join(dict.fromkeys(x[0] for x in candidates[:3]))
        category = candidates[0][1] if candidates else "nom"
        if not fr:
            continue
        level = "A1" if freq >= 5.5 else "A2" if freq >= 4.5 else "B1" if freq >= 3.5 else "B2"
        rows.append({"id": f"E{len(rows)+1}", "fr": fr, "en": word,
                     "freq": f"{freq:.2f}", "categorie": category,
                     "niveauCECR": level, "niveauCECRSource": "freq",
                     "traductionSource": "existante" if word in overrides else "apertium_a_verifier"})
        seen.add(word)
        if len(rows) >= LIMIT:
            break

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fields = ["id", "fr", "en", "freq", "categorie", "niveauCECR", "niveauCECRSource", "traductionSource"]
    with OUTPUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter=";", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} rows written to {OUTPUT}")
    print(f"{sum(r['traductionSource'] == 'existante' for r in rows)} existing translations; "
          f"{sum(r['traductionSource'] != 'existante' for r in rows)} dictionary candidates")


if __name__ == "__main__":
    main()
