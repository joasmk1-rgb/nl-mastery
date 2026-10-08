# Outils « noyau de vocabulaire »

Scripts Python (hors app) qui ont servi à définir le noyau de vocabulaire courant et à
compléter les CSV. À relancer seulement si on veut refaire l'analyse.

Prérequis : Python 3.12, `pip install spacy wordfreq`, `python -m spacy download nl_core_news_sm`.

Données à télécharger dans un dossier `corpus/` HORS du dépôt :
- `nld_sentences.tsv.bz2` : https://downloads.tatoeba.org/exports/per_language/nld/
- `Tatoeba.fr-nl.nl` / `.fr` : https://opus.nlpl.eu/Tatoeba.php (paquet Moses fr-nl)

Licence des phrases Tatoeba : CC BY 2.0 FR (réutilisation permise, y compris commerciale, en
citant Tatoeba).

| Script | Rôle |
|---|---|
| `analyse.py corpus projet out` | lemmatise ~200 000 phrases, calcule la couverture (N mots → X % d'un texte) et ce que couvre le vocabulaire de l'app |
| `missing.py out projet 3000` | liste les mots du noyau absents de l'app, validés contre NT2Lex |
| `build_vocab.py out projet [--apply]` | ajoute aux CSV les mots traduits (fichiers `out/tr_*.txt`), fréquence Zipf via wordfreq, niveau CECR via NT2Lex |
| `chunks_sample.py corpus out mot...` | échantillon de blocs fréquents (suites de 2-4 mots) autour de mots donnés, avec exemple traduit |

Résultat d'octobre 2026 : 430 mots couvrent 80 % d'un texte courant, 1 532 → 90 %, 3 000 → 93,7 %.
Le vocabulaire de l'app est passé de 83 % à 91 % de couverture avec l'ajout de 1 378 mots.
