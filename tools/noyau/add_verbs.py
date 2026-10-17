"""Ajoute des verbes en FIN de VERBES_NL.csv (jamais d'insertion : les ids de l'app sont des
numéros de ligne). Entrée : un fichier texte, une ligne par verbe « fr;infinitif;prétérit;participe »
(ex. « épeler;spellen;spelde;gespeld »). Les verbes déjà présents sont ignorés. Ensuite :
relancer build_conjugation.py (fiche de conjugaison) puis build_conjugation_fr.py (traductions).

Usage : python -I add_verbs.py projet liste.txt"""
import sys
from wordfreq import zipf_frequency

project, src = sys.argv[1], sys.argv[2]
path = project + '/VERBES_NL.csv'
lines = open(path, encoding='utf-8').read().splitlines()
existing = {l.split(';')[2] for l in lines[1:] if l.count(';') >= 2}
n = len(lines) - 1
out = []
for raw in open(src, encoding='utf-8-sig'):   # -sig : ignore le BOM qu'ajoute PowerShell
    raw = raw.strip()
    if not raw or raw.startswith('#'):
        continue
    fr, nl, pret, pp = [x.strip() for x in raw.split(';')]
    if nl in existing:
        continue
    z = round(zipf_frequency(nl.replace('zich ', ''), 'nl'), 2)
    prio = 'Essentiel' if z >= 5 else ('Courant' if z >= 3.5 else 'Spécialisé')
    out.append(f'VERBES_NL_{n};{fr};{nl};{z};Standard;{prio};{pret};{pp}')
    existing.add(nl)
    n += 1
with open(path, 'a', encoding='utf-8', newline='') as f:
    for l in out:
        f.write(l + '\r\n')
print(len(out), 'verbes ajoutés')
