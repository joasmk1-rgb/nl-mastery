#!/usr/bin/env python3
"""Generate a common English verb set from UniMorph inflection tables."""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parents[2]
UNIMORPH = ROOT / "data/reference/sources_en/unimorph_eng.tsv"
VOCAB = ROOT / "data/en/VOCAB_EN.csv"
OUTPUT = ROOT / "data/en/conjugation_en.json"
MAX_VERBS = 150
IRREGULAR_D_PASTS = {"read", "lead", "feed", "meet", "bleed", "breed", "speed", "spread", "build", "send", "lend", "spend", "bend", "hold", "tell", "sell", "feel", "keep", "sleep", "sweep", "leave", "lose", "choose", "rise", "pay", "say", "lay", "make", "have"}


def main() -> None:
    translations = {}
    with VOCAB.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            if row["categorie"] == "verbe":
                translations[row["en"]] = row["fr"]

    forms: dict[str, dict[str, list[str]]] = {}
    with UNIMORPH.open(encoding="utf-8", newline="") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 3:
                continue
            lemma, form, tag = parts
            lemma = lemma.lower()
            if not re.fullmatch(r"[a-z]+", lemma):
                continue
            forms.setdefault(lemma, {}).setdefault(tag, []).append(form.lower())

    # Keep the highest-priority auxiliaries explicitly present even if the bilingual
    # dictionary assigns them an ambiguous lexical category.
    translations.setdefault("be", "être")
    translations.setdefault("have", "avoir")
    # UniMorph provides explicit present persons, simple past and past participle.
    # The remaining present forms are regular base forms except for the listed
    # high-frequency spelling changes in the third person.
    irregular_3sg = {"be": "is", "have": "has", "do": "does", "go": "goes"}
    out = [{
        "infinitief": "be", "fr": "être",
        "present": {"ik": "am", "jij": "are", "hij": "is", "wij": "are"},
        "preteritum": "was", "pastForms": {"ik": "was", "jij": "were", "hij": "was", "wij": "were"},
        "participePasse": "been", "auxiliaire": "have", "exempleNl": "", "exempleFr": "",
        "freq": round(zipf_frequency("be", "en"), 2), "niveauCECR": "A1", "niveauCECRSource": "freq", "irregulier": True
    }]
    for verb, fr in sorted(translations.items(), key=lambda pair: zipf_frequency(pair[0], "en"), reverse=True):
        if len(out) >= MAX_VERBS:
            break
        data = forms.get(verb, {})
        get = lambda *tags: next((sorted(data[t])[0] for t in tags if data.get(t)), None)
        past = get("V;PST", "V;PST;1;SG")
        participle = get("V;V.PTCP;PST", "V;V.PTCP;PRS")
        base = get("V;PRS;1;SG") or verb
        third = get("V;PRS;3;SG") or irregular_3sg.get(verb) or (verb[:-1] + "ies" if verb.endswith("y") and len(verb) > 1 and verb[-2] not in "aeiou" else verb + ("es" if verb.endswith(("s", "sh", "ch", "x", "z", "o")) else "s"))
        if verb == "be":
            base, third = "am", "is"
        elif verb == "have":
            base, third = "have", "has"
        if not past or not participle:
            continue
        irregular = not past.endswith("ed") or verb in IRREGULAR_D_PASTS
        level = "A1" if zipf_frequency(verb, "en") >= 5.5 else "A2" if zipf_frequency(verb, "en") >= 4.5 else "B1" if zipf_frequency(verb, "en") >= 3.5 else "B2"
        out.append({
            "infinitief": verb,
            "fr": fr,
            "present": {"ik": base, "jij": base, "hij": third, "wij": base},
            "preteritum": past,
            "participePasse": participle,
            "auxiliaire": "have",
            "exempleNl": "",
            "exempleFr": "",
            "freq": round(zipf_frequency(verb, "en"), 2),
            "niveauCECR": level,
            "niveauCECRSource": "freq",
            "irregulier": irregular,
        })
    OUTPUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(out)} verbs written to {OUTPUT}")


if __name__ == "__main__":
    main()
