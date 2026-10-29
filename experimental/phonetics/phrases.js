// Échantillon court pour éprouver la présentation, les voix et la reconnaissance vocale.
// La transcription latine est un appui de départ, pas une norme orthographique ni une cible.
const PHONETIC_SAMPLES = {
    ru: {
        label: 'Russe standard', locale: 'ru-RU',
        phrases: [
            { native: 'Здравствуйте.', roman: 'Zdrávstvuyte', ipa: '[ˈzdrastvʊjtʲɪ]', fr: 'Bonjour (formel).', note: 'Le groupe initial de consonnes est dense ; prononce-le lentement, puis accélère.' },
            { native: 'Спасибо.', roman: 'Spasíbo', ipa: '[spɐˈsʲibə]', fr: 'Merci.', note: 'Le ы n’a pas d’équivalent direct en français.' },
            { native: 'Как вас зовут?', roman: 'Kak vas zavút?', ipa: '[kak vəs zɐˈvut]', fr: 'Comment vous appelez-vous ?', note: 'La transcription marque l’accent tonique avec une voyelle accentuée.' },
            { native: 'Я не понимаю.', roman: 'Ya ne ponimáyu', ipa: '[ja nʲɪ pənʲɪˈmaju]', fr: 'Je ne comprends pas.', note: 'Écoute le contraste entre н et нь.' },
            { native: 'Повторите, пожалуйста.', roman: 'Povtoríte, pozhaluysta', ipa: '[pəftɐˈrʲitʲɪ pɐˈʐalʊstə]', fr: 'Répétez, s’il vous plaît.', note: 'Phrase utile pour demander une répétition.' }
        ]
    },
    ar: {
        label: 'Arabe standard moderne', locale: 'ar-SA', dir: 'rtl',
        phrases: [
            { native: 'السَّلَامُ عَلَيْكُمْ', roman: 'As-salāmu ʿalaykum', ipa: '[as.sa.laː.mu ʕa.laj.kum]', fr: 'Que la paix soit sur vous. (salutation)', note: 'ع représente un son pharyngal absent du français ; la transcription seule ne suffit pas à l’apprendre.' },
            { native: 'وَعَلَيْكُمُ السَّلَامُ', roman: 'Wa ʿalaykumu s-salām', ipa: '[wa ʕa.laj.ku.mus.sa.laːm]', fr: 'Et sur vous la paix. (réponse)', note: 'Réponse courante à la salutation.' },
            { native: 'شُكْرًا', roman: 'Shukran', ipa: '[ˈʃuk.ran]', fr: 'Merci.', note: 'La voyelle brève finale est souvent réduite dans la parole.' },
            { native: 'لَا أَفْهَمُ', roman: 'Lā afhamu', ipa: '[laː ʔaf.ha.mu]', fr: 'Je ne comprends pas.', note: 'Le registre est l’arabe standard ; les formulations quotidiennes varient selon les pays.' },
            { native: 'مِنْ فَضْلِكَ', roman: 'Min faḍlika', ipa: '[min ˈfadˤ.li.ka]', fr: 'S’il vous plaît. (à un homme)', note: 'Le ض (ḍād) est une consonne emphatique. À une femme, on dit مِنْ فَضْلِكِ (min faḍliki).' }
        ]
    }
};
