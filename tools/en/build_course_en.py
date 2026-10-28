#!/usr/bin/env python3
"""Build a 31-module English A1-B2 pathway parallel to the Dutch course."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NL_MODULES = ROOT / "data/curriculum/modules.json"
OUTPUT = ROOT / "data/en/course_en.json"

# French UI labels, followed by practical English grammar/communication focus.
TOPICS = [
    ("Premiers contacts", "Saluer, se présenter et faire connaissance.", "Les formules changent selon le degré de politesse et le moment.", "Use Hello, Good morning, Nice to meet you, and How are you? to open a conversation.", ["Hello, my name is Alex.", "Nice to meet you.", "Good morning. How are you?"]),
    ("Construire une phrase", "Construire une phrase affirmative simple.", "L'anglais suit généralement l'ordre sujet + verbe + complément.", "Subject + verb + object: I work in Brussels. Questions use do/does or the verb be.", ["I work in Brussels.", "She likes coffee.", "Do you speak English?"]),
    ("Noms et articles", "Employer les noms dénombrables et indénombrables, les articles et le pluriel.", "Les noms dénombrables prennent généralement a/an au singulier et un pluriel; les indénombrables s'emploient sans article indéfini.", "Use a/an with a singular countable noun, the for something identified, and no a/an with uncountable nouns.", ["I have a meeting.", "The meeting starts at nine.", "We need information."]),
    ("Pronoms", "Employer les pronoms personnels, compléments et possessifs.", "Les pronoms sujets, compléments et possessifs ont des formes distinctes.", "I/me/my, he/him/his, she/her/her, we/us/our; you and it do not change in the object form.", ["She sent me her notes.", "They invited us.", "This is our office."]),
    ("Verbes", "Utiliser be, have, do et le present simple.", "Au present simple, la troisième personne du singulier prend généralement -s; les questions et négations utilisent do/does.", "I work; she works. Do you work? She doesn't work. Be and have have their own forms.", ["I work from home.", "He works in finance.", "Do they have a meeting?"]),
    ("Adjectifs et adverbes", "Décrire des personnes, objets et actions.", "L'adjectif précède souvent le nom et ne varie pas en genre ou en nombre.", "A useful report; the report is useful. Many adverbs use -ly: carefully, quickly.", ["She wrote a clear email.", "The system works well.", "They are very busy."]),
    ("Prépositions", "Situer dans l'espace et le temps avec les prépositions fréquentes.", "Les prépositions anglaises s'apprennent dans des expressions et contextes courants.", "At a time, on a day, in a month/year; at the station, on the desk, in the office.", ["The meeting is at ten.", "I work in Brussels.", "The file is on the desk."]),
    ("Négation et questions", "Former des phrases négatives et des questions simples.", "Do/does porte la négation et la question avec la plupart des verbes au présent.", "I don't know. She doesn't agree. Do you understand? With be: Are you ready?", ["I don't understand.", "Does he work here?", "They aren't available."]),
    ("Temps de base", "Distinguer le present simple, le present continuous et le past simple.", "Le présent simple décrit habitudes et faits; le continu décrit une action en cours; le passé simple situe un événement terminé.", "I work every day. I am working now. I worked yesterday.", ["She usually takes the train.", "She is taking the train now.", "She took the train yesterday."]),
    ("Vie quotidienne", "Parler des routines, horaires, besoins et activités courantes.", "Les verbes fréquents et expressions de temps rendent les échanges quotidiens plus naturels.", "Use frequency adverbs before most verbs, but after be: I usually start at eight; I am often busy.", ["I usually start at eight.", "We have lunch at noon.", "Could I have some water?"]),
    ("Raconter le passé", "Raconter un événement passé avec le past simple.", "Les verbes réguliers prennent -ed; de nombreux verbes fréquents sont irréguliers.", "Use the past simple for completed events; learn common irregular pairs such as go/went and see/saw.", ["We visited London last year.", "She went to the office.", "I saw your message."]),
    ("Verbes plus complexes", "Utiliser le present perfect et les verbes à particule fréquents.", "Le present perfect relie une expérience ou un résultat au présent; les phrasal verbs associent un verbe à une particule.", "Have/has + past participle: I have finished. Phrasal verbs: find out, look for, turn on.", ["I have finished the report.", "She has found out the answer.", "Can you turn on the screen?"]),
    ("Futur, intention et modalité", "Exprimer projets, prédictions, obligations et possibilités.", "Will, going to et les modaux expriment des intentions et degrés de certitude différents.", "I'll call you. I'm going to apply. You should check it. We must leave now.", ["I'll send it tomorrow.", "We're going to meet the client.", "You should save a copy."]),
    ("Quantité et référence", "Parler de quantités et reprendre une information sans la répéter.", "Some/any, much/many, a few/a little et les pronoms de reprise dépendent du type de nom.", "Many reports but much work; a few questions but a little time; use it/they to refer back.", ["We have a few questions.", "There isn't much time.", "The files are ready; I sent them."]),
    ("Construire des phrases plus riches", "Relier les propositions et exprimer la cause, le résultat et le contraste.", "Les conjonctions permettent d'exprimer les relations logiques entre deux idées.", "Use because, so, although, when and if to connect clauses; keep the word order clear.", ["I stayed because I had work.", "It was late, so we went home.", "Although it was busy, we finished."]),
    ("Description et comparaison", "Comparer des personnes, objets, quantités et expériences.", "Les comparatifs et superlatifs varient selon la longueur et la forme de l'adjectif.", "Smaller / more useful; the smallest / the most useful; as useful as.", ["This option is cheaper.", "It is the most useful tool.", "The new office is as bright as the old one."]),
    ("Situations de vie réelle", "Gérer des demandes, achats, déplacements et rendez-vous.", "Les demandes indirectes avec can, could et would sont souvent plus polies.", "Could I book a table? Would you mind helping me? I'd like to change my appointment.", ["Could I book a table for two?", "I'd like to change my appointment.", "How can I get to the station?"]),
    ("Interaction et expression personnelle", "Exprimer préférences, invitations, accord et désaccord.", "Les réponses courtes et les formules de réaction entretiennent une conversation naturelle.", "I think so; I'm not sure; That sounds good; Would you like to join us?", ["That sounds like a good idea.", "I'm not sure I agree.", "Would you like to join us?"]),
    ("Cause, conséquence et opposition", "Nuancer les liens logiques et les concessions.", "B1 demande de choisir un connecteur adapté au lien logique et au registre.", "Use because/since for causes, therefore/as a result for consequences, whereas/however for contrast.", ["Since demand increased, we hired more staff.", "The cost was high; however, the result was strong.", "Whereas sales rose, complaints fell."]),
    ("Syntaxe complexe", "Employer les relatives, les subordonnées et les propositions conditionnelles.", "Les propositions relatives et conditionnelles ajoutent des précisions sans casser la structure.", "The colleague who called is waiting. If we leave now, we'll arrive on time.", ["The report that you sent is useful.", "If we leave now, we'll arrive on time.", "I know what she means."]),
    ("Raconter et structurer", "Organiser un récit avec des temps et marqueurs de séquence adaptés.", "Past simple, past continuous et past perfect distinguent événement, contexte et antériorité.", "I was reviewing the file when he called. We had already sent the update.", ["I was reviewing the file when he called.", "We had already sent the update.", "After that, we checked the figures."]),
    ("Donner son opinion et argumenter", "Présenter une opinion, la justifier et répondre à un contre-argument.", "Une argumentation claire annonce la position, les raisons et les limites.", "In my view; the main reason is; on the other hand; that said.", ["In my view, we should simplify the process.", "The main reason is the cost.", "That said, the proposal has clear benefits."]),
    ("Anglais fonctionnel réel", "Comprendre les formulations courantes et les phrasal verbs en contexte.", "Les phrasal verbs et expressions idiomatiques changent parfois de sens selon le contexte.", "Look into = investigate; put off = postpone; carry on = continue.", ["I'll look into the issue.", "They put off the meeting.", "Please carry on with your work."]),
    ("Comprendre l'anglais réel", "Repérer idée principale, intention, détails et implicites dans un message.", "La compréhension s'appuie sur le contexte, les mots accentués et les reformulations.", "Listen for stressed content words, linking expressions and corrections such as actually or I mean.", ["Actually, we need the earlier version.", "What I mean is that the deadline has changed.", "The key point is the revised budget."]),
    ("Interaction B1", "Prendre son tour, clarifier, reformuler et maintenir un échange.", "Des formules de clarification donnent du temps et évitent les malentendus.", "Could you clarify that? Let me rephrase. What do you mean by...?", ["Could you clarify the last point?", "Let me rephrase the question.", "What do you mean by 'flexible'?"]),
    ("Nuances grammaticales avancées", "Choisir entre des temps et constructions proches selon le sens.", "Le choix du temps dépend du point de vue, de la durée et du lien avec le présent.", "Compare past simple, present perfect and present perfect continuous in context.", ["I worked there for a year.", "I have worked here since May.", "I have been working all morning."]),
    ("Précision et registre", "Adapter le niveau de formalité et choisir des formulations précises.", "Le registre dépend du destinataire, du but et du canal de communication.", "Could you please confirm is more formal than Can you check; avoid vague words in reports.", ["Could you please confirm receipt?", "Would it be possible to reschedule?", "The figures increased by twelve percent."]),
    ("Cohésion et style avancé", "Structurer un texte avec reprises, transitions et variations de rythme.", "La cohésion dépend des connecteurs, des reprises lexicales et d'une information bien ordonnée.", "Use moreover, nevertheless, consequently and specific reference words to guide the reader.", ["The plan is ambitious. Nevertheless, the first phase is achievable.", "This change reduced delays; consequently, delivery improved.", "The proposal has three parts. The final one concerns training."]),
    ("Argumentation et résolution de problèmes", "Évaluer des options, exprimer des réserves et proposer un compromis.", "Une discussion efficace compare critères, risques et bénéfices avant une recommandation.", "If we were to delay, costs would rise; provided that..., we could...; the trade-off is...", ["The main trade-off is speed versus cost.", "Provided that the figures are correct, we can proceed.", "A phased rollout would reduce the risk."]),
    ("Communication professionnelle", "Participer à une réunion, présenter un résultat et négocier une prochaine étape.", "L'anglais professionnel privilégie des messages concis, explicites et adaptés au contexte.", "Signpost a presentation, invite questions, summarize decisions and assign owners.", ["Let me start with the key findings.", "Could we agree on an owner for this action?", "To summarize, we will review the draft on Friday."]),
    ("Compréhension avancée et synthèse", "Synthétiser des sources, distinguer faits et interprétations, restituer les nuances.", "Une synthèse fidèle hiérarchise les idées et signale les réserves de l'auteur.", "Attribute claims, compare sources and use cautious language: appears to, suggests that, is likely to.", ["The report suggests that demand may recover.", "Both sources agree on the trend, but differ on its cause.", "The evidence is limited, so the conclusion remains tentative."]),
]


def main() -> None:
    source_modules = json.loads(NL_MODULES.read_text(encoding="utf-8"))
    if len(source_modules) != len(TOPICS):
        raise ValueError(f"Expected {len(source_modules)} topic descriptions; got {len(TOPICS)}")
    modules, notions = [], {}
    previous_by_level: dict[str, str] = {}
    for src, (label, objective, rule, explanation, examples) in zip(source_modules, TOPICS):
        mid = src["id"]
        nid = "en_" + mid.replace("-", "_")
        level = src["level"]
        prerequisite = previous_by_level.get(level)
        notions[nid] = {
            "level": level, "module": mid, "skills": ["grammaire", "vocabulaire"],
            "prerequisites": [prerequisite] if prerequisite else [], "status": "pret",
            "content": {"titre": label, "objectif": objective, "comprendre": explanation,
                        "regle": rule, "exemples": examples,
                        "erreursFrequentes": ["Traduire mot à mot depuis le français au lieu d'utiliser la structure anglaise."]},
            "exerciseIds": []
        }
        modules.append({"id": mid, "level": level, "order": src["order"], "label": label, "notions": [nid]})
        previous_by_level[level] = nid
    data = {"modules": modules, "notions": notions, "exercises": {}}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(modules)} modules, {len(notions)} English notions written to {OUTPUT}")


if __name__ == "__main__":
    main()
