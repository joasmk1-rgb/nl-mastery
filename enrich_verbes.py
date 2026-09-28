#!/usr/bin/env python3
"""
Enrichit VERBES_NL.csv avec, pour chaque verbe :
  - exemple_nl        : une phrase d'exemple business en néerlandais (verbe conjugué)
  - exemple_fr        : sa traduction française
  - forme_frequente   : la forme conjuguée la plus naturelle/fréquente du verbe
  - personne          : la personne grammaticale de cette forme (ik/jij/hij-zij/wij/u...)

À LANCER TOI-MÊME, directement sur ton PC (PAS via Cowork) :
  1. Ouvre une invite de commande / PowerShell dans le dossier "base application neerlandais"
  2. Lance :  python enrich_verbes.py
  3. Colle ta clé API Gemini quand elle est demandée (rien ne s'affiche à l'écran, c'est normal)
  4. Laisse tourner - ça traite les verbes par lots de 15, avec une pause entre chaque lot.
     Le script sauvegarde au fur et à mesure : si ça s'arrête (erreur réseau, quota...),
     relance-le simplement, il reprendra là où il s'était arrêté.
  5. Le résultat est écrit dans VERBES_NL_enrichi.csv (le fichier original n'est pas touché).

La clé n'est jamais écrite dans un fichier - elle n'est utilisée qu'en mémoire pendant
l'exécution, donc aucun risque de la pousser par erreur sur GitHub avec ce script.
"""

import csv
import json
import os
import sys
import time
import getpass
import urllib.request
import urllib.error

MODEL = "gemini-3.5-flash-lite"
INPUT_CSV = "VERBES_NL.csv"
OUTPUT_CSV = "VERBES_NL_enrichi.csv"
BATCH_SIZE = 15
SLEEP_BETWEEN_CALLS = 2  # secondes, marge de sécurité sous le quota gratuit (~30 req/min)


def get_api_key():
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key.strip()
    return getpass.getpass("Colle ta clé API Gemini (invisible à l'écran) : ").strip()


def call_gemini(api_key, batch):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={api_key}"

    items_desc = "\n".join(
        f'{i + 1}. id={v["id"]} | fr="{v["fr"]}" | nl="{v["nl"]}"' for i, v in enumerate(batch)
    )
    prompt = f"""Tu es un expert en néerlandais professionnel (business : marketing, finance, comptabilité, logistique, supply chain).
Pour chacun des verbes néerlandais suivants, donne :
- "exemple_nl" : une phrase d'exemple en néerlandais (niveau B1/B2) utilisant ce verbe dans un contexte professionnel/business, avec le verbe CONJUGUÉ (pas à l'infinitif) dans la phrase
- "exemple_fr" : la traduction française de cette phrase
- "forme_frequente" : la forme conjuguée la plus naturelle/fréquente de ce verbe dans un contexte professionnel courant (souvent la 3e personne du singulier "hij/zij", mais choisis la personne la plus naturelle pour CE verbe précis)
- "personne" : la personne grammaticale utilisée pour "forme_frequente" (ex: "hij/zij", "ik", "wij", "u")

Verbes à traiter :
{items_desc}

Réponds UNIQUEMENT avec un tableau JSON, un objet par verbe, dans le même ordre, avec exactement les clés : id, exemple_nl, exemple_fr, forme_frequente, personne. Pas de texte avant/après, pas de balises markdown."""

    body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.4}
    }).encode("utf-8")

    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} : {e.read().decode('utf-8', 'ignore')[:500]}")

    if "error" in data:
        raise RuntimeError(data["error"].get("message", "Erreur API inconnue"))

    text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    return json.loads(text)


def main():
    if not os.path.exists(INPUT_CSV):
        print(f"ERREUR : {INPUT_CSV} introuvable. Lance ce script depuis le dossier qui le contient.")
        sys.exit(1)

    api_key = get_api_key()
    if not api_key:
        print("Pas de clé fournie, arrêt.")
        sys.exit(1)

    with open(INPUT_CSV, newline='', encoding='utf-8') as f:
        reader = csv.reader(f, delimiter=';')
        header = next(reader)
        rows = [r for r in reader if r and r[0].strip()]

    done_ids = set()
    out_rows = []
    if os.path.exists(OUTPUT_CSV):
        with open(OUTPUT_CSV, newline='', encoding='utf-8') as f:
            reader = csv.reader(f, delimiter=';')
            next(reader, None)
            for r in reader:
                if r:
                    out_rows.append(r)
                    done_ids.add(r[0])
        print(f"Reprise détectée : {len(done_ids)} verbes déjà traités, on continue.")

    new_header = header + ["exemple_nl", "exemple_fr", "forme_frequente", "personne"]
    todo = [r for r in rows if r[0] not in done_ids]
    print(f"{len(todo)} verbes à traiter sur {len(rows)} au total (lots de {BATCH_SIZE}).")

    for i in range(0, len(todo), BATCH_SIZE):
        batch_rows = todo[i:i + BATCH_SIZE]
        batch = [{"id": r[0], "fr": r[1], "nl": r[2]} for r in batch_rows]
        print(f"Lot {i // BATCH_SIZE + 1}/{(len(todo) - 1) // BATCH_SIZE + 1} ({len(batch)} verbes)...", flush=True)

        try:
            results = call_gemini(api_key, batch)
            results_by_id = {str(x.get("id")): x for x in results}
            for r in batch_rows:
                res = results_by_id.get(r[0])
                if res:
                    out_rows.append(r + [
                        res.get("exemple_nl", ""), res.get("exemple_fr", ""),
                        res.get("forme_frequente", ""), res.get("personne", "")
                    ])
                else:
                    print(f"  (!) pas de résultat pour {r[0]}, laissé vide.")
                    out_rows.append(r + ["", "", "", ""])
        except Exception as e:
            print(f"  Erreur sur ce lot : {e}")
            print("  On sauvegarde ce qui est fait. Relance simplement le script pour reprendre là où ça s'est arrêté.")
            break

        with open(OUTPUT_CSV, "w", newline='', encoding='utf-8') as f:
            writer = csv.writer(f, delimiter=';')
            writer.writerow(new_header)
            writer.writerows(out_rows)

        time.sleep(SLEEP_BETWEEN_CALLS)

    print(f"Terminé pour cette exécution. {len(out_rows)}/{len(rows)} verbes dans {OUTPUT_CSV}.")


if __name__ == "__main__":
    main()
