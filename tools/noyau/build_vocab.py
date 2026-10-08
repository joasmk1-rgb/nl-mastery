"""Ajoute aux CSV de l'app les mots du noyau courant qui manquaient (traductions redigees a la
main dans out/tr_*.txt). Frequence = echelle Zipf de wordfreq (la meme que les lignes
existantes), niveau CECR = NT2Lex. N'ajoute jamais un mot deja present. --apply pour ecrire."""
import csv, os, re, sys
from collections import Counter
from wordfreq import zipf_frequency

out_dir, project = sys.argv[1], sys.argv[2]
apply = '--apply' in sys.argv

NOUN_CATS = {'AB': 'Abstrait & concepts', 'AL': 'Alimentation', 'NA': 'Nature', 'EM': 'Émotions & sentiments',
             'TR': 'Travail-études', 'PE': 'Personnes', 'CO': 'Corps & santé', 'TP': 'Transport', 'TE': 'Temps',
             'LI': 'Lieux', 'VE': 'Vêtements & objets', 'SO': 'Société', 'MA': 'Maison', 'AN': 'Animaux'}
ADJ_CATS = {'PER': 'Personnalité', 'QUA': 'Qualité', 'EMO': 'Émotions', 'COM': 'Comparaison',
            'PHY': 'Description physique', 'TAI': 'Taille-quantité'}

LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1']
nt = {}
with open(os.path.join(project, 'data', 'reference', 'NT2Lex-CGN+ODWN-v01.tsv'), encoding='utf-8') as f:
    r = csv.reader(f, delimiter='\t')
    head = next(r)
    idx = {lv: head.index('F@' + lv) for lv in LEVELS}
    for row in r:
        lv = next((l for l in LEVELS if row[idx[l]] not in ('-', '', '0')), None)
        w = row[0].lower()
        if lv and (w not in nt or LEVELS.index(lv) < LEVELS.index(nt[w])):
            nt[w] = lv

def bare(nl):
    return re.sub(r'^(de|het|zich)\s+', '', nl.strip().lower())

def prio(z):
    return 'Essentiel' if z >= 5 else ('Courant' if z >= 3.5 else 'Spécialisé')

def read_csv(name):
    path = os.path.join(project, name)
    raw = open(path, 'rb').read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    text = raw.decode('utf-8-sig')
    nl_char = '\r\n' if '\r\n' in text else '\n'
    rows = [l.split(';') for l in text.split(nl_char) if l.strip()]
    return path, bom, nl_char, text, rows

existing = set()
for name in os.listdir(project):
    if name.endswith('.csv') and not name.startswith('VERBES_NL_enrichi'):
        _, _, _, _, rows = read_csv(name)
        ni = rows[0].index('nl') if 'nl' in rows[0] else None
        if ni is None:
            continue
        for row in rows[1:]:
            if len(row) > ni:
                for part in re.split(r'[/,]', row[ni]):
                    existing.add(bare(re.sub(r'\([^)]*\)', '', part)))

def load(fname):
    with open(os.path.join(out_dir, fname), encoding='utf-8') as f:
        return [l.rstrip('\n').split('|') for l in f if l.strip()]

plan = {'NOMS_NL.csv': [], 'VERBES_NL.csv': [], 'ADJECTIFS_NL.csv': [], 'ADVERBES_NL.csv': [], 'MOTS_OUTILS_NL.csv': []}
skipped, seen = [], set()

def level_fields(w):
    lv = nt.get(w)
    return (lv, 'nt2lex') if lv else ('A2', 'estimation_manuelle')

def consider(nl, target, make):
    b = bare(nl)
    if b in existing or b in seen:
        skipped.append(nl)
        return
    seen.add(b)
    z = round(zipf_frequency(b.split(' ')[-1] if ' ' in b else b, 'nl'), 2)
    plan[target].append(make(b, z))

for nl, fr, cat in load('tr_noms_1.txt'):
    consider(nl, 'NOMS_NL.csv', lambda b, z, nl=nl, fr=fr, cat=cat:
             [fr, nl, str(z), 'Standard', prio(z), *level_fields(b), NOUN_CATS[cat], 'manuel', NOUN_CATS[cat], 'manuel'])
for nl, fr, pret, part in load('tr_verbes.txt'):
    consider(nl, 'VERBES_NL.csv', lambda b, z, nl=nl, fr=fr, pret=pret, part=part:
             [fr, nl, str(z), 'Standard', prio(z), pret, part])
for nl, fr, cat in load('tr_adj.txt'):
    consider(nl, 'ADJECTIFS_NL.csv', lambda b, z, nl=nl, fr=fr, cat=cat:
             [fr, nl, str(z), 'Standard', prio(z), *level_fields(b), ADJ_CATS[cat], 'manuel'])
for nl, fr, kind, cat in load('tr_autres.txt'):
    target = 'ADVERBES_NL.csv' if kind == 'ADV' else 'MOTS_OUTILS_NL.csv'
    consider(nl, target, lambda b, z, nl=nl, fr=fr, cat=cat:
             [fr, nl, str(z), prio(z), *level_fields(b), cat, 'manuel'])

print('deja presents, ignores :', len(skipped), skipped[:25])
for name, new_rows in plan.items():
    path, bom, nl_char, text, rows = read_csv(name)
    head = rows[0]
    prefix = name[:-4]
    last = max(int(r[0].rsplit('_', 1)[1]) for r in rows[1:])
    width = Counter(len(r) for r in rows[1:]).most_common(1)[0][0]
    lines = []
    for i, r in enumerate(new_rows, 1):
        row = [f'{prefix}_{last + i}'] + r
        assert len(row) == width == len(head), (name, len(row), width, len(head), row)
        assert not any(';' in c for c in row), row
        lines.append(';'.join(row))
    zs = [float(r[2]) for r in new_rows]
    lv = Counter(r[head.index('niveauCECR') - 1] for r in new_rows) if 'niveauCECR' in head else {}
    print(f'{name}: {len(rows) - 1} lignes existantes, +{len(new_rows)} | zipf min {min(zs)} med {sorted(zs)[len(zs)//2]} | niveaux {dict(lv)}')
    print('    ex :', lines[0])
    if apply:
        body = text if text.endswith(nl_char) else text + nl_char
        data = (body + nl_char.join(lines) + nl_char).encode('utf-8')
        open(path, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + data)
print('ECRIT' if apply else 'simulation (ajouter --apply pour ecrire)')
