# Lexiques de référence CEFRLex

Lexiques gradués selon le CECR, produits par le projet CEFRLex (CENTAL, UCLouvain et
partenaires) : https://cental.uclouvain.be/cefrlex/

Ils ne sont PAS chargés par l'app. Ils servent de source pour classer le vocabulaire par
niveau (NT2Lex aujourd'hui) et de base pour les futures versions anglaise et espagnole.

| Fichier | Langue | Entrées | Contenu |
|---|---|---|---|
| `NT2Lex-CGN+ODWN-v01.tsv` | néerlandais | 17 743 lignes (un mot peut en avoir plusieurs, une par sens) | fréquences par niveau A1→C1 + identifiants de sens Open Dutch WordNet |
| `FLELex-TT-Beacco.tsv` | français | 14 236 | fréquences A1→C2 + une colonne `level` (niveau unique par mot) |
| `FLELex-CRF.csv` | français | 17 871 | fréquences A1→C2, inclut les expressions à plusieurs mots (séparateur : tabulation) |
| `EFLLex.tsv` | anglais | 15 280 | fréquences A1→C1, inclut les expressions à plusieurs mots |
| `ELELex.tsv` | espagnol | 14 290 | fréquences A1→C1 |

Téléchargés le 2026-10-08 depuis https://cental.uclouvain.be/cefrlex/download/ (NT2Lex : déjà
présent avant cette date).

**Seul NT2Lex est dans le dépôt.** Les fichiers français, anglais et espagnol restent sur le PC
de Joas (listés dans `.gitignore`) tant qu'ils ne sont pas réellement utilisés. Sur une autre
machine, les retélécharger depuis le lien ci-dessus sous les noms du tableau.

## À savoir

- Aucun de ces fichiers ne contient de traduction : chacun ne décrit que sa propre langue.
- Seul NT2Lex a des identifiants de sens (colonnes `sense_se-id` / `sense_sy-id`, reliées à
  WordNet). Les trois autres n'en ont pas : un pont automatique entre langues par WordNet
  n'est donc possible qu'en partant du néerlandais.
- Seul `FLELex-TT-Beacco.tsv` donne directement un niveau par mot. Pour les autres, le niveau
  se déduit des fréquences (premier niveau où le mot apparaît de façon significative).

## Licence

Tous ces fichiers sont sous licence Creative Commons Attribution - Pas d'Utilisation
Commerciale - Partage dans les Mêmes Conditions 4.0 (CC BY-NC-SA 4.0) :
https://creativecommons.org/licenses/by-nc-sa/4.0/

Usage non commercial uniquement. Si l'app devient commerciale, il faudra retirer ces fichiers
et tout ce qui en est dérivé (voir les champs `niveauCECRSource == 'nt2lex'`).

## Références à citer

- NT2Lex : Tack, A., François, T., Desmet, P. & Fairon, C. (2018). NT2Lex: A CEFR-Graded
  Lexical Resource for Dutch as a Foreign Language Linked to Open Dutch WordNet. BEA 2018.
- FLELex : François, T., Gala, N., Watrin, P. & Fairon, C. (2014). FLELex: a graded lexical
  resource for French foreign learners. LREC 2014.
- FLELex / Beacco : Pintard, A. & François, T. (2020). Combining expert knowledge with
  frequency information to infer CEFR levels for words. READI 2020.
- EFLLex : Dürlich, L. & François, T. (2018). EFLLex: A Graded Lexical Resource for Learners
  of English as a Foreign Language. LREC 2018.
- ELELex : article de référence à paraître (voir le site CEFRLex).
