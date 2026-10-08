"""Analyse de couverture : combien de mots faut-il pour comprendre X % d'un texte courant,
et que couvre deja le vocabulaire de l'app ? Lemmatise les phrases Tatoeba NL avec spaCy et
met le resultat en cache (lemmas.pkl) pour les scripts suivants."""
import bz2, csv, glob, os, pickle, re, sys
from collections import Counter

corpus_dir, project_dir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
cache = os.path.join(out_dir, 'lemmas.pkl')

if os.path.exists(cache):
    docs = pickle.load(open(cache, 'rb'))
else:
    import spacy
    nlp = spacy.load('nl_core_news_sm', disable=['parser', 'ner'])
    sents = []
    with bz2.open(os.path.join(corpus_dir, 'nld_sentences.tsv.bz2'), 'rt', encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) >= 3 and 2 <= len(parts[2].split()) <= 25:
                sents.append(parts[2])
    sents = list(dict.fromkeys(sents))
    print('phrases NL', len(sents), flush=True)
    docs = []
    for i, doc in enumerate(nlp.pipe(sents, batch_size=500)):
        docs.append([(t.text, t.lemma_.lower(), t.pos_) for t in doc])
        if i % 20000 == 0:
            print('  ...', i, flush=True)
    pickle.dump(docs, open(cache, 'wb'))

SKIP_POS = {'PUNCT', 'SYM', 'NUM', 'PROPN', 'X', 'SPACE'}
freq = Counter()
for d in docs:
    for text, lemma, pos in d:
        if pos in SKIP_POS or not re.search(r'[a-zà-ÿ]', lemma):
            continue
        freq[lemma] += 1
total = sum(freq.values())
ranked = freq.most_common()
print('tokens', total, 'lemmes distincts', len(ranked))

cum, targets, res = 0, [0.5, 0.8, 0.85, 0.9, 0.95, 0.98], {}
for i, (w, c) in enumerate(ranked, 1):
    cum += c
    for t in targets:
        if t not in res and cum / total >= t:
            res[t] = i
print('couverture -> nb de lemmes :', {f'{int(t*100)}%': n for t, n in res.items()})
for n in (250, 500, 750, 1000, 1500, 2000, 3000):
    print(f'  les {n} lemmes les plus frequents couvrent {sum(c for _, c in ranked[:n]) / total:.1%}')

# Vocabulaire de l'app : colonne nl des CSV a la racine
def clean(nl):
    out = set()
    for part in re.split(r'[/,]', nl):
        p = re.sub(r'\([^)]*\)', '', part).strip().lower()
        p = re.sub(r'^(de|het|een|zich|te)\s+', '', p).strip()
        p = re.sub(r'[?!.]', '', p)
        if p:
            out.add(p)
    return out

app = {}
for path in glob.glob(os.path.join(project_dir, '*.csv')):
    name = os.path.basename(path)
    if name.startswith('VERBES_NL_enrichi'):
        continue
    with open(path, encoding='utf-8-sig') as f:
        for row in csv.DictReader(f, delimiter=';'):
            if row.get('nl'):
                for w in clean(row['nl']):
                    app.setdefault(w, name)
single = {w for w in app if ' ' not in w}
print('entrees app (mots simples)', len(single), '| avec espaces', len(app) - len(single))
covered = sum(c for w, c in ranked if w in single)
print(f"le vocabulaire de l'app couvre {covered / total:.1%} des mots du corpus")
missing = [(w, c) for w, c in ranked[:1500] if w not in single]
print('parmi les 1500 lemmes les plus frequents, absents de l\'app :', len(missing))
print('  les 60 premiers :', ', '.join(w for w, _ in missing[:60]))
in_top = {n: sum(1 for w, _ in ranked[:n] if w in single) for n in (500, 1000, 1500, 2000)}
print('mots de l\'app presents dans le top N :', in_top)
pickle.dump({'ranked': ranked, 'total': total, 'app': app}, open(os.path.join(out_dir, 'freq.pkl'), 'wb'))
