#!/usr/bin/env python3
"""Create RU/AR translation workbooks from the shared French pivot."""

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PIVOT = ROOT / "experimental/phonetics/data/pivot_fr_nl_en_es.json"
OUT = ROOT / "experimental/phonetics/data"


def first(values):
    return next((value for value in values if value), "")


def best_freq(sources, lang):
    values = []
    for source in sources:
        if source["langue"] == lang:
            try:
                values.append(float(source["freq_source"]))
            except (TypeError, ValueError):
                pass
    return str(max(values)) if values else ""


def main():
    data = json.loads(PIVOT.read_text(encoding="utf-8"))
    fields = ["id", "fr", "fr_variantes", "TARGET", "prononciation", "ipa", "categories",
              "formes_nl", "formes_en", "formes_es", "freq_nl", "freq_en", "freq_es",
              "niveauCECR_nl", "niveauCECR_en", "niveauCECR_es", "source_refs",
              "statut_traduction", "statut_prononciation"]
    for lang in ("ru", "ar"):
        output = OUT / f"pivot_{lang}_a_traduire.csv"
        columns = [lang if name == "TARGET" else name for name in fields]
        with output.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, delimiter=";", lineterminator="\n")
            writer.writeheader()
            for concept in data["concepts"]:
                sources = concept["sources"]
                row = {
                    "id": concept["id"],
                    "fr": concept["fr_pivot"],
                    "fr_variantes": " | ".join(concept["fr_variantes_sources"]),
                    lang: "",
                    "prononciation": "",
                    "ipa": "",
                    "categories": " | ".join(concept["categories"]),
                    "formes_nl": " | ".join(concept["formes"]["nl"]),
                    "formes_en": " | ".join(concept["formes"]["en"]),
                    "formes_es": " | ".join(concept["formes"]["es"]),
                    "freq_nl": best_freq(sources, "nl"),
                    "freq_en": best_freq(sources, "en"),
                    "freq_es": best_freq(sources, "es"),
                    "niveauCECR_nl": first(s["niveauCECR"] for s in sources if s["langue"] == "nl"),
                    "niveauCECR_en": first(s["niveauCECR"] for s in sources if s["langue"] == "en"),
                    "niveauCECR_es": first(s["niveauCECR"] for s in sources if s["langue"] == "es"),
                    "source_refs": " | ".join(f"{s['fichier']}:{s['id']}" for s in sources),
                    "statut_traduction": "a_traduire_et_verifier",
                    "statut_prononciation": "a_produire_et_verifier",
                }
                writer.writerow(row)
        print(f"{lang}: {len(data['concepts'])} concepts -> {output.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
