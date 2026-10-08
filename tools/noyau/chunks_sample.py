"""Echantillon de blocs : pour quelques mots, les suites de 2 a 4 mots les plus frequentes
qui les contiennent, avec une phrase d'exemple traduite (paires Tatoeba fr-nl)."""
import os, pickle, re, sys
from collections import Counter, defaultdict

corpus_dir, out_dir = sys.argv[1], sys.argv[2]
targets = sys.argv[3:]
docs = pickle.load(open(os.path.join(out_dir, 'lemmas.pkl'), 'rb'))

nl = open(os.path.join(corpus_dir, 'Tatoeba.fr-nl.nl'), encoding='utf-8').read().split('\n')
fr = open(os.path.join(corpus_dir, 'Tatoeba.fr-nl.fr'), encoding='utf-8').read().split('\n')
pairs = [(a.strip(), b.strip()) for a, b in zip(nl, fr) if a.strip() and b.strip()]

FUNC = {'DET', 'ADP', 'PRON', 'AUX', 'CCONJ', 'SCONJ', 'PART'}
BAD_EDGE = {'PUNCT', 'SYM', 'SPACE'}
grams = defaultdict(Counter)
for d in docs:
    toks = [(t.lower(), l, p) for t, l, p in d]
    n = len(toks)
    for i in range(n):
        for size in (2, 3, 4):
            g = toks[i:i + size]
            if len(g) < size or any(p in BAD_EDGE or p == 'PROPN' for _, _, p in g):
                continue
            # un bloc ne finit pas sur un mot-outil "ouvert" (de, een, in...) : il serait incomplet
            if g[-1][2] in {'DET', 'ADP', 'CCONJ', 'SCONJ'} or g[0][2] in {'CCONJ'}:
                continue
            lemmas = {l for _, l, _ in g}
            for t in targets:
                if t in lemmas:
                    grams[t][' '.join(w for w, _, _ in g)] += 1

for t in targets:
    scored = []
    for g, c in grams[t].items():
        if c < 4:
            continue
        scored.append((c * (1 + 0.6 * (len(g.split()) - 2)), c, g))
    scored.sort(reverse=True)
    kept = []
    for _, c, g in scored:
        if any(g in k or k in g for _, k in kept):   # evite "iedere dag" + "bijna iedere dag"
            continue
        kept.append((c, g))
        if len(kept) == 6:
            break
    print(f'\n== {t}')
    for c, g in kept:
        ex = next(((a, b) for a, b in pairs if re.search(r'(?<!\w)' + re.escape(g) + r'(?!\w)', a.lower()) and len(a) < 70), None)
        print(f'  {c:5d}  {g:28s}', ('| ' + ex[0] + '  =  ' + ex[1]) if ex else '')
