"""Construit data/chunks/chunks_nl.json : pour chaque mot simple du vocabulaire de l'app, ses
blocs les plus frequents (suites de 2 a 4 mots) dans les phrases Tatoeba, chacun avec une
phrase d'exemple traduite en francais. Un bloc sans phrase d'exemple traduite n'est pas garde :
c'est l'exemple qui donne le sens (aucune traduction automatique du bloc lui-meme).

Usage : build_chunks.py corpus out projet"""
import csv, glob, json, os, pickle, re, sys
from collections import Counter, defaultdict

corpus_dir, out_dir, project = sys.argv[1], sys.argv[2], sys.argv[3]
docs = pickle.load(open(os.path.join(out_dir, 'lemmas.pkl'), 'rb'))

def bare(nl):
    return re.sub(r'^(de|het|zich|een)\s+', '', nl.strip().lower())

# mots simples de l'app
targets = set()
for path in glob.glob(os.path.join(project, '*.csv')):
    if os.path.basename(path).startswith('VERBES_NL_enrichi'):
        continue
    with open(path, encoding='utf-8-sig') as f:
        for row in csv.DictReader(f, delimiter=';'):
            for part in re.split(r'[/,]', row.get('nl') or ''):
                w = bare(re.sub(r'\([^)]*\)', '', part))
                if w and ' ' not in w and len(w) > 1:
                    targets.add(w)

nl = open(os.path.join(corpus_dir, 'Tatoeba.fr-nl.nl'), encoding='utf-8').read().split('\n')
fr = open(os.path.join(corpus_dir, 'Tatoeba.fr-nl.fr'), encoding='utf-8').read().split('\n')
pairs = [(a.strip(), b.strip()) for a, b in zip(nl, fr) if a.strip() and b.strip() and 3 <= len(a.split()) <= 16]
pairs.sort(key=lambda p: len(p[0]))                      # exemples courts d'abord
pair_low = [' ' + re.sub(r'[^\w\'-]+', ' ', a.lower()).strip() + ' ' for a, _ in pairs]

EDGE_BAD = {'PUNCT', 'SYM', 'SPACE', 'PROPN', 'X', 'NUM'}
OPEN_END = {'DET', 'ADP', 'CCONJ', 'SCONJ'}             # un bloc ne finit pas sur ces mots
CONTENT = {'NOUN', 'VERB', 'ADJ', 'ADV', 'ADP'}         # il faut au moins un tel mot en plus de la cible
NAMES = {'tom', 'toms', 'mary', 'marys', 'maria', 'marias', 'sami', 'samis', 'layla', 'mennad', 'baya', 'ziri', 'jan', 'john', 'yanni', 'fadil', 'dan', 'linda', 'ken', 'bob', 'emily', 'alice', 'boston', 'australië'} - {'dan'}
KEEP_DET = {'ieder', 'elk', 'beide', 'sommig', 'enkel', 'veel', 'weinig', 'al'}
FILLER = {'niet', 'te', 'ook', 'al', 'wel', 'er', 'dan', 'nu', 'maar', 'zo', 'heel', 'erg', 'om', 'dat', 'hier', 'daar', 'toch', 'eens', 'even', 'nog', 'meer', 'geen'}
grams = defaultdict(Counter)
for d in docs:
    toks = [(t.lower(), l, p) for t, l, p in d]
    for i in range(len(toks)):
        for size in (2, 3, 4):
            g = toks[i:i + size]
            if len(g) < size or any(p in EDGE_BAD or w in NAMES for w, _, p in g):
                continue
            if g[-1][2] in OPEN_END or g[0][2] in {'CCONJ', 'SCONJ'}:
                continue
            for k, (w, l, p) in enumerate(g):
                # la cible doit etre un mot "plein" : pas de blocs construits autour de "de", "ook",
                # "ik", "er"... (sauf quelques determinants qui portent vraiment un sens)
                if (l in targets and p not in {'ADP', 'AUX', 'CCONJ', 'SCONJ', 'PRON'}
                        and (p != 'DET' or l in KEEP_DET) and w not in FILLER and l not in FILLER):
                    # il faut, en plus de la cible, un mot porteur de sens : "niet betaald" ou
                    # "te bellen" ne sont pas des blocs utiles, "op tijd" ou "nog een keer" si
                    others = [x for j, x in enumerate(g) if j != k]
                    if any(o[2] in CONTENT and o[0] not in FILLER for o in others):
                        grams[l][' '.join(x[0] for x in g)] += 1

result, stats = {}, Counter()
for t in sorted(targets):
    scored = [(c * (1 + 0.6 * (len(g.split()) - 2)), c, g) for g, c in grams[t].items() if c >= 5]
    scored.sort(reverse=True)
    kept = []
    for _, c, g in scored[:40]:
        if any(g in k['c'] or k['c'] in g for k in kept):
            continue
        needle = ' ' + g + ' '
        ex = next((pairs[i] for i, low in enumerate(pair_low) if needle in low), None)
        if not ex:
            continue
        kept.append({'c': g, 'n': c, 'ex': ex[0], 'fr': ex[1]})
        if len(kept) == 3:
            break
    if kept:
        result[t] = kept
        stats[len(kept)] += 1

os.makedirs(os.path.join(project, 'data', 'chunks'), exist_ok=True)
dest = os.path.join(project, 'data', 'chunks', 'chunks_nl.json')
payload = {'_doc': "Blocs de mots frequents (chunks) par mot du vocabulaire, extraits des phrases Tatoeba "
                   "(tatoeba.org, licence CC BY 2.0 FR). Cle = mot neerlandais sans article. c = bloc, n = nombre "
                   "d'occurrences dans le corpus, ex/fr = phrase d'exemple et sa traduction. Genere par "
                   "tools/noyau/build_chunks.py : ne pas modifier a la main.",
           'chunks': result}
json.dump(payload, open(dest, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('mots cibles', len(targets), '| mots avec blocs', len(result), dict(stats), '| blocs', sum(len(v) for v in result.values()))
print('taille', os.path.getsize(dest) // 1024, 'Ko')
for w in ['ieder', 'keer', 'tijd', 'afspraak', 'nodig', 'bellen', 'boek', 'betalen', 'klant', 'levering', 'vragen', 'mogelijk', 'gewoon', 'werk']:
    print(w, '->', [(k['c'], k['n']) for k in result.get(w, [])], '|', (result.get(w) or [{}])[0].get('ex'), '=', (result.get(w) or [{}])[0].get('fr'))
