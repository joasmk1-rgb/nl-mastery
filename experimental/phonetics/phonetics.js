(() => {
    const langSelect = document.getElementById('language');
    const modeSelect = document.getElementById('display-mode');
    const list = document.getElementById('phrase-list');
    const voiceStatus = document.getElementById('voice-status');
    const micStatus = document.getElementById('mic-status');
    let voices = [];
    let recognition = null;

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    }
    function loadVoices() {
        voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        updateVoiceStatus();
    }
    function updateVoiceStatus() {
        const pack = PHONETIC_SAMPLES[langSelect.value];
        const matching = voices.filter(v => v.lang.toLowerCase().startsWith(pack.locale.slice(0, 2).toLowerCase()));
        voiceStatus.textContent = matching.length
            ? `${matching.length} voix ${pack.label} détectée${matching.length > 1 ? 's' : ''} (${matching.map(v => v.lang).join(', ')}).`
            : `Aucune voix ${pack.label} n’est actuellement détectée. Le bouton d’écoute essaiera quand même ${pack.locale} ; le résultat dépendra du navigateur et du système.`;
    }
    function render() {
        const pack = PHONETIC_SAMPLES[langSelect.value];
        const nativeFirst = modeSelect.value === 'native';
        list.innerHTML = pack.phrases.map((phrase, index) => `
          <article class="phrase" ${pack.dir === 'rtl' ? 'dir="rtl"' : ''}>
            <h2>${index + 1}. ${escapeHtml(phrase.fr)}</h2>
            <div class="native" dir="${pack.dir || 'ltr'}" lang="${langSelect.value}">${escapeHtml(phrase.native)}</div>
            <p class="roman" ${nativeFirst ? 'hidden' : ''} lang="${langSelect.value}-Latn">${escapeHtml(phrase.roman)}</p>
            <p class="ipa" ${nativeFirst ? 'hidden' : ''}>${escapeHtml(phrase.ipa)}</p>
            <p class="translation">${escapeHtml(phrase.note)}</p>
            <div class="buttons" dir="ltr">
              <button type="button" data-action="speak" data-index="${index}">🔊 Écouter</button>
              <button type="button" data-action="record" data-index="${index}">🎙️ Répéter et reconnaître</button>
            </div>
          </article>`).join('');
        updateVoiceStatus();
    }
    function speak(index) {
        if (!window.speechSynthesis) { voiceStatus.textContent = 'La synthèse vocale n’est pas disponible dans ce navigateur.'; return; }
        const pack = PHONETIC_SAMPLES[langSelect.value];
        const utterance = new SpeechSynthesisUtterance(pack.phrases[index].native);
        utterance.lang = pack.locale;
        utterance.rate = 0.78;
        const matching = voices.filter(v => v.lang.toLowerCase().startsWith(pack.locale.slice(0, 2).toLowerCase()));
        if (matching.length) utterance.voice = matching[0];
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    }
    function record(index) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) { micStatus.textContent = 'Reconnaissance vocale indisponible ici. Tu peux tout de même écouter et répéter.'; return; }
        if (recognition) { recognition.abort(); recognition = null; }
        const pack = PHONETIC_SAMPLES[langSelect.value];
        const rec = recognition = new SpeechRecognition();
        rec.lang = pack.locale;
        rec.interimResults = true;
        rec.maxAlternatives = 3;
        micStatus.textContent = `Écoute en ${pack.locale}… Répète maintenant : « ${pack.phrases[index].native} »`;
        rec.onresult = event => {
            const result = event.results[event.results.length - 1];
            const choices = Array.from(result).map(x => x.transcript);
            micStatus.textContent = `${result.isFinal ? 'Résultat' : 'Intermédiaire'} (${pack.locale}) : ${choices.join(' · ')}`;
        };
        rec.onerror = event => { micStatus.textContent = `Reconnaissance interrompue (${event.error}). Vérifie la permission micro et la prise en charge de ${pack.locale} par le navigateur.`; };
        rec.onend = () => { if (recognition === rec) recognition = null; };
        try { rec.start(); } catch (error) { micStatus.textContent = `Impossible de démarrer : ${error.message}`; }
    }

    list.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const index = Number(button.dataset.index);
        if (button.dataset.action === 'speak') speak(index);
        else record(index);
    });
    langSelect.addEventListener('change', render);
    modeSelect.addEventListener('change', render);
    if (window.speechSynthesis) {
        window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    loadVoices();
    render();
})();
