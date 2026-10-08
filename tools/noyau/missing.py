"""Liste des mots du noyau (N lemmes les plus frequents) absents de l'app, valides contre
NT2Lex (ecarte prenoms et formes mal lemmatisees), avec nature, niveau CECR et frequence."""
import csv, math, os, pickle, sys
from collections import Counter, defaultdict

out_dir, project_dir, N = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = pickle.load(open(os.path.join(out_dir, 'freq.pkl'), 'rb'))
ranked, total, app = d['ranked'], d['total'], d['app']
single = {w for w in app if ' ' not in w}

# NT2Lex : lemme -> natures et premier niveau ou le mot apparait
LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1']
nt = defaultdict(lambda: {'pos': Counter(), 'level': None})
with open(os.path.join(project_dir, 'data', 'reference', 'NT2Lex-CGN+ODWN-v01.tsv'), encoding='utf-8') as f:
    r = csv.reader(f, delimiter='\t')
    head = next(r)
    idx = {lv: head.index('F@' + lv) for lv in LEVELS}
    for row in r:
        w = row[0].lower()
        pos = row[1].split('(')[0]
        e = nt[w]
        lv = next((l for l in LEVELS if row[idx[l]] not in ('-', '', '0')), None)
        tot = row[head.index('F@TOTAL')]
        e['pos'][pos] += int(tot) if tot.isdigit() else 1
        if lv and (e['level'] is None or LEVELS.index(lv) < LEVELS.index(e['level'])):
            e['level'] = lv

top = ranked[:N]
in_app = sum(1 for w, _ in top if w in single)
missing, rejected = [], []
for rank, (w, c) in enumerate(top, 1):
    if w in single:
        continue
    if w in nt and len(w) > 1:
        e = nt[w]
        missing.append((rank, w, e['pos'].most_common(1)[0][0], e['level'] or '?', round(math.log10(c / total * 1e9), 2)))
    else:
        rejected.append(w)
print(f'top {N} : {in_app} deja dans l\'app, {len(missing)} a ajouter, {len(rejected)} ecartes (hors NT2Lex)')
print('couverture du top', N, f': {sum(c for _, c in top) / total:.1%}')
print('par nature :', Counter(m[2] for m in missing).most_common())
print('par niveau :', Counter(m[3] for m in missing).most_common())
print('ecartes (60 premiers) :', ', '.join(rejected[:60]))
with open(os.path.join(out_dir, 'missing.tsv'), 'w', encoding='utf-8', newline='') as f:
    for m in missing:
        f.write('\t'.join(map(str, m)) + '\n')
by_pos = defaultdict(list)
for m in missing:
    by_pos[m[2]].append(m[1])
for pos, ws in by_pos.items():
    print(f'\n## {pos} ({len(ws)})\n' + ' '.join(ws))
