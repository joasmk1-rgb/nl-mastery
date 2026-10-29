#!/usr/bin/env python3
"""Create isolated Russian/Arabic vocabulary templates aligned to the Dutch core."""

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE_DIR = ROOT
OUT_DIR = ROOT / "experimental/phonetics/data"
FILES = {
    "NOMS_NL.csv": ("noms", ["genre", "pluriel"]),
    "VERBES_NL.csv": ("verbes", ["aspect", "passe", "participe"]),
    "ADJECTIFS_NL.csv": ("adjectifs", []),
    "ADVERBES_NL.csv": ("adverbes", []),
    "MOTS_OUTILS_NL.csv": ("mots_outils", []),
}
LANGS = ("ru", "ar")
BASE_FIELDS = [
    "id", "fr", "TARGET_WORD", "prononciation", "ipa", "freq",
    "statut_examen", "priorite_frequence", "niveauCECR", "niveauCECRSource",
    "sousCategorie", "source_fr", "statut_traduction", "statut_prononciation",
]


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = {lang: 0 for lang in LANGS}
    for source_name, (category, extra) in FILES.items():
        source = SOURCE_DIR / source_name
        with source.open(encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f, delimiter=";")
            rows = list(reader)

        for lang in LANGS:
            fields = [lang if field == "TARGET_WORD" else field for field in BASE_FIELDS] + extra
            output = OUT_DIR / f"{category}_{lang}.csv"
            with output.open("w", encoding="utf-8-sig", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=fields, delimiter=";", extrasaction="ignore")
                writer.writeheader()
                for index, row in enumerate(rows):
                    if not row.get("fr", "").strip() or not row.get("nl", "").strip():
                        continue
                    out = {
                        "id": f"{source_name[:-7]}_{lang.upper()}_{index}",
                        "fr": row.get("fr", "").strip(),
                        lang: "",
                        "prononciation": "",
                        "ipa": "",
                        "freq": row.get("freq", ""),
                        "statut_examen": row.get("statut_examen", ""),
                        "priorite_frequence": row.get("priorite_frequence", ""),
                        "niveauCECR": row.get("niveauCECR", ""),
                        "niveauCECRSource": row.get("niveauCECRSource", ""),
                        "sousCategorie": row.get("sousCategorie", ""),
                        "source_fr": f"{source_name}:{row.get('id', '')}",
                        "statut_traduction": "a_produire",
                        "statut_prononciation": "a_produire_et_verifier",
                    }
                    for field in extra:
                        out[field] = ""
                    writer.writerow(out)
                    total[lang] += 1

    print(f"Base alignée sur le noyau néerlandais: {sum(total.values()) // 2} entrées par langue")
    print("Russe:", total["ru"], "Arabe:", total["ar"])
    print("Les champs cibles vides sont intentionnels; ce sont des bases à traduire et valider.")


if __name__ == "__main__":
    main()
