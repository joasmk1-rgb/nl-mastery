"""Ajoute a data/curriculum/conjugation.json une fiche pour chaque verbe de VERBES_NL.csv qui n'en
a pas encore. Present derive du preterit (verbes faibles : radical = preterit sans -de/-te) ou
des regles d'orthographe (verbes forts), auxiliaire d'apres une liste, phrase d'exemple tiree
des paires Tatoeba fr-nl. Corrige aussi la forme "wij" des verbes a particule deja presents
(ex. "aanbieden" -> "bieden aan"). --apply pour ecrire.

Usage : build_conjugation.py corpus projet [--apply]"""
import csv, json, os, re, sys

corpus_dir, project = sys.argv[1], sys.argv[2]
apply = '--apply' in sys.argv

ZIJN = set("""aflopen verdwijnen terugkomen ontsnappen weggaan terugkeren verschijnen thuiskomen uitgaan
binnenkomen verdwalen opgroeien landen smelten overkomen omgaan zinken arriveren verlopen genezen
uitkomen verdrinken tegenkomen kwijtraken vluchten teruggaan mislukken omkomen toenemen afvallen
naderen langskomen botsen thuisblijven geraken uitstappen bevallen lukken ophouden starten""".split())
MONO = {'gaan': 'ga', 'staan': 'sta', 'doen': 'doe', 'zien': 'zie', 'slaan': 'sla'}
VOW = 'aeiou'

def strong_stem(inf):
    for k, v in MONO.items():
        if inf.endswith(k):
            return inf[:-len(k)] + v, True
    if inf.endswith('komen'):
        return inf[:-2], False                      # kom (pas "koom")
    s = inf[:-2]
    if len(s) > 1 and s[-1] == s[-2]:
        s = s[:-1]
    elif len(s) >= 2 and s[-1] not in VOW and s[-2] in 'aeou' and (len(s) == 2 or s[-3] not in VOW):
        s = s[:-1] + s[-2] + s[-1]                   # syllabe ouverte : stelen -> steel
    if s.endswith('v'):
        s = s[:-1] + 'f'
    elif s.endswith('z'):
        s = s[:-1] + 's'
    return s, False

def add_t(stem, vowel_end):
    if vowel_end:
        return stem + ('at' if stem.endswith('a') else 't')   # ga -> gaat, zie -> ziet, doe -> doet
    return stem if stem.endswith('t') else stem + 't'

def conjugate(nl, pret_raw):
    reflexive = nl.startswith('zich ')
    inf = nl[5:] if reflexive else nl
    pret_words = [w for w in pret_raw.split() if w != 'zich']
    pret, particle = pret_words[0], ' '.join(pret_words[1:])
    base = inf
    if particle:
        joined = particle.replace(' ', '')
        assert inf.startswith(joined), (nl, particle)
        base = inf[len(joined):]
    weak = pret.endswith('de') or pret.endswith('te')
    if base.endswith('iën'):
        stem, vowel_end, third, plural = base[:-2], False, base[:-2] + 'et', base   # ski, skiet, skiën
    else:
        if weak:
            stem, vowel_end = pret[:-2], False
        else:
            stem, vowel_end = strong_stem(base)
        third, plural = add_t(stem, vowel_end), base
    tail = (' ' + particle) if particle else ''
    refl = {'ik': ' me', 'jij': ' je', 'hij': ' zich', 'wij': ' ons'} if reflexive else dict.fromkeys(['ik', 'jij', 'hij', 'wij'], '')
    present = {'ik': stem + refl['ik'] + tail, 'jij': third + refl['jij'] + tail,
               'hij': third + refl['hij'] + tail, 'wij': plural + refl['wij'] + tail}
    return inf, present, (pret + tail), weak, {stem, third, plural, pret, inf}

# phrases d'exemple
nl_s = open(os.path.join(corpus_dir, 'Tatoeba.fr-nl.nl'), encoding='utf-8').read().split('\n')
fr_s = open(os.path.join(corpus_dir, 'Tatoeba.fr-nl.fr'), encoding='utf-8').read().split('\n')
pairs = sorted([(a.strip(), b.strip()) for a, b in zip(nl_s, fr_s) if a.strip() and b.strip() and 4 <= len(a.split()) <= 11],
               key=lambda p: abs(len(p[0].split()) - 6))
pair_tokens = [set(re.findall(r"[a-zà-ÿ'-]+", a.lower())) for a, _ in pairs]

def example(forms, participle, particle):
    wanted = {f for f in forms if len(f) > 2} | {participle}
    for i, toks in enumerate(pair_tokens):
        if toks & wanted and (not particle or particle in toks or (toks & {participle})):
            return pairs[i]
    return ('', '')

LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1']
levels = {}
with open(os.path.join(project, 'data', 'reference', 'NT2Lex-CGN+ODWN-v01.tsv'), encoding='utf-8') as f:
    r = csv.reader(f, delimiter='	')
    head = next(r)
    idx = {lv: head.index('F@' + lv) for lv in LEVELS}
    for row in r:
        if not row[1].startswith('WW'):
            continue
        lv = next((l for l in LEVELS if row[idx[l]] not in ('-', '', '0')), None)
        w = row[0].lower()
        if lv and (w not in levels or LEVELS.index(lv) < LEVELS.index(levels[w])):
            levels[w] = lv

path = os.path.join(project, 'data', 'curriculum', 'conjugation.json')
data = json.load(open(path, encoding='utf-8'))
have = {v['infinitief'] for v in data}

# correction des fiches existantes : "wij" des verbes a particule
fixed = 0
for v in data:
    words = v['preteritum'].split()
    if len(words) == 2 and words[1] != 'zich' and v['present'].get('wij') == v['infinitief'] and v['infinitief'].startswith(words[1]):
        v['present']['wij'] = v['infinitief'][len(words[1]):] + ' ' + words[1]
        fixed += 1

new, strong_log, no_ex = [], [], 0
with open(os.path.join(project, 'VERBES_NL.csv'), encoding='utf-8-sig') as f:
    for row in csv.DictReader(f, delimiter=';'):
        nl = row['nl'].strip()
        if (nl in have or (nl.startswith('zich ') and nl[5:] in have) or not row.get('preterit') or '/' in nl or '(' in nl
                or not nl.endswith('n')):          # pas un infinitif (ligne ancienne mal formee)
            continue
        try:
            inf, present, pret, weak, forms = conjugate(nl, row['preterit'].strip())
        except AssertionError as e:
            print('IGNORE', e)
            continue
        particle = pret.split(' ', 1)[1] if ' ' in pret else ''
        ex_nl, ex_fr = example(forms, row['participe_passe'].strip(), particle)
        no_ex += not ex_nl
        entry = {'infinitief': nl, 'fr': row['fr'], 'present': present, 'preteritum': pret,
                 'participePasse': row['participe_passe'].strip(), 'auxiliaire': 'zijn' if inf in ZIJN else 'hebben',
                 'exempleNl': ex_nl, 'exempleFr': ex_fr, 'freq': float(row['freq'])}
        if inf in levels:
            entry['niveauCECR'], entry['niveauCECRSource'] = levels[inf], 'nt2lex'
        new.append(entry)
        if not weak:
            strong_log.append(f"{nl}: {present['ik']} / {present['hij']} / {present['wij']} | {pret} | {entry['auxiliaire']} {entry['participePasse']}")

print(f'fiches existantes {len(data)} | "wij" corriges {fixed} | nouvelles {len(new)} | sans exemple {no_ex}')
print('\n-- verbes forts (a relire) --')
print('\n'.join(strong_log))
print('\n-- echantillon faibles --')
for e in new[:12]:
    print(e['infinitief'], e['present'], e['preteritum'], e['auxiliaire'], '|', e['exempleNl'], '=', e['exempleFr'])
if apply:
    json.dump(data + new, open(path, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=2)
    print('ECRIT')
