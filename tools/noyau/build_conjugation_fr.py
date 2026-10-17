"""Génère data/curriculum/conjugation_fr.json : la traduction française de chaque forme
conjuguée des verbes de conjugation.json, pour que l'app n'ait plus besoin de Gemini.

Pour chaque verbe : premier sens de la traduction française (avant « / »), sans les
précisions entre parenthèses ; le premier mot (ou « se X » / « s'X ») est conjugué par
verbecc, le reste est recopié tel quel (« répondre à » → « j'ai répondu à »).
Correspondance des temps : present → présent, imperfectum → imparfait,
perfectum → passé composé, futur → futur simple. Formes au masculin.

Usage : python build_conjugation_fr.py data/curriculum/conjugation.json data/curriculum/conjugation_fr.json
"""
import json, re, sys, logging
logging.disable(logging.CRITICAL)
from verbecc import CompleteConjugator, LangCodeISO639_1 as Lang

SRC, OUT = sys.argv[1], sys.argv[2]
cg = CompleteConjugator(Lang.fr)
TENSES = {'present': 'présent', 'imperfectum': 'imparfait', 'perfectum': 'passé-composé', 'futur': 'futur-simple'}
PRONOUNS = {'je': 'ik', 'tu': 'jij', 'il': 'hij', 'nous': 'wij', 'vous': 'jullie', 'ils': 'zij'}


def split_verb(fr):
    sense = fr.split('/')[0]
    sense = re.sub(r'\([^)]*\)', ' ', sense)
    sense = re.sub(r'\s+', ' ', sense).strip().rstrip(',;')
    m = re.match(r"^(se |s')?([a-zàâäçéèêëîïôöûùüÿœ-]+)(.*)$", sense, re.I)
    if not m:
        return None, None
    verb = (m.group(1) or '') + m.group(2)
    return verb, m.group(3).strip()


def conjugate(verb, rest):
    data = cg.conjugate(verb).get_data()
    if data['verb'].get('predicted'):
        return None, True
    ind = data['moods']['indicatif']
    res = {}
    for nl_t, fr_t in TENSES.items():
        forms = {}
        for e in ind[fr_t]:
            pr = e.get('pr')
            if pr not in PRONOUNS or e.get('g') == 'f':
                continue
            if PRONOUNS[pr] in forms:
                continue
            forms[PRONOUNS[pr]] = (e['c'][0] + (' ' + rest if rest else '')).strip()
        if len(forms) != 6:
            return None, False
        res[nl_t] = forms
    return res, False


verbs = json.load(open(SRC, encoding='utf-8'))
out, failed, predicted = {}, [], []
for v in verbs:
    verb, rest = split_verb(v.get('fr', ''))
    if not verb:
        failed.append((v['infinitief'], v.get('fr'))); continue
    try:
        res, pred = conjugate(verb, rest)
    except Exception as e:
        res, pred = None, False
    if pred:
        predicted.append((v['infinitief'], v['fr'])); continue
    if not res:
        failed.append((v['infinitief'], v['fr'])); continue
    out[v['infinitief']] = res

json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
print(len(out), 'verbes traduits sur', len(verbs))
print('non reconnus par le conjugueur (laissés à Gemini) :', len(predicted))
for p in predicted: print('  ?', p)
print('échecs :', len(failed))
for f in failed: print('  !', f)
