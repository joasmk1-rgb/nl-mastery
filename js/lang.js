// Fiches des langues étudiées. Les réglages de langue sont stockés séparément de la
// progression pour qu'un changement de progression ne fasse pas perdre le choix de langue.
const LANG_PACKS = {
    nl: {
        code: 'nl',
        nom: 'néerlandais',
        nomPropre: 'Nederlands',
        variante: 'néerlandais de Flandre',
        ttsLang: 'nl-NL',
        micLang: 'nl-NL',
        voixPrefixe: 'nl',
        modules: ['dehet', 'separables', 'ordre', 'nt2lex', 'cvo', 'micFrCue', 'contenusNl']
    },
    en: {
        code: 'en',
        nom: 'anglais',
        nomPropre: 'English',
        variante: 'anglais (britannique ou américain courant)',
        ttsLang: 'en-GB',
        micLang: 'en-GB',
        voixPrefixe: 'en',
        modules: []
    }
};

const STUDY_LANG_STORAGE_KEY = 'nl_study_lang';
let _currentStudyLang = 'nl';
try {
    const savedStudyLang = localStorage.getItem(STUDY_LANG_STORAGE_KEY);
    if (savedStudyLang && LANG_PACKS[savedStudyLang]) _currentStudyLang = savedStudyLang;
} catch (e) { /* Le stockage local peut être désactivé. */ }

function setStudyLang(code) {
    if (!LANG_PACKS[code]) return false;
    _currentStudyLang = code;
    try { localStorage.setItem(STUDY_LANG_STORAGE_KEY, code); } catch (e) { /* La valeur reste en mémoire. */ }
    return true;
}

function studyLangCode() { return _currentStudyLang; }
function studyLang() { return LANG_PACKS[studyLangCode()] || LANG_PACKS.nl; }
function langHas(moduleName) { return studyLang().modules.includes(moduleName); }
