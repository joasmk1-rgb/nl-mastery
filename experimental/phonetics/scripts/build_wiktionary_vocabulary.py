#!/usr/bin/env python3
"""Build reviewable RU/AR starter vocabularies from the French Wiktionary dump.

The downloaded Kaikki JSONL files are local inputs and are not committed. Outputs
keep one source URL per entry and mark glosses/transcriptions for human review.
"""

import argparse
import json
import re
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PIVOT = ROOT / "experimental/phonetics/data/pivot_fr_nl_en_es.json"
OUT = ROOT / "experimental/phonetics/data"
SKIP_TAGS = {"obsolete", "archaic", "rare", "dated", "nonstandard"}

RU_LATIN = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e",
    "ё": "yo", "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k",
    "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "",
    "э": "e", "ю": "yu", "я": "ya",
}
AR_LATIN = {
    "ا": "ā", "أ": "ʾa", "إ": "ʾi", "آ": "ʾā", "ء": "ʾ", "ؤ": "ʾū",
    "ئ": "ʾī", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "ḥ",
    "خ": "kh", "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s",
    "ش": "sh", "ص": "ṣ", "ض": "ḍ", "ط": "ṭ", "ظ": "ẓ", "ع": "ʿ",
    "غ": "gh", "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m",
    "ن": "n", "ه": "h", "و": "ū", "ي": "ī", "ى": "ā", "ة": "a",
    "پ": "p", "چ": "ch", "ژ": "zh", "گ": "g",
    "َ": "a", "ً": "an", "ُ": "u", "ٌ": "un", "ِ": "i", "ٍ": "in",
    "ْ": "", "ٰ": "ā", "ّ": "",
}
AR_DIACRITICS = {"َ", "ً", "ُ", "ٌ", "ِ", "ٍ", "ْ", "ٰ", "ّ"}


def normalize(text):
    text = unicodedata.normalize("NFKC", text.casefold()).replace("’", "'")
    text = re.sub(r"\([^)]*\)", " ", text)
    return re.sub(r"[^\w\s]", "", text, flags=re.UNICODE).strip()


def transliterate(text, lang):
    table = RU_LATIN if lang == "ru" else AR_LATIN
    out = []
    chars = list(text.casefold())
    for i, char in enumerate(chars):
        if lang == "ar" and char == "ّ":
            prior = next((x for x in reversed(out) if x.isalpha()), "")
            if prior:
                out.append(prior)
        elif char in table:
            out.append(table[char])
        elif char in ("-", "'", "’", " "):
            out.append(char)
        elif lang == "ar" and char == "َ" and i > 0:
            out.append("a")
    result = "".join(out)
    result = re.sub(r"\s+", " ", result).strip()
    return result


def source_url(lang, word):
    from urllib.parse import quote
    return f"https://fr.wiktionary.org/wiki/{quote(word.replace(' ', '_'))}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources-dir", type=Path, default=ROOT / "data/reference/sources_ru_ar")
    parser.add_argument("--minimum", type=int, default=0, help="Stop after this many concepts for a small pilot")
    args = parser.parse_args()
    concepts = json.loads(PIVOT.read_text(encoding="utf-8"))["concepts"]
    pivot_by_key = {}
    for concept in concepts:
        variants = set(concept.get("fr_variantes_sources", [])) | {concept["fr_pivot"]}
        for variant in variants:
            key = normalize(variant)
            if key:
                pivot_by_key.setdefault(key, concept)

    for lang in ("ru", "ar"):
        candidates = {}
        path = args.sources_dir / f"kaikki_{lang}.jsonl"
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                entry = json.loads(line)
                word = str(entry.get("word", "")).strip()
                if not word or len(word) > 48 or any(ch.isspace() for ch in word):
                    continue
                if not (re.search(r"[А-Яа-яЁё]", word) if lang == "ru" else re.search(r"[\u0600-\u06ff]", word)):
                    continue
                tags = {str(x).casefold() for x in entry.get("tags", []) + entry.get("raw_tags", [])}
                if tags & SKIP_TAGS:
                    continue
                ipa = next((s.get("ipa", "") for s in entry.get("sounds", []) if s.get("ipa")), "")
                for sense in entry.get("senses", []):
                    for gloss in sense.get("glosses", []):
                        concept = pivot_by_key.get(normalize(str(gloss).rstrip(".")))
                        if not concept:
                            continue
                        categories = concept.get("categories", [])
                        pos = str(entry.get("pos", ""))
                        wanted = {"nom": "noun", "verbe": "verb", "adjectif": "adj", "adverbe": "adv"}
                        pos_match = any(wanted.get(cat) == pos for cat in categories)
                        score = (int(bool(ipa)), int(pos_match), -len(word), -len(tags))
                        key = concept["id"]
                        current = candidates.get(key)
                        if current and current["_score"] >= score:
                            continue
                        candidates[key] = {
                            "id": key,
                            "fr": concept["fr_pivot"],
                            "native": word,
                            "romanisation": transliterate(word, lang),
                            "ipa": ipa,
                            "pos": pos,
                            "categories": categories,
                            "presence_sources": concept.get("presence_sources", 1),
                            "source": "Wiktionnaire français (extraction Kaikki/Wiktextract)",
                            "source_url": source_url(lang, word),
                            "statut_traduction": "glosse_de_dictionnaire_a_verifier",
                            "statut_prononciation": "ipa_source" if ipa else "translitteration_automatique_a_verifier",
                            "_score": score,
                        }
        records = list(candidates.values())
        records.sort(key=lambda x: (-x["presence_sources"], x["fr"].casefold(), x["id"]))
        if args.minimum:
            records = records[:args.minimum]
        for row in records:
            row.pop("_score", None)
        output = OUT / f"vocabulary_{lang}.json"
        payload = {
            "langue": lang,
            "nombre": len(records),
            "source": "Kaikki/Wiktextract, extrait du Wiktionnaire français",
            "licence": "CC BY-SA 4.0 / GFDL selon les notices sources ; données dérivées à attribuer et partager à l’identique",
            "avertissement": "Glosses et translittérations extraites automatiquement ; vérifier avant usage pédagogique. La translittération arabe ne restitue pas les voyelles brèves absentes de l’écriture non vocalisée.",
            "mots": records,
        }
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{lang}: {len(records)} entrées candidates -> {output}")


if __name__ == "__main__":
    main()
