#!/usr/bin/env python3
"""Build 150 Spanish verb paradigms from UniMorph Spanish."""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UNIMORPH = ROOT / "data/reference/sources_es/unimorph_spa.tsv"
VOCAB = ROOT / "data/es/VOCAB_ES.csv"
OUTPUT = ROOT / "data/es/conjugation_es.json"
MAX_VERBS = 150
PERSONS = {"ik": ("1", "SG"), "jij": ("2", "SG"), "hij": ("3", "SG"),
           "wij": ("1", "PL"), "jullie": ("2", "PL"), "zij": ("3", "PL")}
SPECIAL = ["ser", "estar", "haber", "tener", "hacer", "ir", "poder", "querer", "decir", "dar"]


def main() -> None:
    translations: dict[str, str] = {}
    frequencies: dict[str, float] = {}
    with VOCAB.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            if row["categorie"] == "verbe":
                translations[row["es"]] = row["fr"]
                frequencies[row["es"]] = float(row["freq"] or 0)
    forms: dict[str, dict[str, set[str]]] = {}
    with UNIMORPH.open(encoding="utf-8", newline="") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 3:
                continue
            lemma, form, tag = parts
            if not re.fullmatch(r"[a-záéíóúüñ]+", lemma):
                continue
            forms.setdefault(lemma, {}).setdefault(tag, set()).add(form)

    ordered = [v for v in SPECIAL if v in translations]
    ordered.extend(v for v in sorted(translations, key=lambda x: frequencies.get(x, 0), reverse=True) if v not in ordered)
    out = []
    for verb in ordered:
        if verb not in forms:
            continue
        by_tag = forms[verb]
        def get(tag: str) -> str | None:
            values = by_tag.get(tag)
            return sorted(values)[0] if values else None
        def inflect(tense_tag: str, prefix: str = "") -> dict[str, str]:
            result = {}
            for key, (person_num, number) in PERSONS.items():
                wanted = f"V;IND;{tense_tag};{person_num};{number}"
                candidates = [t for t in by_tag if t.startswith(wanted)]
                if key == "jij":
                    candidates = [x for x in candidates if "INFM" in x] or candidates
                if key == "hij":
                    candidates = [x for x in candidates if "FORM" not in x] or candidates
                vals = sorted({form for t in candidates for form in by_tag[t]})
                if vals:
                    result[key] = vals[0]
            return result
        present = inflect("PRS")
        past_simple = inflect("PST;PFV")
        future = inflect("FUT")
        participle_tags = [tag for tag in by_tag if tag.startswith("V;V.PTCP;PST") and "MASC" in tag and "SG" in tag]
        participles = sorted({form for tag in participle_tags for form in by_tag[tag]})
        participle = participles[0] if participles else None
        if not all(k in present for k in PERSONS) or not all(k in past_simple for k in PERSONS) or not participle:
            continue
        if not all(k in future for k in PERSONS):
            endings = {"ik": "é", "jij": "ás", "hij": "á", "wij": "emos", "jullie": "éis", "zij": "án"}
            future = {k: verb + endings[k] for k in PERSONS}
        freq = frequencies.get(verb, 0)
        out.append({"infinitief": verb, "fr": translations[verb], "present": present,
                    "pastSimple": past_simple, "futureForms": future, "participePasse": participle,
                    "auxiliaire": "haber", "freq": freq, "niveauCECR": "A1", "niveauCECRSource": "elelex",
                    "irregulier": not (verb.endswith("ar") and past_simple["ik"].endswith("é")
                                         or verb.endswith(("er", "ir")) and past_simple["ik"].endswith("í"))})
        if len(out) >= MAX_VERBS:
            break
    OUTPUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(out)} Spanish verb paradigms written")


if __name__ == "__main__":
    main()
