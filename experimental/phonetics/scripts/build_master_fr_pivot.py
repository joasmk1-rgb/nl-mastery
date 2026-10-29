#!/usr/bin/env python3
"""Build a deduplicated French pivot candidate catalog from NL, EN and ES vocabularies.

Deduplication is conservative: it merges rows sharing the same normalized first
French gloss, retaining every original gloss, language form and source reference.
This is a reviewable candidate catalog, not a claim that every merge is semantic.
"""

import csv
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "experimental/phonetics/data"
NL_FILES = {
    "NOMS_NL.csv": "nom",
    "VERBES_NL.csv": "verbe",
    "ADJECTIFS_NL.csv": "adjectif",
    "ADVERBES_NL.csv": "adverbe",
    "MOTS_OUTILS_NL.csv": "mot-outil",
}


def read_rows(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle, delimiter=";"))


def first_gloss(value):
    value = re.sub(r"\s*/\s*\([^)]*\)\s*$", "", value.strip())
    return re.split(r"\s*/\s*", value, maxsplit=1)[0].strip()


def pivot_key(value):
    value = first_gloss(value).casefold()
    value = unicodedata.normalize("NFKC", value).replace("’", "'")
    value = re.sub(r"\s+", " ", value).strip(" .,:;!?\u00a0")
    # Articles attached to a content noun are variants of its French pivot.
    # Keep function words themselves (le, la, de, etc.) as separate entries.
    stripped = re.sub(r"^(?:l'|le |la |les |un |une |des |du |de la )", "", value)
    return stripped or value


def add(groups, lang, row, category, source_name):
    fr = (row.get("fr") or "").strip()
    target = (row.get(lang) or "").strip()
    if not fr:
        return
    key = pivot_key(fr)
    if not key:
        return
    group = groups[key]
    group["fr_variantes"].setdefault(fr, None)
    group["categories"].add(category or "non_classee")
    group["sources"].append({
        "langue": lang,
        "fichier": source_name,
        "id": row.get("id", ""),
        "fr_source": fr,
        "forme_source": target,
        "freq_source": row.get("freq", ""),
        "niveauCECR": row.get("niveauCECR", ""),
        "niveauCECRSource": row.get("niveauCECRSource", ""),
        "priorite_frequence": row.get("priorite_frequence", ""),
        "traductionSource": row.get("traductionSource", ""),
    })
    if target and target not in group["formes"][lang]:
        group["formes"][lang].append(target)


def main():
    groups = defaultdict(lambda: {"fr_variantes": {}, "categories": set(), "sources": [],
                                  "formes": {"nl": [], "en": [], "es": []}})
    for filename, category in NL_FILES.items():
        for row in read_rows(ROOT / filename):
            add(groups, "nl", row, category, filename)

    for lang in ("en", "es"):
        path = ROOT / "data" / lang / f"VOCAB_{lang.upper()}.csv"
        for row in read_rows(path):
            add(groups, lang, row, row.get("categorie", ""), str(path.relative_to(ROOT)))

    records = []
    for key, group in groups.items():
        sources = group["sources"]
        # These indicators are not frequency scores across languages; they show
        # how broadly the French pivot is represented in the three source packs.
        present = sorted({source["langue"] for source in sources})
        records.append({
            "fr_pivot": key,
            "fr_variantes_sources": list(group["fr_variantes"]),
            "formes": group["formes"],
            "categories": sorted(group["categories"]),
            "langues_sources": present,
            "presence_sources": len(present),
            "statut_dedoublonnage": "fusion_candidate_a_revoir" if len(sources) > 1 else "unique_source",
            "sources": sources,
        })

    # Put entries supported by multiple language lists first; this gives a
    # practical shared core while preserving the full long tail.
    records.sort(key=lambda item: (-item["presence_sources"], item["fr_pivot"]))
    for i, record in enumerate(records, 1):
        record["id"] = f"FRP{i:05d}"

    OUT.mkdir(parents=True, exist_ok=True)
    metadata = {
        "description": "Pivot candidat français issu des listes existantes NL/EN/ES.",
        "source_rows": {"nl": sum(len(read_rows(ROOT / f)) for f in NL_FILES),
                        "en": len(read_rows(ROOT / "data/en/VOCAB_EN.csv")),
                        "es": len(read_rows(ROOT / "data/es/VOCAB_ES.csv"))},
        "pivot_candidates": len(records),
        "method": "Première glose française normalisée; variantes et références sources conservées.",
        "warning": "Les fusions proposées doivent être relues: chaînes françaises identiques ou proches ne garantissent pas toujours le même sens.",
        "frequency_note": "Les fréquences ont des échelles et sources différentes selon NL, EN et ES; elles ne sont pas additionnées.",
    }
    output = OUT / "pivot_fr_nl_en_es.json"
    output.write_text(json.dumps({"metadata": metadata, "concepts": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    counts = {n: sum(record["presence_sources"] == n for record in records) for n in (1, 2, 3)}
    print(f"Source rows: {metadata['source_rows']}; French pivot candidates: {len(records)}")
    print("Represented in 1 / 2 / 3 source languages:", counts)
    print("Output:", output.relative_to(ROOT))


if __name__ == "__main__":
    main()
