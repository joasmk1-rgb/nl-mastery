// Fiches des langues étudiées. Le néerlandais est la seule pour l'instant.
const LANG_PACKS = {
    nl: {
        code: 'nl',
        nom: 'néerlandais',            // pour les phrases en français : « en néerlandais »
        nomPropre: 'Nederlands',        // le nom de la langue dans la langue elle-même
        variante: 'néerlandais de Flandre',
        ttsLang: 'nl-NL',               // voix de synthèse
        micLang: 'nl-NL',               // reconnaissance vocale
        voixPrefixe: 'nl'               // filtre des voix : voice.lang.startsWith(...)
    }
};
function studyLangCode() {
    try { return (state && state.settings && LANG_PACKS[state.settings.studyLang]) ? state.settings.studyLang : 'nl'; }
    catch (e) { return 'nl'; }
}
function studyLang() { return LANG_PACKS[studyLangCode()]; }
