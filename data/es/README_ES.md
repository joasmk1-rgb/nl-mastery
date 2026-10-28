# Données espagnoles

`VOCAB_ES.csv` est généré par `tools/es/build_vocab_es.py` à partir d'ELELex, du dictionnaire français–espagnol Apertium et des lexiques espagnols déjà présents (`NOMES.csv`, `VERBESES.csv`, `ADJES.csv`).

- 3 000 entrées sont produites. Les traductions des fichiers déjà présents sont prioritaires lorsqu'elles correspondent à une entrée du lexique ; les autres traductions viennent d'Apertium et portent le marqueur `apertium_a_verifier`.
- Les niveaux sont estimés à partir du premier palier ELELex où le mot apparaît dans au moins trois documents. La fréquence globale ELELex sert au classement. Les expressions et homographes ne sont pas tous validés manuellement.
- Les formes de `conjugation_es.json` sont générées à partir d'UniMorph espagnol. Les six personnes sont conservées dans les données ; l'application les présente sous des pronoms espagnols. Le présent, le pretérito indefinido, le pretérito perfecto et le futur sont entraînés.
- `course_es.json` reprend les 31 modules et la répartition A1–B2 du parcours existant, avec notions et exemples espagnols.

## Sources et licences

- ELELex (UCLouvain / CEFRLex), espagnol réceptif gradué : CC BY-NC-SA 4.0. Source locale : `data/reference/ELELex.tsv`.
- Dictionnaire français–espagnol Apertium : GPL-2.0. La copie de licence se trouve dans `data/reference/sources_es/apertium_COPYING`.
- UniMorph espagnol : CC BY-SA 3.0, dérivé de données Wiktionary. Attribution et partage à l'identique à respecter.
- Les sources complètes sont locales dans `data/reference/sources_es/` et ne sont pas chargées par l'application. Les licences, en particulier la restriction non commerciale d'ELELex, doivent être prises en compte avant toute redistribution ou commercialisation.

Les scripts attendent les fichiers sources locaux et Python 3.12. Les données sources ne sont pas incorporées dans les fichiers téléchargés par l'application.
