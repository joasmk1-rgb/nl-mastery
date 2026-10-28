# Prototype expérimental : russe et arabe

## Choix retenus

- **Russe** : russe standard, locale vocale de navigateur `ru-RU`.
- **Arabe** : arabe standard moderne, الفصحى المعاصرة, souvent appelé arabe littéral. Il est utilisé dans les médias, l'éducation et les échanges formels à travers le monde arabe. Ce n'est pas l'arabe classique historique ni un dialecte conversationnel régional.
- **Objectif d'apprentissage futur** : viser une compréhension et une expression orales solides autour d'A2, sans promettre une maîtrise de toute la grammaire ni un niveau B1.
- **Approche** : écouter et répéter d'abord, afficher une transcription latine et l'IPA comme aides, conserver l'écriture originale, puis permettre de masquer les aides.

## Démonstrateur

Ouvrir `experimental/phonetics/index.html` via un serveur web, ou après publication à `/experimental/phonetics/`. Il contient cinq phrases d'essai par langue, un réglage d'affichage, la synthèse vocale du navigateur et une tentative de reconnaissance vocale avec les locales `ru-RU` et `ar-SA`.

Le prototype montre les voix détectées. La locale de reconnaissance est une indication au navigateur, pas une garantie que son moteur comprend bien l'arabe standard moderne. Les voix disponibles, l'accent, la reconnaissance et les résultats dépendent du navigateur et du système. Il n'envoie pas d'audio à Gemini et n'évalue pas encore la qualité de prononciation.

## Limites à résoudre avant intégration au parcours

- Faire relire et normaliser les translittérations et transcriptions IPA par des locuteurs compétents ; la version actuelle est un échantillon de conception.
- Tester la reconnaissance et les voix sur les appareils visés. L'arabe standard peut être reconnu avec un accent dialectal, même quand `ar-SA` est demandé.
- Décider comment noter l'accent tonique russe et les voyelles réduites, et comment présenter les sons arabes sans équivalent français (par ex. ع et ح).
- Construire des données de vocabulaire et de cours seulement après validation du prototype phonétique.
- Ne pas ajouter encore `ru` ou `ar` à `LANG_PACKS` : les écrans actuels supposent des données et comportements anglais/espagnols ou néerlandais. L'ajout direct ferait apparaître des parcours incomplets.

## Vérification locale du prototype

- `node --check` passe pour les deux scripts JavaScript.
- La page a été ouverte via le serveur local ; les vues russe et arabe s'affichent, y compris le texte RTL et les exemples phonétiques.
- Le navigateur de test n'a signalé aucune voix russe ou arabe installée. La synthèse vocale réelle n'a donc pas été validée dans cet environnement.
- Le micro n'a pas été activé ; la reconnaissance doit être essayée par l'utilisateur dans son navigateur, après autorisation du micro. Selon le navigateur, son moteur peut traiter l'audio via son propre service.

## Fichiers

- `experimental/phonetics/index.html`
- `experimental/phonetics/phonetics.css`
- `experimental/phonetics/phonetics.js`
- `experimental/phonetics/phrases.js`
