# Socle de données pour le russe et l'arabe

Ce dossier reste un prototype parallèle au parcours principal. Les fichiers de sources volumineux sont conservés localement dans `data/reference/sources_ru_ar/` et ne font pas partie de l'application.

## Premier noyau aligné sur le néerlandais

Les fichiers candidats ne sont pas un choix indépendant de mots russes/arabe : ils reprennent les **3 031 lignes** des cinq fichiers de vocabulaire néerlandais de l'application (`NOMS_NL`, `VERBES_NL`, `ADJECTIFS_NL`, `ADVERBES_NL`, `MOTS_OUTILS_NL`). Les traductions françaises, fréquences, priorités, niveaux CECR et catégories sont copiés comme références. Les nouveaux champs de traduction et de prononciation sont vides et marqués à produire/valider.

Fichiers générés dans `experimental/phonetics/data/` :

- `noms_ru.csv`, `verbes_ru.csv`, `adjectifs_ru.csv`, `adverbes_ru.csv`, `mots_outils_ru.csv`
- `noms_ar.csv`, `verbes_ar.csv`, `adjectifs_ar.csv`, `adverbes_ar.csv`, `mots_outils_ar.csv`

Le format reprend le séparateur `;`, les identifiants par catégorie et les métadonnées de priorité/niveau du corpus néerlandais. Les colonnes `ru`/`ar`, `prononciation`, `ipa` et les champs grammaticaux propres à la catégorie sont prévues pour le travail à venir. Ces CSV ne sont pas encore chargés par l'application.

Le script reproductible est `experimental/phonetics/scripts/build_vocab_bases.py`. Il relit directement les cinq CSV NL et régénère ces dix fichiers.

## Pivot élargi français, anglais, espagnol

Pour couvrir plus que le seul noyau NL, le script `experimental/phonetics/scripts/build_master_fr_pivot.py` réunit les cinq catégories NL (3 031 lignes), `VOCAB_EN.csv` (3 000 lignes) et `VOCAB_ES.csv` (3 000 lignes). Il crée **4 761 entrées candidates** en regroupant par première glose française normalisée, avec formes et références aux sources conservées. Parmi elles, 882 sont représentées dans les trois corpus, 1 065 dans deux corpus et 2 814 dans un seul.

Ce regroupement est un dédoublonnage de travail, pas une validation sémantique : une même première glose peut cacher des sens distincts, et plusieurs synonymes d'une cellule peuvent représenter des entrées séparées. Chaque groupe conserve ses variantes et toutes ses références afin qu'on puisse repérer et corriger les collisions.

`experimental/phonetics/data/pivot_ru_a_traduire.csv` et `pivot_ar_a_traduire.csv` contiennent chacun le pivot de 4 761 lignes, les formulations françaises d'origine, les mots néerlandais/anglais/espagnols disponibles, les catégories et les métadonnées de fréquence/niveau propres à chaque source. Les colonnes cibles et phonétiques sont à remplir et vérifier. Les fréquences ne sont pas additionnées : les échelles NL, EN et ES diffèrent.

Le script `experimental/phonetics/scripts/build_ru_ar_from_pivot.py` régénère les deux bases de traduction depuis le pivot JSON. Les fichiers `*_ru.csv` et `*_ar.csv` par catégorie restent un sous-ensemble de référence de 3 031 lignes, calqué uniquement sur NL.

## Mesure du corpus français structuré

Les dictionnaires français de Wiktionnaire extraits par Kaikki/Wiktextract ont été récupérés en JSONL. Un premier balayage local donne :

| Langue | Entrées totales | Lemmes simples avec définition française | API présente | Écriture vocalisée/forme vocalisée |
| --- | ---: | ---: | ---: | ---: |
| Russe | 212 692 | 51 943 | 17 279 | accent tonique à dériver/valider |
| Arabe | 12 804 | 11 230 | 397 | 322 entrées avec forme vocalisée |

Ce comptage ne signifie pas que toutes les entrées sont adaptées à un vocabulaire A1–B2 : il comprend plusieurs sens, termes rares, noms propres et entrées à contrôler. Il montre toutefois qu'une sélection de 4 000 mots est possible en quantité dans les deux langues. Les traductions françaises sont des gloses de dictionnaire, parfois trop brèves ou ambiguës pour être affichées sans révision.

## Sources disponibles

- **Wiktionnaire français via Kaikki/Wiktextract** : mots, catégories grammaticales, définitions françaises, exemples et parfois IPA. Données dérivées du Wiktionnaire ; conserver attribution et obligations CC BY-SA/GFDL applicables. Dictionnaires traités le 24 octobre 2026, d'après leurs pages de présentation.
- **KELLY** : fichiers XLS officiels et JSON miroir pour le russe et l'arabe ; utiles pour fréquence et niveaux, pas comme traduction française. Le projet annonce des niveaux CECRL et la licence CC BY-NC-SA 2.0 : vérifier les conditions avant toute redistribution publique ou usage commercial.
- **OpenRussian** : lexique russe, formes fléchies, accent tonique, glosses anglaises/allemandes ; CC BY-SA 4.0. Il complète le russe, mais n'apporte pas directement le français.
- **AVP arabe A1** : ressource pédagogique plus petite, intéressante pour des formes vocalisées et un vocabulaire validé. Ne suffit pas à fournir 4 000 mots.
- **Arabterm** : base multilingue arabe/français/anglais spécialisée en terminologie. Une copie locale est présente, mais aucune licence de réutilisation n'a été confirmée ; ne pas l'utiliser tant que ce point n'est pas résolu.

## Règle de données pour le prototype

Une future entrée doit garder côte à côte : `fr`, `native`, `romanisation`, `ipa`, `pos`, `niveau`, `source` et `statut_validation`. Aucun caractère cyrillique ou arabe ne doit apparaître seul dans une consigne ou un exercice destiné à l'apprenant : l'écriture native et son aide de lecture sont affichées ensemble.

La translittération n'est pas automatiquement une prononciation fiable. En russe, l'accent tonique et les voyelles réduites doivent être indiqués. En arabe, l'orthographe courante omet les voyelles brèves : une translittération purement lettre-à-lettre ne permet pas de reconstruire la prononciation. Les entrées arabes sans vocalisation ou audio/IPA doivent recevoir une lecture proposée puis vérifiée, plutôt que d'être présentées comme phonétiquement exactes.

## Licence et intégration

Les données sources ne doivent pas être copiées dans le bundle principal ni publiées sans revue de licence et attribution. Les sources téléchargées sont ignorées par Git avec la règle locale du dossier de sources. Le prototype reste hors de `LANG_PACKS` jusqu'à ce que le format, la phonétique, les exercices et les licences soient validés.

## Liens

- [Dictionnaire russe Kaikki](https://kaikki.org/frwiktionary/Russe/index.html)
- [Dictionnaire arabe Kaikki](https://kaikki.org/frwiktionary/Arabe/index.html)
- [Projet KELLY](https://ssharoff.github.io/kelly/)
- [Données OpenRussian](https://github.com/Badestrand/russian-dictionary)
- [Profil arabe A1 AVP](https://lailafamiliar.github.io/A1-AVP-dataset/)
- [Arabterm](https://github.com/forzagreen/arabterm)
