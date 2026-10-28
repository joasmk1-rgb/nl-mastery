#!/usr/bin/env python3
"""Build a 31-module Spanish A1-B2 course parallel to the existing pathway."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "data/curriculum/modules.json"
OUTPUT = ROOT / "data/es/course_es.json"

# Labels and explanations are French for the app UI; examples model standard Spanish.
TOPICS = [
    ("Premiers contacts", "Saluer, se présenter et faire connaissance.", "Les salutations dépendent du moment et du degré de proximité.", "Usa Hola, Buenos días, Encantado/a y ¿Qué tal? para iniciar un intercambio.", ["Hola, me llamo Ana.", "Encantado de conocerte.", "Buenos días, ¿qué tal?" ]),
    ("Construire une phrase", "Former une phrase affirmative simple avec un sujet, un verbe et un complément.", "Le sujet peut être omis quand la terminaison verbale indique déjà la personne.", "El orden frecuente es sujeto + verbo + complemento, pero el pronombre sujeto suele omitirse: Trabajo en Bruselas.", ["Trabajo en Bruselas.", "Ella vive aquí.", "¿Hablas español?" ]),
    ("Noms et articles", "Employer les noms, les articles définis et indéfinis et le pluriel.", "Les noms espagnols ont un genre grammatical et l'article s'accorde en genre et en nombre.", "El libro, la casa, los libros, las casas; un amigo, una amiga.", ["Tengo una reunión.", "La reunión empieza a las nueve.", "Necesitamos información." ]),
    ("Pronoms", "Employer les pronoms sujets, compléments et possessifs les plus fréquents.", "Les pronoms compléments se placent généralement avant le verbe conjugué.", "Yo, tú, él/ella, nosotros/as, vosotros/as, ellos/as; me, te, lo/la, nos, os, los/las.", ["Ella me envía sus notas.", "Nos invitaron.", "Esta es nuestra oficina." ]),
    ("Verbes", "Utiliser ser, estar, tener et le présent des verbes réguliers.", "Les verbes se conjuguent selon six personnes. Ser et estar ne s'emploient pas dans les mêmes contextes.", "Hablar: hablo, hablas, habla, hablamos, habláis, hablan. Ser expresa identidad y características; estar suele describir estados y ubicación.", ["Trabajo desde casa.", "Ella trabaja en una oficina.", "¿Tienes una reunión?" ]),
    ("Adjectifs et adverbes", "Décrire des personnes, des objets et des actions avec des accords corrects.", "L'adjectif s'accorde généralement avec le nom en genre et en nombre.", "Una casa bonita, unos informes claros; muchos adverbios se forman con -mente.", ["Es una propuesta clara.", "El sistema funciona bien.", "Están muy ocupados." ]),
    ("Prépositions", "Situer dans l'espace et dans le temps avec les prépositions fréquentes.", "Les prépositions espagnoles s'apprennent avec les expressions et les verbes qui les gouvernent.", "A las diez, el lunes, en mayo; en la estación, sobre la mesa, cerca de la oficina.", ["La reunión es a las diez.", "Trabajo en Bruselas.", "El documento está sobre la mesa." ]),
    ("Négation et questions", "Former des phrases négatives et des questions simples.", "La négation no se place avant le verbe. Les questions sont marquées par ¿ ? à l'écrit.", "No entiendo. ¿Trabajas aquí? ¿Está listo? La forme du verbe porte la personne.", ["No lo entiendo.", "¿Trabaja aquí?","No están disponibles." ]),
    ("Temps de base", "Distinguer le présent, le présent progressif et le passé récent.", "Le présent décrit habitudes et faits; estar + gerundio décrit une action en cours.", "Trabajo cada día. Estoy trabajando ahora. Ayer trabajé.", ["Normalmente voy en tren.", "Ahora estoy tomando el tren.", "Ayer tomé el tren." ]),
    ("Vie quotidienne", "Parler de routines, d'horaires, de besoins et d'activités courantes.", "Les verbes pronominaux et les marqueurs de fréquence rendent les échanges naturels.", "Los adverbios de frecuencia suelen ir antes del verbo: Normalmente empiezo a las ocho.", ["Normalmente empiezo a las ocho.", "Almorzamos al mediodía.", "¿Me trae un poco de agua?" ]),
    ("Raconter le passé", "Raconter un événement terminé au pretérito indefinido.", "Les terminaisons varient selon les verbes en -ar, -er et -ir, avec plusieurs formes irrégulières fréquentes.", "Ayer trabajé; ella salió; fuimos al centro. El indefinido presenta hechos terminados.", ["Visitamos Madrid el año pasado.", "Ella fue a la oficina.", "Vi tu mensaje." ]),
    ("Verbes plus complexes", "Exprimer une expérience liée au présent et employer des verbes pronominaux fréquents.", "Haber + participe forme le pretérito perfecto compuesto; les pronoms pronominaux accompagnent le verbe.", "He terminado, has visto; levantarse: me levanto, te levantas.", ["He terminado el informe.", "Se ha dado cuenta del error.", "¿Puedes encender la pantalla?" ]),
    ("Futur, intention et modalité", "Exprimer projets, prédictions, obligations et possibilités.", "Le futur simple, ir a + infinitif et les verbes modaux expriment des intentions différentes.", "Te llamaré. Voy a presentar mi candidatura. Deberías comprobarlo.", ["Te lo enviaré mañana.", "Vamos a reunirnos con el cliente.", "Deberías guardar una copia." ]),
    ("Quantité et référence", "Exprimer des quantités et reprendre une information sans répétition.", "Les quantifieurs s'accordent parfois avec le nom; les pronoms de reprise varient en genre et en nombre.", "Muchos informes, poco tiempo, algunas preguntas; lo/la/los/las reprennent un complément.", ["Tenemos algunas preguntas.", "No queda mucho tiempo.", "Los archivos están listos; los envié." ]),
    ("Construire des phrases plus riches", "Relier des propositions et exprimer cause, résultat et contraste.", "Les connecteurs organisent les relations logiques entre les idées.", "Usa porque, así que, aunque, cuando y si para enlazar ideas.", ["Me quedé porque tenía trabajo.", "Era tarde, así que volvimos a casa.", "Aunque había mucho trabajo, terminamos." ]),
    ("Description et comparaison", "Comparer personnes, objets, quantités et expériences.", "Les comparatifs se forment souvent avec más/menos + adjectif et que; les superlatifs avec el/la más.", "Más pequeño que, tan útil como, el más interesante.", ["Esta opción es más barata.", "Es la herramienta más útil.", "La oficina nueva es tan luminosa como la antigua." ]),
    ("Situations de vie réelle", "Gérer demandes, achats, déplacements et rendez-vous.", "Les demandes indirectes avec poder et querer sont souvent plus polies.", "¿Podría reservar una mesa? ¿Le importaría ayudarme? Quisiera cambiar la cita.", ["¿Podría reservar una mesa para dos?", "Quisiera cambiar la cita.", "¿Cómo llego a la estación?" ]),
    ("Interaction et expression personnelle", "Exprimer préférences, invitations, accord et désaccord.", "Les réactions brèves et les questions de suivi entretiennent une conversation.", "Creo que sí; no estoy seguro/a; me parece bien; ¿te apetece venir?", ["Me parece una buena idea.", "No estoy seguro de estar de acuerdo.", "¿Te gustaría venir con nosotros?" ]),
    ("Cause, conséquence et opposition", "Nuancer les liens logiques et les concessions.", "Le niveau B1 demande de choisir un connecteur adapté à la relation et au registre.", "Usa puesto que para la causa, por lo tanto para la consecuencia y sin embargo para el contraste.", ["Como aumentó la demanda, contratamos a más personas.", "El coste fue alto; sin embargo, el resultado fue bueno.", "Mientras las ventas subían, bajaban las quejas." ]),
    ("Syntaxe complexe", "Employer relatives, subordonnées et propositions conditionnelles.", "Les relatives et les conditionnelles ajoutent des précisions; certaines structures demandent le subjonctif.", "La persona que llamó está esperando. Si salimos ahora, llegaremos a tiempo.", ["El informe que enviaste es útil.", "Si salimos ahora, llegaremos a tiempo.", "Sé lo que quiere decir." ]),
    ("Raconter et structurer", "Organiser un récit en distinguant événements, contexte et antériorité.", "L'indefinido raconte les faits; l'imperfecto décrit le contexte ou les habitudes passées.", "Estaba revisando el documento cuando llamó. Ya habíamos enviado la actualización.", ["Estaba revisando el documento cuando llamó.", "Ya habíamos enviado la actualización.", "Después, comprobamos las cifras." ]),
    ("Donner son opinion et argumenter", "Présenter une opinion, la justifier et répondre à un contre-argument.", "Une argumentation claire annonce position, raisons et limites.", "En mi opinión; la razón principal es; por otro lado; dicho esto.", ["En mi opinión, deberíamos simplificar el proceso.", "La razón principal es el coste.", "Dicho esto, la propuesta tiene ventajas." ]),
    ("Espagnol fonctionnel réel", "Comprendre les formulations courantes et les expressions en contexte.", "Les expressions idiomatiques changent parfois de sens selon le contexte et la région.", "Averiguar = descubrir; aplazar = posponer; seguir adelante = continuar.", ["Voy a averiguar qué ha pasado.", "Aplazaron la reunión.", "Por favor, sigue adelante." ]),
    ("Comprendre l'espagnol réel", "Repérer l'idée principale, l'intention, les détails et les implicites d'un message.", "Le contexte, l'accentuation et les reformulations aident à comprendre différents accents.", "Escucha las palabras tónicas, los conectores y autocorrecciones como en realidad o quiero decir.", ["En realidad, necesitamos la versión anterior.", "Lo que quiero decir es que ha cambiado la fecha límite.", "El punto clave es el presupuesto revisado." ]),
    ("Interaction B1", "Prendre son tour, clarifier, reformuler et maintenir un échange.", "Les formules de clarification donnent du temps et préviennent les malentendus.", "¿Podría aclararlo? Déjame reformularlo. ¿Qué quieres decir con…?", ["¿Podría aclarar el último punto?", "Déjame reformular la pregunta.", "¿Qué quieres decir con flexible?" ]),
    ("Nuances grammaticales avancées", "Choisir entre temps et constructions proches selon le point de vue.", "Le choix du temps dépend de la région, de la durée et du lien avec le présent.", "Compara indefinido y perfecto compuesto: trabajé allí un año; he trabajado aquí desde mayo.", ["Trabajé allí durante un año.", "He trabajado aquí desde mayo.", "Llevo toda la mañana trabajando." ]),
    ("Précision et registre", "Adapter le degré de formalité et choisir des formulations précises.", "Le registre dépend du destinataire, du but et du contexte.", "¿Podría confirmarlo? es más formal que ¿Puedes comprobarlo? Evita las expresiones vagas.", ["¿Podría confirmar la recepción?", "¿Sería posible cambiar la fecha?", "Las cifras aumentaron un doce por ciento." ]),
    ("Cohésion et style avancé", "Structurer un texte avec reprises, transitions et variations de rythme.", "La cohésion dépend des connecteurs, des reprises lexicales et de l'ordre des informations.", "Usa además, no obstante, por consiguiente y referencias precisas para guiar al lector.", ["El plan es ambicioso. No obstante, la primera fase es viable.", "Este cambio redujo los retrasos; por consiguiente, mejoraron las entregas.", "La propuesta tiene tres partes. La última trata de la formación." ]),
    ("Argumentation et résolution de problèmes", "Évaluer des options, exprimer des réserves et proposer un compromis.", "Une discussion compare les critères, risques et avantages avant de recommander une solution.", "Si retrasáramos el proyecto, subirían los costes; siempre que…, podríamos…; la contrapartida es…", ["La principal contrapartida es la rapidez frente al coste.", "Siempre que las cifras sean correctas, podemos continuar.", "Una implantación gradual reduciría el riesgo." ]),
    ("Communication professionnelle", "Participer à une réunion, présenter un résultat et négocier la prochaine étape.", "La communication professionnelle privilégie les messages concis, explicites et adaptés.", "Estructura una presentación, invita a hacer preguntas, resume los acuerdos y asigna responsables.", ["Empezaré por los resultados principales.", "¿Podemos acordar quién se encargará de esta acción?", "En resumen, revisaremos el borrador el viernes." ]),
    ("Compréhension avancée et synthèse", "Synthétiser des sources, distinguer faits et interprétations et restituer les nuances.", "Une synthèse fidèle hiérarchise les idées et signale les réserves de l'auteur.", "Atribuye las afirmaciones, compara fuentes y usa expresiones prudentes como parece que o sugiere que.", ["El informe sugiere que la demanda podría recuperarse.", "Ambas fuentes coinciden en la tendencia, pero discrepan sobre la causa.", "Las pruebas son limitadas, así que la conclusión es provisional." ]),
]


def main() -> None:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    if len(source) != len(TOPICS):
        raise ValueError(f"Expected 31 Spanish module descriptions; got {len(TOPICS)}")
    modules, notions = [], {}
    previous: dict[str, str] = {}
    for src, (label, objective, rule, explanation, examples) in zip(source, TOPICS):
        mid = src["id"]
        nid = "es_" + mid.replace("-", "_")
        level = src["level"]
        notions[nid] = {"level": level, "module": mid, "skills": ["grammaire", "vocabulaire"],
                        "prerequisites": [previous[level]] if level in previous else [], "status": "pret",
                        "content": {"titre": label, "objectif": objective, "comprendre": explanation,
                                    "regle": rule, "exemples": examples,
                                    "erreursFrequentes": ["Traduire mot à mot depuis le français au lieu d'utiliser la structure espagnole."]},
                        "exerciseIds": []}
        modules.append({"id": mid, "level": level, "order": src["order"], "label": label, "notions": [nid]})
        previous[level] = nid
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"modules": modules, "notions": notions, "exercises": {}}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(modules)} Spanish modules and notions written")


if __name__ == "__main__":
    main()
