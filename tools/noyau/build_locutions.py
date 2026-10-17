"""Construit LOCUTIONS_NL.csv à partir de candidats_expressions_corpus.csv.

Filtre : remarque_qualite commence par « utile » ou « vocabulaire », sans « fragment
grammatical » ni « bruit wikipedia ». Catégorie et niveau CECR attribués à la main ligne par
ligne (indices = ordre des lignes retenues). Fréquence : Zipf de la locution dans le corpus
source (Leipzig nld_mixed_2012_1M, ~17 M de mots) = log10(occurrences / 17e6 * 1e9).
"""
import sys, csv, math

SRC, OUT = sys.argv[1], sys.argv[2]

CATS = {
    'C': 'Connecteurs de discours (écrit)',
    'P': 'Locutions prépositionnelles figées',
    'I': 'Expressions idiomatiques (écrit/figuré)',
    'A': 'Vocabulaire institutionnel & administratif',
    'T': 'Expressions de temps (écrit)',
    'Q': 'Expressions de quantité & comparaison (écrit)',
}

# Tout ce qui n'est pas listé ici est une locution prépositionnelle (P).
CAT_LISTS = {
    'T': [16, 20, 21, 64, 78, 80, 84, 85, 87, 88, 89, 90, 91, 92, 96, 97, 98, 99, 131, 132, 158, 159,
          174, 194, 203, 204, 221, 222, 233, 244, 258, 274, 275, 286, 287, 291, 308, 309, 322, 323,
          333, 334, 338, 339, 382, 422, 423, 425, 426, 433, 434, 435, 444, 445, 453, 462, 469, 473,
          480, 481, 482, 486, 499, 524],
    'Q': [2, 7, 11, 13, 19, 50, 67, 69, 70, 108, 113, 133, 156, 157, 168, 169, 170, 173, 230, 236,
          281, 298, 299, 300, 302, 349, 350, 371, 372, 383, 395, 406, 407, 416, 424, 471, 487, 518,
          519, 520, 521, 529],
    'C': [9, 10, 14, 22, 25, 27, 43, 61, 62, 63, 83, 86, 101, 102, 103, 104, 105, 106, 110, 141, 142,
          144, 147, 172, 182, 183, 186, 187, 202, 232, 242, 255, 265, 266, 267, 270, 271, 272, 273,
          284, 292, 294, 301, 348, 359, 360, 361, 368, 374, 429, 430, 440, 448, 457, 458, 465, 472,
          500, 508, 517, 527],
    'A': [28, 32, 34, 35, 47, 53, 59, 60, 109, 129, 136, 176, 177, 188, 189, 198, 199, 206, 214, 220,
          227, 234, 240, 253, 259, 279, 280, 304, 305, 314, 315, 326, 327, 328, 330, 331, 332, 337,
          340, 345, 351, 355, 358, 362, 364, 366, 377, 385, 400, 419, 441, 443, 468, 470, 478, 479,
          488, 503, 504, 514, 515, 525],
    'I': [1, 4, 5, 12, 31, 41, 45, 65, 68, 72, 79, 81, 82, 93, 107, 116, 117, 118, 119, 124, 130, 137,
          146, 148, 149, 153, 162, 163, 164, 165, 167, 181, 196, 207, 216, 217, 218, 225, 231, 237,
          238, 239, 247, 250, 254, 257, 261, 263, 264, 282, 283, 288, 296, 297, 321, 325, 329, 335,
          341, 344, 365, 380, 386, 390, 392, 394, 396, 397, 399, 402, 403, 405, 410, 411, 415, 427,
          436, 437, 447, 452, 456, 460, 461, 475, 483, 489, 491, 502, 509],
}

# Niveau par défaut : B1.
LEVEL_LISTS = {
    'A2': [6, 15, 17, 46, 49, 51, 52, 54, 55, 66, 90, 95, 100, 111, 112, 114, 125, 131, 132, 153,
           158, 175, 180, 190, 197, 203, 208, 209, 215, 217, 218, 226, 233, 235, 248, 249, 256, 263,
           273, 274, 286, 288, 291, 293, 295, 306, 309, 325, 333, 334, 336, 344, 394, 404, 411, 412,
           428, 433, 462, 476, 477, 480, 482, 485, 489, 491, 494, 498, 499, 501, 505, 506, 510, 511,
           524, 530],
    'B2': [1, 24, 25, 28, 29, 30, 31, 34, 35, 36, 39, 41, 47, 53, 68, 82, 93, 101, 102, 103, 104,
           105, 116, 118, 119, 124, 129, 147, 154, 160, 161, 172, 176, 187, 198, 199, 206, 214, 220,
           225, 250, 267, 270, 271, 272, 279, 280, 292, 315, 318, 319, 320, 326, 330, 331, 332, 340,
           358, 362, 364, 366, 368, 377, 385, 390, 402, 410, 418, 436, 437, 440, 441, 447, 454, 456,
           460, 461, 464, 465, 468, 471, 472, 503, 504, 515, 520],
    'C1': [32, 130, 177, 181, 240, 259, 264, 327, 351, 397, 427, 443, 452],
}

rows = list(csv.DictReader(open(SRC, encoding='utf-8-sig'), delimiter=';'))
keep = [r for r in rows if r['remarque_qualite'].strip().lower().startswith(('utile', 'vocabulaire'))
        and 'fragment grammatical' not in r['remarque_qualite'].lower()
        and 'bruit wikipedia' not in r['remarque_qualite'].lower()]
n = len(keep)

cat_of = {}
for c, idxs in CAT_LISTS.items():
    for i in idxs:
        assert i not in cat_of, f'index {i} classé deux fois ({cat_of[i]} et {c})'
        assert 0 <= i < n, i
        cat_of[i] = c
lvl_of = {}
for l, idxs in LEVEL_LISTS.items():
    for i in idxs:
        assert i not in lvl_of, f'niveau en double pour {i}'
        lvl_of[i] = l

clean = lambda s: s.replace(';', ',').replace('\n', ' ').strip()
counts = {}
with open(OUT, 'w', encoding='utf-8', newline='') as f:
    f.write('id;fr;nl;freq;priorite_frequence;niveauCECR;niveauCECRSource;sousCategorie;sousCategorieSource\n')
    for i, r in enumerate(keep):
        occ = int(r['occurrences'])
        zipf = round(math.log10(occ / 17e6 * 1e9), 2)
        # Une locution de 3-4 mots est toujours moins fréquente qu'un mot seul : seuil adapté
        # (≥ 300 occurrences dans le corpus, Zipf ≈ 4.25) plutôt que celui des mots (Zipf ≥ 5).
        prio = 'Essentiel' if occ >= 300 else 'Courant'
        cat = CATS[cat_of.get(i, 'P')]
        counts[cat] = counts.get(cat, 0) + 1
        f.write(';'.join([f'LOCUTIONS_NL_{i}', clean(r['traduction_fr']), clean(r['ngram']), str(zipf), prio,
                          lvl_of.get(i, 'B1'), 'estimation_manuelle', cat, 'manuel']) + '\n')
print(n, 'lignes')
for k, v in sorted(counts.items(), key=lambda x: -x[1]): print(v, k)
import collections
print(collections.Counter(lvl_of.get(i, 'B1') for i in range(n)))
