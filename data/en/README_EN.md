# Données anglaises

`VOCAB_EN.csv` est généré par `tools/en/build_vocab_en.py` à partir de `wordfreq` et du dictionnaire bilingue Apertium français → anglais conservé localement dans `data/reference/sources_en/`.

- Les traductions déjà présentes dans `NOMEN.csv` sont conservées lorsqu'elles correspondent au lemme anglais (669 entrées après séparation des lemmes alternatifs).
- Les autres traductions sont des candidats extraits d'Apertium et sont marqués `apertium_a_verifier`. Elles doivent être relues avant de servir de référence pédagogique.
- Les fréquences sont des scores Zipf de `wordfreq`; les niveaux CECR sont estimés par seuils de fréquence, pas validés par un lexique CECR anglais.
- Les formes de `conjugation_en.json` sont produites par `tools/en/build_conjugation_en.py` à partir d'UniMorph English, licence CC BY-SA 3.0. Apertium est sous GPL-2.0 ; voir les licences et sources conservées localement dans `data/reference/sources_en/`.

Les scripts attendent Python 3.12 avec `wordfreq` et les fichiers sources locaux. Les sources complètes ne sont pas chargées par l'application. Les deux verbes auxiliaires `be` et `have` sont vérifiés explicitement dans le générateur.
