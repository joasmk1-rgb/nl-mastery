// ===== Firebase (comptes + synchro cloud) =====
const firebaseConfig = {
    apiKey: "AIzaSyBO4HWfcXU6D1m8eoW85V1FWebBKVWl-lk",
    authDomain: "nl-mastery.firebaseapp.com",
    projectId: "nl-mastery",
    storageBucket: "nl-mastery.firebasestorage.app",
    messagingSenderId: "148470064172",
    appId: "1:148470064172:web:b2beab968b09dc05f19d89"
};

let currentUser = null;      // objet auth Firebase (uid, etc.)
let currentUserDoc = null;   // données Firestore users/{uid} (pseudo, role, disabled...)
let cloudSyncTimer = null;
let accMode = 'login'; // 'login' | 'signup'
let firebaseAvailable = false;
let auth = null;
let db = null;
// Si le SDK Firebase n'a pas pu se charger (réseau, bloqueur de pub, hors-ligne...),
// l'app doit rester 100% utilisable en local — seules les fonctions de compte sont désactivées.
try {
    if (typeof firebase !== 'undefined') {
        firebase.initializeApp(firebaseConfig);
        auth = firebase.auth();
        db = firebase.firestore();
        firebaseAvailable = true;
    } else {
        console.warn('Firebase SDK non chargé — fonctions de compte indisponibles, mode local uniquement.');
    }
} catch (e) {
    console.warn('Erreur d\'initialisation Firebase :', e);
}

function accEmailFromPseudo(pseudo) {
    return pseudo.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '') + '@nl-mastery.local';
}

function accSwitchTab(mode) {
    accMode = mode;
    document.getElementById('acc-tab-login').classList.toggle('active', mode === 'login');
    document.getElementById('acc-tab-signup').classList.toggle('active', mode === 'signup');
    document.getElementById('acc-email-field').style.display = mode === 'signup' ? 'block' : 'none';
    document.getElementById('acc-hint').style.display = mode === 'signup' ? 'block' : 'none';
    document.getElementById('acc-submit-btn').innerText = mode === 'signup' ? 'Créer mon compte' : 'Se connecter';
    document.getElementById('acc-error').innerText = '';
}

function accSetError(msg) {
    document.getElementById('acc-error').innerText = msg;
}

function accSubmit() {
    const pseudo = document.getElementById('acc-pseudo').value.trim();
    const password = document.getElementById('acc-password').value;
    accSetError('');

    if (!firebaseAvailable) {
        accSetError("Service de comptes indisponible pour le moment (connexion impossible). Ta progression locale reste intacte, réessaie plus tard.");
        return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(pseudo)) {
        accSetError('Pseudo : 3 à 20 caractères, lettres/chiffres/underscore uniquement.');
        return;
    }
    if (password.length < 6) {
        accSetError('Le mot de passe doit faire au moins 6 caractères.');
        return;
    }

    if (accMode === 'signup') accSignup(pseudo, password);
    else accLogin(pseudo, password);
}

async function accSignup(pseudo, password) {
    const pseudoLower = pseudo.toLowerCase();
    const email = document.getElementById('acc-email').value.trim();
    try {
        const takenDoc = await db.collection('usernames').doc(pseudoLower).get();
        if (takenDoc.exists) {
            accSetError('Ce pseudo est déjà pris.');
            return;
        }
        const authEmail = accEmailFromPseudo(pseudo);
        const cred = await auth.createUserWithEmailAndPassword(authEmail, password);
        const uid = cred.user.uid;
        await db.collection('usernames').doc(pseudoLower).set({ uid });
        const userDoc = {
            pseudo, pseudoLower,
            recoveryEmail: email || null,
            role: 'user',
            disabled: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
            progress: state
        };
        await db.collection('users').doc(uid).set(userDoc);
        currentUser = cred.user;
        currentUserDoc = userDoc;
        accShowLoggedIn();
    } catch (e) {
        accSetError(accFriendlyError(e));
    }
}

async function accLogin(pseudo, password) {
    const authEmail = accEmailFromPseudo(pseudo);
    try {
        const cred = await auth.signInWithEmailAndPassword(authEmail, password);
        const uid = cred.user.uid;
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) { accSetError("Compte introuvable."); await auth.signOut(); return; }
        const userDoc = snap.data();
        if (userDoc.disabled) {
            accSetError("Ce compte a été désactivé. Contacte l'administrateur.");
            await auth.signOut();
            return;
        }
        currentUser = cred.user;
        currentUserDoc = userDoc;
        // La progression du cloud devient la référence sur cet appareil
        if (userDoc.progress && typeof userDoc.progress === 'object' && Object.keys(userDoc.progress).length) {
            localStorage.setItem('nl_platform_v1', JSON.stringify(userDoc.progress));
            location.reload();
            return;
        } else {
            scheduleCloudSync(true);
            accShowLoggedIn();
        }
    } catch (e) {
        accSetError(accFriendlyError(e));
    }
}

function accFriendlyError(e) {
    const code = e && e.code || '';
    if (code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('invalid-login-credentials')) return 'Pseudo ou mot de passe incorrect.';
    if (code.includes('user-not-found')) return 'Aucun compte avec ce pseudo.';
    if (code.includes('email-already-in-use')) return 'Ce pseudo est déjà pris.';
    if (code.includes('network-request-failed')) return 'Problème de connexion réseau.';
    return "Erreur : " + (e && e.message ? e.message : e);
}

function accLogout() {
    auth.signOut();
    currentUser = null;
    currentUserDoc = null;
    accShowLoggedOut();
}

function accShowLoggedIn() {
    document.getElementById('acc-logged-out').style.display = 'none';
    document.getElementById('acc-logged-in').style.display = 'block';
    document.getElementById('acc-current-pseudo').innerText = '👤 ' + currentUserDoc.pseudo;
    document.getElementById('acc-admin-entry').style.display = currentUserDoc.role === 'admin' ? 'grid' : 'none';
}

function accShowLoggedOut() {
    document.getElementById('acc-logged-out').style.display = 'block';
    document.getElementById('acc-logged-in').style.display = 'none';
    document.getElementById('acc-pseudo').value = '';
    document.getElementById('acc-password').value = '';
}

// Synchro cloud : appelée à chaque save() local, avec un léger anti-rebond
function scheduleCloudSync(immediate) {
    if (!firebaseAvailable || !currentUser) return;
    clearTimeout(cloudSyncTimer);
    const run = () => {
        document.getElementById('acc-sync-status') && (document.getElementById('acc-sync-status').innerText = 'Synchronisation...');
        db.collection('users').doc(currentUser.uid).set({
            progress: state,
            lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).then(() => {
            const el = document.getElementById('acc-sync-status');
            if (el) el.innerText = 'Synchronisé';
        }).catch(e => console.error('Synchro cloud échouée', e));
    };
    if (immediate) run(); else cloudSyncTimer = setTimeout(run, 1500);
}

function showCompte() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('compte-view').classList.add('active');
    setActiveNav('nav-compte');
    accSwitchTab(accMode);
    if (currentUser) accShowLoggedIn(); else accShowLoggedOut();
    if (!firebaseAvailable) accSetError("Service de comptes indisponible pour le moment (connexion impossible). Ta progression locale reste intacte.");
}

// ===== Panneau admin =====
function showAdmin() {
    if (!currentUserDoc || currentUserDoc.role !== 'admin') {
        alert("Accès réservé à l'administrateur.");
        return;
    }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('admin-view').classList.add('active');
    loadAdminUsers();
}

async function loadAdminUsers() {
    const listEl = document.getElementById('admin-user-list');
    listEl.innerHTML = 'Chargement...';
    try {
        const snap = await db.collection('users').orderBy('pseudo').get();
        if (snap.empty) { listEl.innerHTML = 'Aucun compte.'; return; }
        listEl.innerHTML = '';
        snap.forEach(doc => {
            const u = doc.data();
            const uid = doc.id;
            const row = document.createElement('div');
            row.className = 'admin-row';
            row.innerHTML = `
                <span class="admin-pseudo">${u.pseudo}${u.role === 'admin' ? ' 👑' : ''}</span>
                <span class="admin-status ${u.disabled ? 'disabled' : 'active'}">${u.disabled ? 'Désactivé' : 'Actif'}</span>
                <button style="background:${u.disabled ? 'var(--success)' : 'var(--wrong)'}" onclick="adminToggleDisabled('${uid}', ${!u.disabled})">${u.disabled ? 'Réactiver' : 'Désactiver'}</button>
                <button style="background:#888" onclick="adminClearProgress('${uid}', '${u.pseudo.replace(/'/g, "\\'")}')">Effacer progression</button>
            `;
            listEl.appendChild(row);
        });
    } catch (e) {
        listEl.innerHTML = 'Erreur de chargement : ' + e.message;
    }
}

async function adminToggleDisabled(uid, newVal) {
    try {
        await db.collection('users').doc(uid).update({ disabled: newVal });
        loadAdminUsers();
    } catch (e) {
        alert('Erreur : ' + e.message);
    }
}

async function adminClearProgress(uid, pseudo) {
    if (!confirm(`Effacer toute la progression de "${pseudo}" ? Cette action est irréversible.`)) return;
    try {
        await db.collection('users').doc(uid).update({ progress: { xp: 0, mastered: [] } });
        alert('Progression effacée.');
    } catch (e) {
        alert('Erreur : ' + e.message);
    }
}

// Reprend la session automatiquement au rechargement de la page (Firebase garde la session en local)
if (firebaseAvailable) {
    auth.onAuthStateChanged(async (user) => {
        if (!user) return;
        try {
            const snap = await db.collection('users').doc(user.uid).get();
            if (!snap.exists) return;
            const userDoc = snap.data();
            if (userDoc.disabled) { await auth.signOut(); return; }
            currentUser = user;
            currentUserDoc = userDoc;
            if (document.getElementById('compte-view').classList.contains('active')) accShowLoggedIn();
        } catch (e) {
            console.error('Reprise de session échouée', e);
        }
    });
}

        let fullDb = [];
        let sessionDb = [];
        let state = JSON.parse(localStorage.getItem('nl_platform_v1')) || { xp: 0, mastered: [] };
        // Migration douce : on ajoute les champs manquants sans écraser une sauvegarde existante
        if (!state.stats) {
            state.stats = { modeCounts: { classique: 0, memory: 0, timeattack: 0 }, wordSeen: {} };
        }
        if (!state.memoryHighScore) state.memoryHighScore = null; // { moves, timeSec }
        if (!state.customLists) state.customLists = {}; // { nomListe: [id, id, ...] }
        if (!state.stats.wrongCount) state.stats.wrongCount = {}; // { dirKey: nb de fois raté }
        if (!state.stats.articleMistakes) state.stats.articleMistakes = {}; // { dirKey: nb de fautes de/het (mot connu, article à revoir) }
        if (!state.stats.articleStreak) state.stats.articleStreak = {}; // { dirKey: réussites consécutives au quiz déterminant }
        if (!state.stats.correctStreak) state.stats.correctStreak = {}; // { dirKey: réussites CONSÉCUTIVES }
        if (!state.stats.spacingAnchor) state.stats.spacingAnchor = {}; // { dirKey: position globale à la 2e réussite }
        if (!state.stats.trueMastered) state.stats.trueMastered = {}; // { dirKey: true si vraiment maîtrisé }
        if (!state.stats.unlockedBatches) state.stats.unlockedBatches = {}; // { sourceKey: nb de paquets de 10 débloqués }
        if (state.stats.position === undefined) state.stats.position = 0; // compteur global, incrémenté à chaque réponse
        if (!state.settings) state.settings = { direction: 'fr2nl' }; // 'fr2nl' ou 'nl2fr'
        if (!state.settings.theme) state.settings.theme = 'auto'; // 'auto' | 'clair' | 'sombre'
        let wlSelected = new Set();
        let batchResults = []; // suivi des 10 derniers mots de la session en cours (id + correct/faux)
        let lastRevisionWarning = 0; // dernier seuil de révision (multiple de 10) déjà signalé
        let currentItem = null;
        let currentSessionSourceKey = null;   // clé de la source en cours (catégorie/liste + sens), pour le système de paquets de 10
        let currentSessionOrderedItems = null; // ordre stable des mots de cette source, pour le découpage en paquets
        let inRevisionMode = false;
        let revisionQueue = []; // file d'attente : chaque mot n'y figure qu'une fois

        function seeWord(id) {
            const key = dirKey(id);
            state.stats.wordSeen[key] = (state.stats.wordSeen[key] || 0) + 1;
        }

        function bumpMode(mode) {
            state.stats.modeCounts[mode] = (state.stats.modeCounts[mode] || 0) + 1;
        }

        // Clé de suivi par mot ET par sens : un mot peut être maîtrisé FR→NL sans l'être NL→FR
        function dirKey(id) {
            return id + '::' + state.settings.direction;
        }

        const MIN_SPACING_FOR_MASTERY = 25; // nb mini de mots vus entre un raté et son retest en révision (déjà géré par la file d'attente)

        // Règle simplifiée : réussi du premier coup (ou lors d'un retest en révision, déjà espacé
        // naturellement par la file d'attente) = maîtrisé immédiatement. Raté = direct en révision,
        // et il faudra une réussite (au prochain passage, espacé) pour en sortir.
        function registerResult(id, isCorrect) {
            const key = dirKey(id);
            state.stats.position = (state.stats.position || 0) + 1;

            if (!isCorrect) {
                state.stats.wrongCount[key] = (state.stats.wrongCount[key] || 0) + 1;
                state.stats.trueMastered[key] = false;
            } else {
                state.stats.trueMastered[key] = true;
                state.stats.wrongCount[key] = 0;
            }
            batchResults.push({ id, isCorrect });
            if (batchResults.length >= 10) {
                showBatchRecap();
                batchResults = [];
            }
            checkRevisionWarning();
        }

        function isTrueMastered(id) {
            return !!state.stats.trueMastered[dirKey(id)];
        }

        // Retire du pool actif les mots vraiment maîtrisés ET les mots actuellement en révision
        // (une fois raté, un mot n'est récupérable QUE via le mode Révision dédié, pas ailleurs)
        function activePool(items) {
            return items.filter(i => !isTrueMastered(i.id) && (state.stats.wrongCount[dirKey(i.id)] || 0) === 0);
        }

        // Alerte dès que la pile "mots à réviser" franchit un nouveau multiple de 10
        function checkRevisionWarning() {
            const n = getReviewItems().length;
            const threshold = Math.floor(n / 10) * 10;
            if (threshold < lastRevisionWarning) {
                lastRevisionWarning = threshold; // la pile a baissé, on réarme l'alerte pour plus tard
            } else if (threshold >= 10 && threshold > lastRevisionWarning) {
                lastRevisionWarning = threshold;
                const go = confirm(`⚠️ Tu as ${n} mots à réviser accumulés.\n\nVeux-tu t'entraîner dessus maintenant ?`);
                if (go) startRevision();
            }
        }

        function getReviewItems() {
            return fullDb.filter(i => (state.stats.wrongCount[dirKey(i.id)] || 0) > 0)
                .sort((a, b) => {
                    const diff = (state.stats.wrongCount[dirKey(b.id)] || 0) - (state.stats.wrongCount[dirKey(a.id)] || 0);
                    return diff !== 0 ? diff : (b.freq || 0) - (a.freq || 0);
                });
        }

        function wordStatus(id) {
            const key = dirKey(id);
            if (!state.stats.wordSeen[key]) return 'unseen';
            if ((state.stats.wrongCount[key] || 0) > 0) return 'review';
            if (isTrueMastered(id)) return 'true-mastered';
            return 'mastered';
        }

        // --- Système de paquets de 10 (déblocage progressif par catégorie/liste, par sens) ---
        // Un paquet est "propre" quand tous ses mots sont maîtrisés (sans faute en attente).
        function isBatchClean(batchItems) {
            return batchItems.length > 0 && batchItems.every(i => isTrueMastered(i.id));
        }

        function maybeUnlockBatches(sourceKey, orderedItems) {
            let unlocked = state.stats.unlockedBatches[sourceKey] || 1;
            while (unlocked * 10 < orderedItems.length) {
                const batch = orderedItems.slice((unlocked - 1) * 10, unlocked * 10);
                if (isBatchClean(batch)) unlocked++; else break;
            }
            state.stats.unlockedBatches[sourceKey] = unlocked;
            return unlocked;
        }

        function getUnlockedItems(sourceKey, orderedItems) {
            const unlocked = maybeUnlockBatches(sourceKey, orderedItems);
            return orderedItems.slice(0, unlocked * 10);
        }

        // Recalcule le pool de la session en cours (nouveau paquet débloqué, mot devenu vraiment maîtrisé, etc.)
        function refreshSessionPool() {
            if (!currentSessionSourceKey) return;
            const unlocked = getUnlockedItems(currentSessionSourceKey, currentSessionOrderedItems);
            sessionDb = activePool(unlocked);
        }

        // Paliers de fréquence (échelle Zipf, 0-8). freq=0 = donnée absente (fichier sans colonne fréquence).
        const FREQ_BANDS = [
            { idx: 0, label: 'Très courant', min: 5.5, level: 'A1' },
            { idx: 1, label: 'Courant', min: 4.5, level: 'A2' },
            { idx: 2, label: 'Moyen', min: 3.5, level: 'B1' },
            { idx: 3, label: 'Peu courant', min: 2.5, level: 'B2' },
            { idx: 4, label: 'Rare / spécialisé', min: 0.01, level: 'B2' },
            { idx: 5, label: 'Fréquence inconnue', min: -Infinity, level: null }
        ];
        function freqBand(freq) {
            return FREQ_BANDS.find(b => freq >= b.min) || FREQ_BANDS[FREQ_BANDS.length - 1];
        }

        // Ordre pédagogique des paliers de priorité (du plus important au moins important)
        const TIER_ORDER = { 'Auxiliaire/Modal': 0, 'Essentiel': 1, 'Courant': 2, 'Spécialisé': 3 };

        // Trie une liste de mots par priorité pédagogique d'abord (si connue), puis par fréquence.
        // Les mots sans info de priorité (fichiers plus anciens) se trient juste par fréquence.
        function byFrequencyDesc(items) {
            return [...items].sort((a, b) => {
                const ta = TIER_ORDER[a.tier] ?? 99;
                const tb = TIER_ORDER[b.tier] ?? 99;
                if (ta !== tb) return ta - tb;
                return (b.freq || 0) - (a.freq || 0);
            });
        }

        function toggleDirection() {
            state.settings.direction = state.settings.direction === 'fr2nl' ? 'nl2fr' : 'fr2nl';
            save();
            updateDirectionButton();
        }

        function toggleTheme() {
            const order = { auto: 'clair', clair: 'sombre', sombre: 'auto' };
            state.settings.theme = order[state.settings.theme] || 'auto';
            save();
            applyTheme();
        }

        function applyTheme() {
            const t = state.settings.theme;
            if (t === 'clair') document.documentElement.setAttribute('data-theme', 'light');
            else if (t === 'sombre') document.documentElement.setAttribute('data-theme', 'dark');
            else document.documentElement.removeAttribute('data-theme');
            const btn = document.getElementById('theme-btn');
            if (btn) {
                const labels = { auto: '🌗 Thème : Auto (selon l\'appareil)', clair: '☀️ Thème : Clair', sombre: '🌙 Thème : Sombre' };
                btn.innerText = labels[t];
            }
        }

        function updateDirectionButton() {
            const btn = document.getElementById('direction-btn');
            if (!btn) return;
            btn.innerText = state.settings.direction === 'fr2nl'
                ? '🔀 Sens : Français → Néerlandais'
                : '🔀 Sens : Néerlandais → Français';
        }

        // Renvoie { question, answerField } selon le sens choisi, pour un item {fr, nl}
        function questionFor(item) {
            const dir = state.settings.direction;
            return dir === 'fr2nl'
                ? { question: item.fr, answerField: 'nl' }
                : { question: item.nl, answerField: 'fr' };
        }

        // Normalise pour comparer sans se faire piéger par accents/apostrophes/espaces
        function normalize(str) {
            return str
                .toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
                .replace(/['’´`]/g, "'") // uniformise les apostrophes
                .replace(/\s+/g, ' ')
                .trim();
        }

        async function init() {
            // Fichiers de vocabulaire "de base" : obligatoires, erreur affichée si absents/vides
            const coreFiles = [
                'VERBES_NL.csv', 'NOMS_NL.csv', 'ADJECTIFS_NL.csv', 'ADVERBES_NL.csv', 'MOTS_OUTILS_NL.csv',
                'PHRASES_LABO_avec_frequence.csv', 'MOTS_LABO_avec_frequence.csv'
            ];
            // Fichiers de thèmes métier : optionnels. Ajoute simplement un CSV avec un de ces noms
            // (ou un nouveau nom dans cette liste) pour qu'il apparaisse automatiquement dans "Thèmes".
            const themeCandidates = [
                'THEME_BASE_avec_frequence.csv', 'THEME_MARKETING.csv', 'THEME_FINANCE.csv',
                'THEME_COMPTABILITE.csv', 'THEME_LOGISTIQUE.csv', 'THEME_SUPPLYCHAIN.csv',
                'THEME_MANAGEMENT.csv', 'THEME_RH.csv', 'THEME_ENTRETIEN.csv'
            ];
            const errors = [];
            const loadedThemes = [];

            // Enlève le suffixe technique pour garder des noms de catégories propres dans l'interface
            function baseName(f) {
                return f.replace('_avec_frequence.csv', '').replace('.csv', '');
            }

            // Seul THEME_BASE garde l'ancienne structure ID;NL;FR;... — tous les nouveaux fichiers
            // (VERBES_NL, NOMS_NL, ADJECTIFS_NL, ADVERBES_NL, MOTS_OUTILS_NL, MOTS_LABO, PHRASES_LABO)
            // suivent désormais le même schéma propre : id;fr;nl;freq
            const NL_FIRST_FILES = ['THEME_BASE'];

            async function loadFile(f, isCore) {
                const base = baseName(f);
                const nlFirst = NL_FIRST_FILES.includes(base);
                const frIdx = nlFirst ? 2 : 1;
                const nlIdx = nlFirst ? 1 : 2;
                try {
                    const r = await fetch(f);
                    if (!r.ok) { if (isCore) errors.push(f + ' : HTTP ' + r.status); return 0; }
                    const t = await r.text();
                    let count = 0;
                    let rowIdx = 0;
                    t.split(/\r?\n/).slice(1).forEach(l => {
                        if (!l.trim()) return;
                        const c = l.split(';');
                        if (c[nlIdx] !== undefined && c[nlIdx].trim()) {
                            // La fréquence est en colonne 4 (index 3) pour les fichiers fr-first (id;fr;nl;freq;...).
                            // Pour THEME_BASE (nl-first), elle reste en toute dernière colonne comme avant.
                            const freqStr = nlFirst ? c[c.length - 1] : c[3];
                            const freqRaw = parseFloat(freqStr);
                            // Priorité (Essentiel/Courant/Spécialisé/Auxiliaire-Modal), si présente :
                            // toujours la toute dernière colonne des fichiers fr-first avec 5+ colonnes.
                            const tier = (!nlFirst && c.length > 4) ? (c[c.length - 1] || '').trim() : '';
                            fullDb.push({
                                id: f + '_row' + rowIdx, fr: (c[frIdx] || '').trim(), nl: c[nlIdx].trim(),
                                file: base, freq: isNaN(freqRaw) ? 0 : freqRaw, tier: tier
                            });
                            count++;
                            rowIdx++;
                        }
                    });
                    if (count === 0 && isCore) errors.push(f + ' : chargé mais 0 ligne valide (vérifie le séparateur ";")');
                    return count;
                } catch (e) {
                    if (isCore) errors.push(f + ' : ' + e.message + ' (fichier manquant ou bloqué par CORS — sers l\'app via un serveur local, pas en double-clic file://)');
                    return 0;
                }
            }

            for (let f of coreFiles) await loadFile(f, true);
            for (let f of themeCandidates) {
                const count = await loadFile(f, false);
                if (count > 0) loadedThemes.push({ file: baseName(f), count });
            }

            if (errors.length) {
                document.getElementById('load-error').innerText = errors.join('\n');
            }
            renderThemes(loadedThemes);
            renderCustomListsHome();
            renderMainCategories();
            updateDirectionButton();
            applyTheme();
            updateStats();
            setActiveNav('nav-home');
            setupSwipeDrag();
            await loadCurriculumData();
            renderDashboard();
        }

        // ===== Curriculum (données de programme A1→B2) =====
        let curriculumLevels = [];
        let curriculumModules = [];
        let curriculumNotions = {};
        let curriculumExercises = [];
        let curriculumLoaded = false;
        let conjugationData = [];
        let conjugationLoaded = false;

        if (!state.curriculum) state.curriculum = { notionProgress: {} }; // { [notionId]: { opened, attempts, correct } }

        async function loadCurriculumData() {
            try {
                const [lv, mo, no, ex] = await Promise.all([
                    fetch('data/curriculum/levels.json').then(r => r.json()),
                    fetch('data/curriculum/modules.json').then(r => r.json()),
                    fetch('data/curriculum/notions.json').then(r => r.json()),
                    fetch('data/curriculum/exercises.json').then(r => r.json())
                ]);
                curriculumLevels = lv;
                curriculumModules = mo;
                curriculumNotions = no;
                curriculumExercises = ex;
                curriculumLoaded = true;
            } catch (e) {
                console.warn('Curriculum non chargé (fichiers data/curriculum/*.json introuvables) :', e);
                curriculumLoaded = false;
            }
            try {
                conjugationData = await fetch('data/curriculum/conjugation.json').then(r => r.json());
                conjugationLoaded = true;
            } catch (e) {
                console.warn('Conjugaison non chargée :', e);
                conjugationLoaded = false;
            }
        }

        function ntProgress(notionId) {
            if (!state.curriculum.notionProgress[notionId]) {
                state.curriculum.notionProgress[notionId] = { opened: false, attempts: 0, correct: 0 };
            }
            return state.curriculum.notionProgress[notionId];
        }

        // ===== MasteryEngine (v1) : score 0-5 par notion =====
        // 0 jamais étudié, 1 découvert (leçon ouverte), 2 en cours (< 50% de bonnes réponses),
        // 3 entraîné (>= 50%), 4 presque maîtrisé (100% sur le premier passage),
        // 5 maîtrisé (100% de réussite, revu plusieurs fois)
        function computeNotionMastery(notionId) {
            const notion = curriculumNotions[notionId];
            const p = state.curriculum.notionProgress[notionId];
            if (!notion) return 0;
            if (!p || (!p.opened && p.attempts === 0)) return 0;
            if (p.attempts === 0) return 1;
            const ratio = p.correct / p.attempts;
            const exCount = (notion.exerciseIds || []).length || 1;
            if (ratio < 0.5) return 2;
            if (ratio < 1) return 3;
            if (p.attempts < exCount * 2) return 4;
            return 5;
        }

        function isNotionUnlocked(notionId) {
            const notion = curriculumNotions[notionId];
            if (!notion) return false;
            if (!notion.prerequisites || notion.prerequisites.length === 0) return true;
            return notion.prerequisites.every(pid => computeNotionMastery(pid) >= 3);
        }

        // ===== WeaknessEngine (v1) =====
        // Ne regarde que les notions déjà rédigées (status "pret") — le reste n'a pas encore
        // de contenu, ce n'est pas une "faiblesse" mais du programme pas encore construit.
        function getWeaknesses() {
            return Object.keys(curriculumNotions)
                .filter(id => curriculumNotions[id].status === 'pret')
                .map(id => ({ id, label: id, mastery: computeNotionMastery(id), notion: curriculumNotions[id] }))
                .filter(w => w.mastery < 4)
                .sort((a, b) => a.mastery - b.mastery);
        }

        // ===== RecommendationEngine (v1) =====
        // Cherche, dans l'ordre du programme, la première notion prête (contenu rédigé),
        // débloquée (prérequis acquis) et pas encore maîtrisée à 5.
        function getRecommendation() {
            const modulesSorted = [...curriculumModules].sort((a, b) => a.order - b.order);
            for (const mod of modulesSorted) {
                for (const notionId of mod.notions) {
                    const notion = curriculumNotions[notionId];
                    if (!notion || notion.status !== 'pret') continue;
                    if (computeNotionMastery(notionId) >= 5) continue;
                    if (!isNotionUnlocked(notionId)) continue;
                    return { notionId, notion, module: mod };
                }
            }
            return null;
        }

        // ===== Dashboard =====
        function renderDashboard() {
            const block = document.getElementById('dashboard-block');
            if (!block) return;
            const vp = getVocabProgress();
            const reviewCount = getReviewItems().length;

            let continueHtml = '';
            if (curriculumLoaded) {
                const rec = getRecommendation();
                if (rec) {
                    continueHtml = `
                        <div class="dash-card dash-continue-card" onclick="showLesson('${rec.notionId}')">
                            <div class="dash-continue-label">Continuer</div>
                            <div class="dash-continue-title">${rec.module.label} — ${rec.notion.content.objectif ? rec.notion.content.objectif.split('.')[0] : rec.notionId}</div>
                            <div style="font-size:0.8rem; opacity:0.9;">~10 min</div>
                        </div>`;
                } else {
                    continueHtml = `<div class="dash-card" style="text-align:center; color:#888; font-size:0.85rem;">Toutes les leçons disponibles sont maîtrisées pour l'instant — d'autres arrivent bientôt 🎉</div>`;
                }
            }

            const weaknesses = curriculumLoaded ? getWeaknesses().slice(0, 5) : [];
            const weakHtml = weaknesses.length ? weaknesses.map(w => `
                <div class="dash-weak-row">
                    <span>${w.id.replace(/_/g, ' ')}</span>
                    <div class="dash-mini-bar"><div class="dash-mini-fill" style="width:${w.mastery * 20}%"></div></div>
                </div>`).join('') : `<div style="font-size:0.8rem; color:#888;">Rien à signaler pour l'instant.</div>`;

            block.innerHTML = `
                <div class="dash-card">
                    <div class="dash-level-row">
                        <span class="dash-level-badge">${vp.level} — ${vp.pct}%</span>
                        <span style="font-size:0.75rem; color:#888;">niveau interne estimé</span>
                    </div>
                    <div class="dash-progress-bar"><div class="dash-progress-fill" style="width:${vp.pct}%"></div></div>
                </div>
                ${continueHtml}
                <div class="dash-card">
                    <h3 style="margin:0 0 10px; font-size:0.9rem;">Aujourd'hui</h3>
                    <div class="dash-today-grid">
                        <div class="dash-today-item"><div class="dash-today-num">${reviewCount}</div><div class="dash-today-label">révisions</div></div>
                        <div class="dash-today-item"><div class="dash-today-num">${curriculumLoaded && getRecommendation() ? 1 : 0}</div><div class="dash-today-label">leçon</div></div>
                        <div class="dash-today-item"><div class="dash-today-num">${curriculumLoaded && getRecommendation() ? (getRecommendation().notion.exerciseIds || []).length : 0}</div><div class="dash-today-label">exercices</div></div>
                        <div class="dash-today-item" style="cursor:pointer;" onclick="showRoleplay()"><div class="dash-today-num">5 min</div><div class="dash-today-label">expression orale</div></div>
                    </div>
                </div>
                <div class="dash-card">
                    <h3 style="margin:0 0 10px; font-size:0.9rem;">Tes principales faiblesses</h3>
                    ${weakHtml}
                </div>`;
        }

        // ===== Vue "Apprendre" (parcours par niveau/module/notion) =====
        let apprendreCurrentLevel = 'A1';

        function showApprendre() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('apprendre-view').classList.add('active');
            setActiveNav('nav-apprendre');
            if (!curriculumLoaded) {
                document.getElementById('module-list').innerHTML = '<p style="color:#888;">Programme en cours de chargement...</p>';
                return;
            }
            renderApprendreLevel(apprendreCurrentLevel);
        }

        function renderApprendreLevel(levelId) {
            apprendreCurrentLevel = levelId;
            const tabRow = document.getElementById('level-tab-row');
            tabRow.innerHTML = curriculumLevels.map(l =>
                `<button class="level-tab ${l.id === levelId ? 'active' : ''}" onclick="renderApprendreLevel('${l.id}')">${l.id}</button>`
            ).join('');

            const modulesForLevel = curriculumModules.filter(m => m.level === levelId).sort((a, b) => a.order - b.order);
            const listEl = document.getElementById('module-list');
            if (!modulesForLevel.length) {
                listEl.innerHTML = '<p style="color:#888;">Programme pas encore rédigé pour ce niveau.</p>';
                return;
            }
            listEl.innerHTML = modulesForLevel.map(mod => {
                const rows = mod.notions.map(nid => {
                    const notion = curriculumNotions[nid];
                    if (!notion) return '';
                    const ready = notion.status === 'pret';
                    const unlocked = ready && isNotionUnlocked(nid);
                    const mastery = ready ? computeNotionMastery(nid) : 0;
                    const label = nid.replace(/_/g, ' ');
                    const statusHtml = !ready
                        ? `<span class="notion-status pending">à venir</span>`
                        : `<span class="notion-status s${mastery}">${mastery}/5</span>`;
                    const clickAttr = (ready && unlocked) ? `onclick="showLesson('${nid}')"` : '';
                    return `<div class="notion-row ${(!ready || !unlocked) ? 'locked' : ''}" ${clickAttr}>
                        <span>${label}</span>${statusHtml}
                    </div>`;
                }).join('');
                return `<div class="module-card"><h3>${mod.order}. ${mod.label}</h3>${rows}</div>`;
            }).join('');
        }

        // ===== Vue Leçon =====
        let currentLessonNotionId = null;

        function showLesson(notionId) {
            currentLessonNotionId = notionId;
            const notion = curriculumNotions[notionId];
            if (!notion || !notion.content) return;
            ntProgress(notionId).opened = true;
            save();

            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('lesson-view').classList.add('active');

            const c = notion.content;
            const exCount = (notion.exerciseIds || []).length;
            const mastery = computeNotionMastery(notionId);
            const rpSuggestion = mastery >= 4 ? getRoleplaySuggestion(notionId) : null;
            document.getElementById('lesson-content').innerHTML = `
                <div class="lesson-block"><h3>🎯 Objectif</h3><p>${c.objectif || ''}</p></div>
                <div class="lesson-block"><h3>📖 Comprendre</h3><p>${c.comprendre || ''}</p></div>
                <div class="lesson-block"><h3>🇳🇱 Règle</h3><p>${c.regle || ''}</p></div>
                <div class="lesson-block"><h3>👀 Exemples</h3>${(c.exemples || []).map(ex => `<div class="lesson-example">${ex}</div>`).join('')}</div>
                <div class="lesson-block"><h3>⚠️ Erreurs fréquentes</h3>${(c.erreursFrequentes || []).map(er => `<div class="lesson-error">${er}</div>`).join('')}</div>
                ${c.objectifCommunication ? `<div class="lesson-block"><h3>💬 Objectif de communication</h3><p>${c.objectifCommunication}</p></div>` : ''}
                ${(c.vocabulaire && c.vocabulaire.length) ? `<div class="lesson-block"><h3>🗂️ Vocabulaire utile</h3><div class="lesson-vocab-list">${c.vocabulaire.map(v => `<span class="lesson-vocab-item">${v}</span>`).join('')}</div></div>` : ''}
                ${c.tacheProduction ? `<div class="lesson-block lesson-tache"><h3>✍️ À toi de jouer</h3><p>${c.tacheProduction}</p></div>` : ''}
                ${c.criteresMaitrise ? `<div class="lesson-block"><h3>✅ Tu maîtrises cette notion si...</h3><p>${c.criteresMaitrise}</p></div>` : ''}
                <button class="gemini-explain-btn" onclick="askGeminiExplainOtherwise('${notionId}')">🤖 Explique-moi autrement</button>
                <div class="gemini-box" id="gemini-explain-box" style="display:none;"></div>
                ${exCount ? `<button class="btn btn-green" onclick="showExercise('${notionId}')">🧩 Commencer les exercices (${exCount})</button>` : ''}
                ${rpSuggestion ? `<div class="roleplay-suggestion-card" onclick="showRoleplay(); rpShowCategory('${rpSuggestion.category}');">🎙️ Notion maîtrisée ! Envie de pratiquer à l'oral ?<br><b>${rpSuggestion.label}</b></div>` : ''}
            `;
        }

        // ===== Vue Exercice =====
        let exerciseQueue = [];
        let exerciseIndex = 0;
        let exerciseSelectedAnswer = null;

        function showExercise(notionId) {
            const notion = curriculumNotions[notionId];
            exerciseQueue = (notion.exerciseIds || []).map(id => curriculumExercises.find(e => e.id === id)).filter(Boolean);
            exerciseIndex = 0;
            document.getElementById('exercise-back-btn').onclick = () => showLesson(notionId);
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('exercise-view').classList.add('active');
            renderCurrentExercise();
        }

        function renderCurrentExercise() {
            const ex = exerciseQueue[exerciseIndex];
            exerciseSelectedAnswer = null;
            document.getElementById('exercise-progress').innerText = `Exercice ${exerciseIndex + 1} / ${exerciseQueue.length}`;
            document.getElementById('exercise-question').innerText = ex.question;
            document.getElementById('exercise-feedback').innerText = '';
            document.getElementById('exercise-check-btn').style.display = '';
            document.getElementById('exercise-next-btn').style.display = 'none';

            const zone = document.getElementById('exercise-answer-zone');
            if (ex.type === 'qcm') {
                // data-index + addEventListener plutôt qu'un onclick inline : évite de casser le
                // HTML quand une option contient une apostrophe (ex: "l'infinitif").
                zone.innerHTML = ex.options.map((opt, i) =>
                    `<button class="ex-option-btn" data-opt-index="${i}"></button>`
                ).join('');
                zone.querySelectorAll('.ex-option-btn').forEach((btn, i) => {
                    btn.textContent = ex.options[i];
                    btn.addEventListener('click', () => selectExerciseOption(btn, ex.options[i]));
                });
            } else if (ex.type === 'remise_en_ordre') {
                exerciseOrderSelection = [];
                exerciseOrderBank = shuffleArray([...ex.words]);
                renderOrderZone();
            } else {
                zone.innerHTML = `<input type="text" id="exercise-text-input" placeholder="Ta réponse...">`;
            }
        }

        function selectExerciseOption(btn, value) {
            document.querySelectorAll('.ex-option-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            exerciseSelectedAnswer = value;
        }

        // ===== Exercices "remise en ordre" (ordre des mots) =====
        let exerciseOrderBank = [];
        let exerciseOrderSelection = [];

        function shuffleArray(arr) {
            const a = [...arr];
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            // évite (rarement) que le mélange retombe exactement sur l'ordre correct
            if (JSON.stringify(a) === JSON.stringify(arr) && a.length > 1) {
                [a[0], a[1]] = [a[1], a[0]];
            }
            return a;
        }

        function renderOrderZone() {
            const zone = document.getElementById('exercise-answer-zone');
            zone.innerHTML = `
                <div class="order-selection" id="order-selection">
                    ${exerciseOrderSelection.map((w, i) => `<button class="ex-order-tile selected" onclick="removeOrderWord(${i})">${w}</button>`).join('') || '<span class="order-placeholder">Clique sur les mots ci-dessous pour construire la phrase...</span>'}
                </div>
                <div class="order-bank" id="order-bank">
                    ${exerciseOrderBank.map((w, i) => `<button class="ex-order-tile" onclick="addOrderWord(${i})">${w}</button>`).join('')}
                </div>`;
        }

        function addOrderWord(bankIndex) {
            const word = exerciseOrderBank[bankIndex];
            exerciseOrderSelection.push(word);
            exerciseOrderBank.splice(bankIndex, 1);
            renderOrderZone();
        }

        function removeOrderWord(selIndex) {
            const word = exerciseOrderSelection[selIndex];
            exerciseOrderBank.push(word);
            exerciseOrderSelection.splice(selIndex, 1);
            renderOrderZone();
        }

        function checkExerciseAnswer() {
            const ex = exerciseQueue[exerciseIndex];
            let given;
            if (ex.type === 'qcm') given = exerciseSelectedAnswer;
            else if (ex.type === 'remise_en_ordre') given = exerciseOrderSelection.join(' ');
            else given = (document.getElementById('exercise-text-input').value || '').trim();
            if (!given) return;

            const expected = ex.type === 'remise_en_ordre' ? ex.answer.join(' ') : ex.answer;
            const isCorrect = normalize(given) === normalize(expected);
            const p = ntProgress(ex.notionId);
            p.attempts++;
            if (isCorrect) p.correct++;
            save();

            const fb = document.getElementById('exercise-feedback');
            fb.style.color = isCorrect ? 'var(--success)' : 'var(--wrong)';
            fb.innerText = isCorrect ? '✅ Correct !' : `❌ Réponse attendue : ${expected}`;

            if (ex.type === 'qcm') {
                document.querySelectorAll('.ex-option-btn').forEach(b => {
                    if (b.textContent === ex.answer) b.classList.add('correct');
                    else if (b.classList.contains('selected')) b.classList.add('wrong');
                });
            } else if (ex.type === 'remise_en_ordre') {
                document.querySelectorAll('#order-selection .ex-order-tile').forEach(b => {
                    b.classList.add(isCorrect ? 'correct' : 'wrong');
                    b.onclick = null;
                });
                document.querySelectorAll('#order-bank .ex-order-tile').forEach(b => b.onclick = null);
            }
            document.getElementById('exercise-check-btn').style.display = 'none';
            document.getElementById('exercise-next-btn').style.display = '';
        }

        function nextExercise() {
            exerciseIndex++;
            if (exerciseIndex >= exerciseQueue.length) {
                showLesson(exerciseQueue[0].notionId);
                renderDashboard();
                return;
            }
            renderCurrentExercise();
        }

        // ===== Vue Conjugaison =====
        let conjugaisonSelectedVerb = null;

        function showConjugaison() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('conjugaison-view').classList.add('active');
            setActiveNav('nav-conjugaison');
            document.getElementById('conj-detail').innerHTML = '';
            if (!conjugationLoaded) {
                document.getElementById('conj-list').innerHTML = '<p style="color:#888;">Données de conjugaison en cours de chargement...</p>';
                return;
            }
            renderConjugaisonList();
        }

        function renderConjugaisonList() {
            if (!conjugationLoaded) return;
            const q = normalize((document.getElementById('conj-search').value || '').trim());
            const listEl = document.getElementById('conj-list');
            let results = conjugationData;
            if (q) {
                results = conjugationData.filter(v =>
                    normalize(v.infinitief).includes(q) || normalize(v.fr).includes(q)
                );
            }
            results = results.slice(0, 40);
            if (!results.length) {
                listEl.innerHTML = '<p style="color:#888;">Aucun verbe trouvé.</p>';
                return;
            }
            listEl.innerHTML = results.map(v =>
                `<div class="conj-list-item" onclick="showConjugaisonDetail('${v.infinitief.replace(/'/g, "\\'")}')">
                    <b>${v.infinitief}</b> <span style="color:#888;">— ${v.fr}</span>
                </div>`
            ).join('');
        }

        function showConjugaisonDetail(infinitief) {
            const v = conjugationData.find(x => x.infinitief === infinitief);
            if (!v) return;
            conjugaisonSelectedVerb = v;
            document.getElementById('conj-detail').innerHTML = `
                <div class="conj-card">
                    <div class="conj-verb-title">${v.infinitief}</div>
                    <div style="color:#888; margin-bottom:10px;">${v.fr}</div>
                    <table class="conj-table">
                        <tr><th>Présent</th><th></th></tr>
                        <tr><td>ik</td><td>${v.present.ik}</td></tr>
                        <tr><td>jij / u</td><td>${v.present.jij}</td></tr>
                        <tr><td>hij / zij / het</td><td>${v.present.hij}</td></tr>
                        <tr><td>wij / jullie / zij</td><td>${v.present.wij}</td></tr>
                        <tr><th>Imperfectum (prétérit)</th><th></th></tr>
                        <tr><td>ik / jij / hij</td><td>${v.preteritum}</td></tr>
                        <tr><th>Perfectum</th><th></th></tr>
                        <tr><td>${v.auxiliaire === 'zijn' ? 'ik ben...' : 'ik heb...'}</td><td>${v.participePasse}</td></tr>
                    </table>
                    <div class="conj-sentence">${v.exempleNl}<br>${v.exempleFr}</div>
                </div>`;
        }

        // ===== GeminiService (abstraction IA) =====
        // Le curriculum NL Mastery reste toujours la source de vérité pédagogique.
        // Gemini n'intervient qu'en complément (reformulations, exemples, correction) — jamais pour définir le programme.
        const GeminiService = (() => {
            function getKey() {
                return localStorage.getItem('gemini_api_key') || '';
            }
            function isAvailable() {
                return !!getKey();
            }
            async function generate(prompt) {
                const apiKey = getKey();
                if (!apiKey) throw new Error('Aucune clé API Gemini enregistrée (vue Jeu de rôle).');
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
                });
                const data = await response.json();
                if (data.error) throw new Error(data.error.message || 'Erreur API Gemini');
                if (data.candidates && data.candidates[0].content) {
                    return data.candidates[0].content.parts[0].text;
                }
                throw new Error('Réponse Gemini vide ou bloquée.');
            }
            return {
                isAvailable,
                explainConcept: (notionContent) => generate(
                    `Tu es un professeur de néerlandais pour francophones. Explique ce concept autrement, avec un angle différent et un exemple concret, en français, en 4 phrases maximum :\n\n${notionContent}`
                ),
                simplifyExplanation: (notionContent) => generate(
                    `Simplifie au maximum cette explication de grammaire néerlandaise pour un débutant francophone, 2 phrases maximum, langage très simple :\n\n${notionContent}`
                ),
                generateExamples: (notionContent, count) => generate(
                    `Donne ${count || 3} nouvelles phrases d'exemple en néerlandais (avec traduction française) illustrant cette règle, différentes de celles déjà données :\n\n${notionContent}`
                ),
                generateExercises: (notionContent, count) => generate(
                    `Crée ${count || 2} nouveaux exercices à choix multiple en néerlandais pour pratiquer cette règle. Réponds en JSON strict: [{"question":"...","options":["...","...","..."],"answer":"..."}]\n\nRègle :\n${notionContent}`
                ),
                correctAnswer: (question, userAnswer, correctAnswer) => generate(
                    `Un apprenant néerlandais a répondu "${userAnswer}" à la question "${question}". La bonne réponse est "${correctAnswer}". Explique en français, en 2 phrases maximum, pourquoi sa réponse est fausse et comment retenir la bonne.`
                ),
                explainMistake: (mistakeDescription) => generate(
                    `Un apprenant francophone fait l'erreur suivante en néerlandais : "${mistakeDescription}". Explique en français, simplement, pourquoi c'est une erreur fréquente pour un francophone et donne un moyen mnémotechnique.`
                ),
                generateConversation: (scenario, history) => generate(
                    `Continue cette conversation en néerlandais dans le contexte suivant : ${scenario}. Historique : ${JSON.stringify(history)}. Réponds uniquement en néerlandais, une ou deux phrases.`
                ),
                evaluateProduction: (prompt_, userText) => generate(
                    `Un apprenant francophone de néerlandais devait : "${prompt_}". Il a écrit : "${userText}". Évalue en français (2-3 phrases) : grammaire correcte ou non, et une suggestion d'amélioration.`
                )
            };
        })();

        async function askGeminiExplainOtherwise(notionId) {
            const notion = curriculumNotions[notionId];
            const box = document.getElementById('gemini-explain-box');
            if (!GeminiService.isAvailable()) {
                box.style.display = '';
                box.innerText = "Pas de clé API Gemini enregistrée. Ajoute-en une gratuitement depuis la vue Jeu de rôle pour activer cette fonctionnalité.";
                return;
            }
            box.style.display = '';
            box.innerText = "L'IA réfléchit...";
            try {
                const contentStr = `${notion.content.objectif}\n${notion.content.comprendre}\n${notion.content.regle}`;
                const text = await GeminiService.explainConcept(contentStr);
                box.innerText = text;
            } catch (e) {
                box.innerText = "Erreur Gemini : " + e.message;
            }
        }

        // ===== Lien curriculum → jeu de rôle =====
        // Suggère une mission de jeu de rôle liée quand une notion vient d'être maîtrisée.
        const NOTION_ROLEPLAY_LINKS = {
            perfectum_intro: { category: 'quotidien', label: "Raconte ta journée d'hier (perfectum)" },
            regles_du_passe_de_base: { category: 'quotidien', label: "Raconte ta journée d'hier (perfectum)" },
            se_presenter: { category: 'entretiens', label: "Entraîne-toi à te présenter en entretien" },
            travail_etudes: { category: 'entretiens', label: "Parle de ton travail en entretien" },
            ville_administration: { category: 'admin', label: "Simule une démarche administrative" },
            achats: { category: 'quotidien', label: "Simule un achat au magasin" }
        };

        function getRoleplaySuggestion(notionId) {
            return NOTION_ROLEPLAY_LINKS[notionId] || null;
        }

        const MAIN_CATEGORIES = [
            { file: 'VERBES_NL', label: 'Verbes' },
            { file: 'NOMS_NL', label: 'Noms' },
            { file: 'ADJECTIFS_NL', label: 'Adjectifs' },
            { file: 'ADVERBES_NL', label: 'Adverbes' },
            { file: 'MOTS_OUTILS_NL', label: 'Mots-outils' },
            { file: 'PHRASES_LABO', label: 'Phrases Labo' }
        ];

        function renderMainCategories() {
            const grid = document.getElementById('main-categories-grid');
            if (!grid) return;
            let totalWords = 0;
            let totalMastered = 0;
            grid.innerHTML = MAIN_CATEGORIES.map(cat => {
                const items = fullDb.filter(i => i.file === cat.file);
                const total = items.length;
                const mastered = items.filter(i => isTrueMastered(i.id)).length;
                const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
                totalWords += total;
                totalMastered += mastered;
                return `
                <div class="card-menu blue" onclick="startSession('${cat.file}')">
                    ${cat.label}
                    <div class="cat-sub">${mastered}/${total} maîtrisés (${pct}%)</div>
                    <div class="cat-bar"><div class="cat-bar-fill" style="width:${pct}%"></div></div>
                </div>`;
            }).join('');
            const totalPct = totalWords > 0 ? Math.round((totalMastered / totalWords) * 100) : 0;
            const totalEl = document.getElementById('total-words-count');
            if (totalEl) totalEl.innerText = `${totalWords} mots au total — ${totalMastered} maîtrisés (${totalPct}%)`;
        }

        function renderThemes(themes) {
            const section = document.getElementById('theme-section');
            if (!themes.length) { section.innerHTML = ''; return; }
            const labels = {
                THEME_BASE: '📚 Base', THEME_MARKETING: '📣 Marketing', THEME_FINANCE: '💰 Finance',
                THEME_COMPTABILITE: '🧾 Comptabilité', THEME_LOGISTIQUE: '📦 Logistique',
                THEME_SUPPLYCHAIN: '🚚 Supply Chain', THEME_MANAGEMENT: '🧭 Management', THEME_RH: '👥 RH'
            };
            section.innerHTML = '<h2 style="margin-top:40px;">Thèmes métier</h2><div class="grid">' +
                themes.map(t => `<div class="card-menu blue" onclick="startSession('${t.file}')">${labels[t.file] || t.file} (${t.count})</div>`).join('') +
                '</div>';
        }

        function renderCustomListsHome() {
            const section = document.getElementById('customlist-section');
            const names = Object.keys(state.customLists);
            if (!names.length) { section.innerHTML = ''; return; }
            section.innerHTML = '<h2 style="margin-top:40px;">Mes listes</h2><div class="grid">' +
                names.map(n => `<div class="card-menu" style="color:#8b5cf6" onclick="startCustomList('${n}')">📋 ${n} (${state.customLists[n].length})</div>`).join('') +
                '</div>';
        }

        // LISTE DES MOTS (vue + sélection + listes perso)
        function showWordList() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('wordlist-view').classList.add('active');
            setActiveNav('nav-list');
            const filter = document.getElementById('wl-filter');
            const categories = [...new Set(fullDb.map(i => i.file))];
            filter.innerHTML = '<option value="">Toutes catégories</option>' +
                categories.map(c => `<option value="${c}">${c}</option>`).join('');
            renderWordList();
        }

        function renderWordList() {
            const search = normalize(document.getElementById('wl-search').value);
            const cat = document.getElementById('wl-filter').value;
            const statusFilter = document.getElementById('wl-status-filter').value;
            const sortMode = document.getElementById('wl-sort').value;
            let items = fullDb;
            if (cat) items = items.filter(i => i.file === cat);
            if (statusFilter) items = items.filter(i => wordStatus(i.id) === statusFilter);
            if (search) items = items.filter(i => normalize(i.fr).includes(search) || normalize(i.nl).includes(search));

            items = [...items];
            if (sortMode === 'freq-desc') items.sort((a, b) => (b.freq || 0) - (a.freq || 0));
            else if (sortMode === 'freq-asc') items.sort((a, b) => (a.freq || 0) - (b.freq || 0));
            else items.sort((a, b) => a.fr.localeCompare(b.fr));

            const badgeLabel = { unseen: 'Non vu', review: 'À réviser', mastered: 'Réussi', 'true-mastered': '★ Maîtrisé' };
            const table = document.getElementById('wl-table');
            table.innerHTML = items.slice(0, 300).map(i => {
                const st = wordStatus(i.id);
                const freqTxt = i.freq ? `freq ${i.freq}` : '';
                return `
                <div class="wl-row ${wlSelected.has(i.id) ? 'selected' : ''}" onclick="toggleWordSelect('${i.id}')">
                    <span class="wl-fr">${i.fr}</span>
                    <span class="wl-nl">${i.nl}</span>
                    <span class="wl-badge ${st}">${badgeLabel[st]}</span>
                    <span class="wl-file">${i.file}${freqTxt ? ' · ' + freqTxt : ''}</span>
                </div>`;
            }).join('');
            if (items.length > 300) {
                table.innerHTML += `<p style="color:#afafaf;font-size:0.8rem;">${items.length - 300} résultats supplémentaires non affichés, affine ta recherche.</p>`;
            }
            document.getElementById('wl-count').innerText = `${items.length} mot(s) affiché(s) — ${wlSelected.size} sélectionné(s)`;
        }

        function selectByStatus(status) {
            const cat = document.getElementById('wl-filter').value;
            let items = fullDb.filter(i => wordStatus(i.id) === status);
            if (cat) items = items.filter(i => i.file === cat);
            items.forEach(i => wlSelected.add(i.id));
            renderWordList();
        }

        function toggleWordSelect(id) {
            if (wlSelected.has(id)) wlSelected.delete(id); else wlSelected.add(id);
            renderWordList();
        }

        function clearWordSelection() {
            wlSelected.clear();
            renderWordList();
        }

        // TRI RAPIDE (swipe façon Tinder) : pioche dans les mots non-vus, glisser à droite = maîtrisé
        let swipeQueue = [];
        let swipeTotal = 0;
        let swipeCurrentItem = null;
        let swipeDragging = false;
        let swipeStartX = 0;
        let swipeStartY = 0;
        let swipeRevealed = false;

        function showSwipeSelect() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('swipe-select-view').classList.add('active');
            const cats = [...MAIN_CATEGORIES.map(c => c.file), ...new Set(fullDb.map(i => i.file).filter(f => !MAIN_CATEGORIES.some(c => c.file === f)))];
            const grid = document.getElementById('swipe-category-grid');
            grid.innerHTML = cats.map(cat => {
                const n = fullDb.filter(i => i.file === cat && wordStatus(i.id) === 'unseen').length;
                const label = (MAIN_CATEGORIES.find(c => c.file === cat) || {}).label || cat;
                return `<div class="card-menu blue" onclick="startSwipeTriage('${cat}')">${label}<div class="cat-sub">${n} mot${n > 1 ? 's' : ''} non vu${n > 1 ? 's' : ''}</div></div>`;
            }).join('') + `<div class="card-menu" style="color:#e11d48; grid-column: span 2;" onclick="startSwipeTriage(null)">🌐 Toutes catégories</div>`;
        }

        function startSwipeTriage(category) {
            const pool = category ? fullDb.filter(i => i.file === category) : fullDb;
            swipeQueue = byFrequencyDesc(pool.filter(i => wordStatus(i.id) === 'unseen'));
            if (swipeQueue.length === 0) { alert("Aucun mot non-vu à trier dans cette catégorie pour l'instant."); return; }
            swipeTotal = swipeQueue.length;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('swipe-view').classList.add('active');
            nextSwipeCard();
        }

        function nextSwipeCard() {
            if (swipeQueue.length === 0) {
                alert("🎉 Tri terminé !");
                showHome();
                return;
            }
            swipeCurrentItem = swipeQueue.shift();
            swipeRevealed = false;
            const { question } = questionFor(swipeCurrentItem);
            document.getElementById('swipe-word').innerText = question;
            document.getElementById('swipe-answer').innerText = '';
            document.getElementById('swipe-hint').innerText = 'Tape pour révéler';
            document.getElementById('swipe-progress').innerText = `${swipeTotal - swipeQueue.length} / ${swipeTotal}`;
            const card = document.getElementById('swipe-card');
            card.style.transition = 'none';
            card.style.transform = 'translateX(0) rotate(0)';
            card.style.background = '';
            void card.offsetWidth;
        }

        function revealSwipeCard() {
            swipeRevealed = true;
            const { answerField } = questionFor(swipeCurrentItem);
            document.getElementById('swipe-answer').innerText = '→ ' + swipeCurrentItem[answerField];
            document.getElementById('swipe-hint').innerText = 'Comment ça se passe ?';
        }

        // level: 'maitrise' (droite) | 'bientot' (haut) | 'travailler' (bas) | 'difficile' (gauche)
        const SWIPE_LEVELS = {
            maitrise:   { dx: 500,  dy: 0,    rot: 20  },
            bientot:    { dx: 0,    dy: -400, rot: 0   },
            travailler: { dx: 0,    dy: 400,  rot: 0   },
            difficile:  { dx: -500, dy: 0,    rot: -20 }
        };

        function swipeAnswer(level) {
            if (!swipeRevealed) { revealSwipeCard(); return; }
            const card = document.getElementById('swipe-card');
            const move = SWIPE_LEVELS[level];
            card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
            card.style.transform = `translate(${move.dx}px, ${move.dy}px) rotate(${move.rot}deg)`;
            card.style.opacity = '0';

            const id = swipeCurrentItem.id;
            seeWord(id);
            if (level === 'maitrise') {
                state.stats.trueMastered[dirKey(id)] = true;
                state.stats.wrongCount[dirKey(id)] = 0;
                markMastered(swipeCurrentItem);
            } else if (level === 'bientot') {
                markMastered(swipeCurrentItem);
            } else if (level === 'travailler') {
                registerResult(id, false);
            } else if (level === 'difficile') {
                registerResult(id, false);
                registerResult(id, false);
            }
            save();
            setTimeout(() => { card.style.opacity = '1'; nextSwipeCard(); }, 250);
        }

        function setupSwipeDrag() {
            const card = document.getElementById('swipe-card');
            card.addEventListener('pointerdown', (e) => {
                if (!swipeRevealed) { revealSwipeCard(); return; }
                swipeDragging = true;
                swipeStartX = e.clientX;
                swipeStartY = e.clientY;
                card.style.transition = 'none';
                card.setPointerCapture(e.pointerId);
            });
            card.addEventListener('pointermove', (e) => {
                if (!swipeDragging) return;
                const dx = e.clientX - swipeStartX;
                const dy = e.clientY - swipeStartY;
                card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 20}deg)`;
                let color = '';
                if (Math.abs(dx) > Math.abs(dy)) {
                    color = dx > 30 ? 'var(--success)' : dx < -30 ? 'var(--wrong)' : '';
                } else {
                    color = dy < -30 ? '#58cc02' : dy > 30 ? '#ffc800' : '';
                }
                card.style.background = color;
            });
            const endDrag = (e) => {
                if (!swipeDragging) return;
                swipeDragging = false;
                const dx = e.clientX - swipeStartX;
                const dy = e.clientY - swipeStartY;
                const threshold = 90;
                if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > threshold) {
                    swipeAnswer(dx > 0 ? 'maitrise' : 'difficile');
                } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > threshold) {
                    swipeAnswer(dy < 0 ? 'bientot' : 'travailler');
                } else {
                    card.style.transition = 'transform 0.2s ease, background 0.2s ease';
                    card.style.transform = 'translate(0,0) rotate(0)';
                    card.style.background = '';
                }
            };
            card.addEventListener('pointerup', endDrag);
            card.addEventListener('pointercancel', endDrag);
        }

        function markSelectedAsMastered() {
            if (wlSelected.size === 0) { alert("Sélectionne au moins un mot d'abord."); return; }
            wlSelected.forEach(id => {
                const key = dirKey(id);
                state.stats.trueMastered[key] = true;
                state.stats.wrongCount[key] = 0;
                if (!state.stats.wordSeen[key]) state.stats.wordSeen[key] = 1;
                const item = fullDb.find(i => i.id === id);
                if (item) markMastered(item);
            });
            const n = wlSelected.size;
            save();
            renderWordList();
            alert(`${n} mot(s) marqué(s) comme vraiment maîtrisé(s).`);
        }

        function saveCustomList() {
            if (wlSelected.size === 0) { alert("Sélectionne au moins un mot d'abord."); return; }
            const name = prompt("Nom de la liste :");
            if (!name) return;
            state.customLists[name] = [...wlSelected];
            save();
            renderCustomListsHome();
            alert(`Liste "${name}" sauvegardée avec ${wlSelected.size} mots.`);
        }

        function setActiveNav(id) {
            document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.remove('active'));
            const btn = document.getElementById(id);
            if (btn) btn.classList.add('active');
        }

        function showHome() {
            stopTimeAttack();
            currentSessionSourceKey = null;
            currentSessionOrderedItems = null;
            inRevisionMode = false;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('home-view').classList.add('active');
            setActiveNav('nav-home');
            if (curriculumLoaded) renderDashboard();
        }

        function startSession(category) {
            inRevisionMode = false;
            const orderedItems = byFrequencyDesc(fullDb.filter(i => i.file === category));
            const sourceKey = 'cat:' + category + '::' + state.settings.direction;
            const unlocked = getUnlockedItems(sourceKey, orderedItems);
            sessionDb = activePool(unlocked);
            if (sessionDb.length === 0) {
                alert(orderedItems.length > 0
                    ? "Bravo, tu maîtrises déjà tous les mots débloqués de cette catégorie (dans ce sens) ! 🎉"
                    : "Fichier " + category + " vide ou manquant.");
                return;
            }
            currentSessionSourceKey = sourceKey;
            currentSessionOrderedItems = orderedItems;
            document.getElementById('session-title').innerText = category;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('study-view').classList.add('active');
            batchResults = [];
            document.getElementById('batch-recap').innerHTML = '';
            bumpMode('classique');
            save();
            nextQ();
        }

        function startCustomList(name) {
            inRevisionMode = false;
            const ids = state.customLists[name] || [];
            const orderedItems = byFrequencyDesc(fullDb.filter(i => ids.includes(i.id)));
            const sourceKey = 'list:' + name + '::' + state.settings.direction;
            const unlocked = getUnlockedItems(sourceKey, orderedItems);
            sessionDb = activePool(unlocked);
            if (sessionDb.length === 0) { alert("Cette liste est vide, ou tous ses mots débloqués sont déjà maîtrisés (dans ce sens) ! 🎉"); return; }
            currentSessionSourceKey = sourceKey;
            currentSessionOrderedItems = orderedItems;
            document.getElementById('session-title').innerText = '📋 ' + name;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('study-view').classList.add('active');
            batchResults = [];
            document.getElementById('batch-recap').innerHTML = '';
            bumpMode('classique');
            save();
            nextQ();
        }

        function startRevision() {
            currentSessionSourceKey = null; // la révision n'est pas soumise au système de paquets
            currentSessionOrderedItems = null;
            const items = getReviewItems();
            if (items.length === 0) { alert("Rien à réviser pour l'instant : réponds à quelques mots d'abord, ceux que tu rates iront ici automatiquement."); return; }
            inRevisionMode = true;
            revisionQueue = [...items].sort(() => 0.5 - Math.random()); // chaque mot n'y figure qu'UNE fois
            document.getElementById('session-title').innerText = '🔁 Révision (mots ratés)';
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('study-view').classList.add('active');
            setActiveNav('nav-revision');
            batchResults = [];
            document.getElementById('batch-recap').innerHTML = '';
            bumpMode('classique');
            save();
            revisionNextQ();
        }

        // Repousse un mot raté plus loin dans la file (25 positions, ou à la fin si la file est plus courte)
        function requeueItem(item) {
            const insertPos = Math.min(25, revisionQueue.length);
            revisionQueue.splice(insertPos, 0, item);
        }

        function revisionNextQ() {
            if (revisionQueue.length === 0) {
                alert("🎉 Session de révision terminée ! Tous les mots de la file ont été retravaillés.");
                inRevisionMode = false;
                showHome();
                return;
            }
            currentItem = revisionQueue.shift(); // on prend le premier de la file, jamais de doublon
            seeWord(currentItem.id);
            save();
            const { question } = questionFor(currentItem);
            document.getElementById('q-text').innerText = question;
            document.getElementById('ans-input').placeholder = state.settings.direction === 'fr2nl'
                ? 'Traduire en Néerlandais...' : 'Traduire en Français...';
            document.getElementById('ans-input').value = "";
            document.getElementById('feedback').innerText = "";
            document.getElementById('ans-input').focus();
        }

        function updateRevisionButton() {
            const n = getReviewItems().length;
            const btn = document.getElementById('revision-btn');
            if (btn) btn.innerText = `🔁 Révision (${n} mot${n > 1 ? 's' : ''})`;
        }

        // --- RÉVISION DES DÉTERMINANTS (de / het) ---
        function nounHasArticle(item) { return /^(de|het)\s+/i.test(item.nl); }
        function correctArticleFor(item) { const m = item.nl.match(/^(de|het)\s+/i); return m ? m[1].toLowerCase() : null; }

        function getArticleReviewItems() {
            return fullDb.filter(i => i.file === 'NOMS_NL' && nounHasArticle(i)
                && (state.stats.articleMistakes[dirKey(i.id)] || 0) > 0);
        }

        function updateArticleRevisionButton() {
            const n = getArticleReviewItems().length;
            const btn = document.getElementById('article-revision-btn');
            if (btn) btn.innerText = `🔤 Révision déterminants (${n} mot${n > 1 ? 's' : ''})`;
        }

        let articleQueue = [];
        let currentArticleItem = null;

        function startArticleRevision() {
            const items = getArticleReviewItems();
            if (items.length === 0) { alert("Rien à réviser côté déterminants pour l'instant."); return; }
            articleQueue = [...items].sort(() => 0.5 - Math.random());
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('article-view').classList.add('active');
            nextArticleQ();
        }

        function nextArticleQ() {
            if (articleQueue.length === 0) {
                alert("🎉 Terminé ! Tous les déterminants de la file ont été retravaillés.");
                showHome();
                return;
            }
            currentArticleItem = articleQueue.shift();
            document.getElementById('article-word').innerText = stripArticle(currentArticleItem.nl);
            document.getElementById('article-feedback').innerText = '';
            const statusLabel = { 'a-reviser': '⚠️ à réviser', 'reussi': '🟡 réussi une fois', 'maitrise': '🏆 maîtrisé', 'non-teste': '' }[articleStatus(currentArticleItem)];
            document.getElementById('article-progress').innerText = `${articleQueue.length} restant(s) — ${statusLabel}`;
        }

        function articleStatus(item) {
            const key = dirKey(item.id);
            if ((state.stats.articleMistakes[key] || 0) > 0) return 'a-reviser';
            if ((state.stats.articleStreak[key] || 0) >= 2) return 'maitrise';
            if ((state.stats.articleStreak[key] || 0) === 1) return 'reussi';
            return 'non-teste';
        }

        function checkArticle(choice) {
            const correct = correctArticleFor(currentArticleItem);
            const fb = document.getElementById('article-feedback');
            const key = dirKey(currentArticleItem.id);
            if (choice === correct) {
                state.stats.articleStreak[key] = (state.stats.articleStreak[key] || 0) + 1;
                const status = articleStatus(currentArticleItem);
                if (status === 'maitrise') {
                    state.stats.articleMistakes[key] = 0; // vraiment acquis, sort de la pile
                    fb.innerText = '✅ ' + correct.toUpperCase() + ' — 🏆 maîtrisé !';
                } else {
                    fb.innerText = '✅ ' + correct.toUpperCase() + ' — réussi (encore 1 fois pour le maîtriser)';
                    articleQueue.push(currentArticleItem); // pas encore acquis, on le repropose plus tard
                }
                fb.style.color = 'var(--success)';
            } else {
                state.stats.articleStreak[key] = 0; // un raté remet le streak à zéro
                fb.innerText = '❌ C\'était ' + correct.toUpperCase();
                fb.style.color = 'var(--wrong)';
                articleQueue.push(currentArticleItem); // repoussé à la fin de la file
            }
            save();
            setTimeout(nextArticleQ, 1400);
        }

        function iDontKnow() {
            const fb = document.getElementById('feedback');
            const { answerField } = questionFor(currentItem);
            fb.innerText = "🤷 RÉPONSE : " + currentItem[answerField];
            fb.style.color = "var(--wrong)";
            registerResult(currentItem.id, false);
            if (inRevisionMode) {
                requeueItem(currentItem);
                save();
                setTimeout(revisionNextQ, 1600);
            } else {
                save();
                setTimeout(nextQ, 1600);
            }
        }

        function showBatchRecap() {
            const wrongOnes = batchResults.filter(r => !r.isCorrect);
            const goodCount = batchResults.length - wrongOnes.length;
            const recap = document.getElementById('batch-recap');
            if (!recap) return;
            recap.innerHTML = `
                <div class="study-box">
                    <h3>Bilan des 10 derniers mots</h3>
                    <p>✅ ${goodCount} bon(s) — ❌ ${wrongOnes.length} à revoir</p>
                    ${wrongOnes.length ? '<button class="btn btn-red" onclick="startRevision()">Réviser ces mots maintenant</button>' : ''}
                    <button class="btn btn-gray" onclick="document.getElementById('batch-recap').innerHTML=''">Continuer</button>
                </div>`;
        }

        // Choisit un mot au hasard dans une liste, en évitant de retomber sur le mot précédent
        function pickRandomExcluding(list, excludeItem) {
            if (list.length <= 1) return list[0];
            let pick;
            do {
                pick = list[Math.floor(Math.random() * list.length)];
            } while (pick.id === (excludeItem && excludeItem.id));
            return pick;
        }

        function nextQ() {
            refreshSessionPool();
            if (sessionDb.length === 0) {
                alert("Bravo, tu as fini tous les mots débloqués disponibles ici pour l'instant ! 🎉");
                showHome();
                return;
            }
            currentItem = pickRandomExcluding(sessionDb, currentItem);
            seeWord(currentItem.id);
            save();
            const { question } = questionFor(currentItem);
            document.getElementById('q-text').innerText = question;
            document.getElementById('ans-input').placeholder = state.settings.direction === 'fr2nl'
                ? 'Traduire en Néerlandais...' : 'Traduire en Français...';
            document.getElementById('ans-input').value = "";
            document.getElementById('feedback').innerText = "";
            document.getElementById('ans-input').focus();
        }

        function markMastered(item) {
            const key = dirKey(item.id);
            if (!state.mastered.includes(key)) {
                state.mastered.push(key);
            }
        }

        function isMasteredAnyDirection(id) {
            return state.mastered.includes(id + '::fr2nl') || state.mastered.includes(id + '::nl2fr');
        }

        // Un mot peut avoir plusieurs réponses valides séparées par "/", ex: "rep1/rep2"
        function getAcceptedAnswers(nl) {
            return nl.split('/').map(s => s.trim()).filter(Boolean);
        }

        // Distance de Levenshtein : nombre minimal de lettres à changer/ajouter/enlever
        // pour passer d'un mot à l'autre. Sert à détecter les fautes de frappe/orthographe.
        function levenshtein(a, b) {
            const m = a.length, n = b.length;
            if (m === 0) return n;
            if (n === 0) return m;
            let prev = Array.from({ length: n + 1 }, (_, j) => j);
            for (let i = 1; i <= m; i++) {
                let curr = [i];
                for (let j = 1; j <= n; j++) {
                    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                    curr[j] = Math.min(
                        prev[j] + 1,      // suppression
                        curr[j - 1] + 1,  // insertion
                        prev[j - 1] + cost // substitution
                    );
                }
                prev = curr;
            }
            return prev[n];
        }

        // Tolérance selon la longueur du mot : plus le mot est long, plus on tolère de fautes
        function toleranceFor(word) {
            if (word.length >= 9) return 2;
            if (word.length >= 4) return 1;
            return 0;
        }

        // Compare la réponse de l'utilisateur à la liste des réponses acceptées.
        // Le contenu entre parenthèses (ex: "behoren (tot)") est optionnel : les DEUX formes sont
        // acceptées comme correctes — avec la particule ("behoren tot") ou sans ("behoren").
        // L'utilisateur peut lui aussi taper plusieurs propositions séparées par "/"
        // (ex: "stellen/zetten" en cas d'hésitation sur un synonyme) : si l'une d'elles est bonne, c'est validé.
        // Si les mots sont tous corrects mais juste dans un ordre différent (ex: particule "zich"
        // déplacée), c'est compté "presque bon" plutôt que faux.
        function evaluateAnswer(userRaw, nl) {
            const userCandidates = getAcceptedAnswers(userRaw)
                .map(u => normalize(u))
                .filter(Boolean);
            if (userCandidates.length === 0) return { status: 'wrong', closest: '', distance: Infinity };

            const accepted = getAcceptedAnswers(nl);
            let best = { status: 'wrong', closest: accepted[0], distance: Infinity };

            for (const rawAccepted of accepted) {
                // Deux variantes possibles pour chaque réponse acceptée : avec la particule inline, sans elle
                const withParticle = normalize(rawAccepted.replace(/[()]/g, ''));
                const withoutParticle = normalize(rawAccepted.replace(/\([^)]*\)/g, ''));
                const targets = [...new Set([withParticle, withoutParticle])];

                for (const user of userCandidates) {
                    for (const target of targets) {
                        const dist = levenshtein(user, target);
                        if (dist === 0) return { status: 'correct', closest: rawAccepted, distance: 0 };
                        if (dist <= toleranceFor(target) && dist < best.distance) {
                            best = { status: 'close', closest: rawAccepted, distance: dist };
                        } else if (dist < best.distance && best.status === 'wrong') {
                            best = { status: 'wrong', closest: rawAccepted, distance: dist };
                        }
                        // Mêmes mots, ordre différent (ex: particule "zich" déplacée) = presque bon
                        const sameWordsDifferentOrder = user.split(' ').filter(Boolean).sort().join(' ')
                            === target.split(' ').filter(Boolean).sort().join(' ') && user !== target;
                        if (sameWordsDifferentOrder && best.status !== 'correct') {
                            best = { status: 'close', closest: rawAccepted, distance: 1, particleOrder: true };
                        }
                    }
                }
            }
            return best;
        }

        // Retire un article de/het en tête de chaîne, pour isoler les fautes de genre grammatical
        function stripArticle(str) {
            return str.replace(/^(de|het)\s+/i, '').trim();
        }

        function checkAns() {
            const raw = document.getElementById('ans-input').value;
            const { answerField } = questionFor(currentItem);
            const correctAnswer = currentItem[answerField];
            const accepted = getAcceptedAnswers(correctAnswer);
            const multi = accepted.length > 1;
            let result = evaluateAnswer(raw, correctAnswer);
            let articleMistake = false;

            // Si c'est un nom néerlandais et que la seule faute est l'article de/het (ou son absence),
            // on compte quand même bon pour la maîtrise, mais on note la faute pour la révision dédiée.
            if (result.status === 'wrong' && answerField === 'nl' && currentItem.file === 'NOMS_NL') {
                const strippedResult = evaluateAnswer(stripArticle(raw), stripArticle(correctAnswer));
                if (strippedResult.status !== 'wrong') {
                    result = strippedResult;
                    articleMistake = true;
                    const key = dirKey(currentItem.id);
                    state.stats.articleMistakes[key] = (state.stats.articleMistakes[key] || 0) + 1;
                }
            }

            const fb = document.getElementById('feedback');
            const goToNext = inRevisionMode ? revisionNextQ : nextQ;

            if (result.status === 'correct') {
                fb.innerText = "✅ BRAVO ! → " + correctAnswer + (multi ? "  (plusieurs réponses acceptées)" : "")
                    + (articleMistake ? "  (⚠️ attention à de/het — envoyé en révision déterminants)" : "");
                fb.style.color = "var(--success)";
                state.xp += 10;
                markMastered(currentItem);
                registerResult(currentItem.id, true);
                save();
                setTimeout(goToNext, 1400);
            } else if (result.status === 'close') {
                const note = result.particleOrder ? " (⚠️ attention à l'ordre/la place de la particule)" : " (petite faute)";
                fb.innerText = "🟡 PRESQUE !" + note + " → " + correctAnswer;
                fb.style.color = "var(--gold)";
                state.xp += 5;
                markMastered(currentItem);
                registerResult(currentItem.id, true);
                save();
                setTimeout(goToNext, 1600);
            } else {
                fb.innerText = "❌ RÉPONSE" + (multi ? "S POSSIBLES : " : " : ") + correctAnswer;
                fb.style.color = "var(--wrong)";
                registerResult(currentItem.id, false);
                if (inRevisionMode) requeueItem(currentItem);
                save();
                setTimeout(goToNext, 1600); // toujours avancer, jamais de retry immédiat sur place
            }
        }

        // MEMORY GAME
        let memMoves = 0;
        let memStartTime = null;
        let memMatchedPairs = 0;
        let memTotalPairs = 6;

        function startMemory() {
            if (fullDb.length < 6) { alert("Pas assez de mots chargés pour jouer au Memory."); return; }
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('memory-view').classList.add('active');
            document.getElementById('memory-result').innerHTML = '';
            bumpMode('memory');

            const grid = document.getElementById('m-grid'); grid.innerHTML = "";
            const pool = byFrequencyDesc(activePool(fullDb)).slice(0, 30);
            const source = pool.length >= 6 ? pool : fullDb;
            let items = [...source].sort(() => 0.5 - Math.random()).slice(0, 6);
            items.forEach(i => seeWord(i.id));
            save();

            let cards = []; items.forEach(i => { cards.push({ t: i.fr, id: i.id }, { t: i.nl, id: i.id }); });
            cards.sort(() => 0.5 - Math.random());

            memMoves = 0;
            memMatchedPairs = 0;
            memTotalPairs = items.length;
            memStartTime = Date.now();
            updateMemoryStatsLine();

            let selected = [];
            let lock = false;
            cards.forEach(c => {
                let d = document.createElement('div'); d.className = 'm-card'; d.innerText = c.t;
                d.onclick = () => {
                    if (lock || selected.length >= 2 || d.classList.contains('selected') || d.classList.contains('matched')) return;
                    d.classList.add('selected'); selected.push({ el: d, id: c.id });
                    if (selected.length === 2) {
                        lock = true;
                        memMoves++;
                        updateMemoryStatsLine();
                        if (selected[0].id === selected[1].id) {
                            setTimeout(() => {
                                selected.forEach(s => { s.el.classList.remove('selected'); s.el.classList.add('matched'); });
                                selected = []; lock = false;
                                memMatchedPairs++;
                                if (memMatchedPairs >= memTotalPairs) finishMemory();
                            }, 400);
                            state.xp += 5; save();
                        } else {
                            setTimeout(() => {
                                selected.forEach(s => s.el.classList.remove('selected'));
                                selected = []; lock = false;
                            }, 800);
                        }
                    }
                };
                grid.appendChild(d);
            });
        }

        function updateMemoryStatsLine() {
            const best = state.memoryHighScore;
            const bestText = best ? `Meilleur score : ${best.moves} coups en ${best.timeSec}s` : 'Meilleur score : —';
            document.getElementById('memory-stats').innerText = `Coups : ${memMoves} — ${bestText}`;
        }

        function finishMemory() {
            const timeSec = Math.round((Date.now() - memStartTime) / 1000);
            const best = state.memoryHighScore;
            let isNewBest = false;
            if (!best || memMoves < best.moves || (memMoves === best.moves && timeSec < best.timeSec)) {
                state.memoryHighScore = { moves: memMoves, timeSec };
                isNewBest = true;
            }
            save();
            updateMemoryStatsLine();
            document.getElementById('memory-result').innerHTML = `
                <div class="study-box">
                    <h2>${isNewBest ? '🏆 Nouveau record !' : 'Terminé !'}</h2>
                    <p>${memMoves} coups, ${timeSec} secondes</p>
                    <button class="btn btn-green" onclick="startMemory()">🔁 REJOUER</button>
                    <button class="btn btn-gray" onclick="showHome()">Retour au menu</button>
                </div>`;
        }

        // TIME ATTACK (contre-la-montre)
        let taInterval = null;
        let taTimeLeft = 30;
        let taDuration = 30;
        let taScore = 0;
        let taCurrent = null;

        function showTASelect() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('ta-select-view').classList.add('active');
        }

        function startTimeAttack(durationSec) {
            if (fullDb.length === 0) { alert("Aucun mot chargé pour jouer."); return; }
            taDuration = durationSec || 30;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('timeattack-view').classList.add('active');
            bumpMode('timeattack');
            taScore = 0;
            taTimeLeft = taDuration;
            document.getElementById('ta-score').innerText = 'Score : 0';
            document.getElementById('ta-timer').innerText = taTimeLeft;
            document.getElementById('ta-feedback').innerText = '';
            nextTAQ();
            document.getElementById('ta-ans-input').focus();

            clearInterval(taInterval);
            taInterval = setInterval(() => {
                taTimeLeft--;
                document.getElementById('ta-timer').innerText = taTimeLeft;
                if (taTimeLeft <= 0) {
                    endTimeAttack();
                }
            }, 1000);
        }

        function nextTAQ() {
            const pool = byFrequencyDesc(activePool(fullDb)).slice(0, 50);
            const source = pool.length ? pool : fullDb;
            taCurrent = pickRandomExcluding(source, taCurrent);
            seeWord(taCurrent.id);
            save();
            const { question } = questionFor(taCurrent);
            document.getElementById('ta-q-text').innerText = question;
            document.getElementById('ta-ans-input').value = '';
        }

        function checkTAAns() {
            if (!taCurrent) return;
            const raw = document.getElementById('ta-ans-input').value;
            const { answerField } = questionFor(taCurrent);
            const correctAnswer = taCurrent[answerField];
            const result = evaluateAnswer(raw, correctAnswer);
            const fb = document.getElementById('ta-feedback');
            if (result.status === 'correct') {
                taScore++;
                state.xp += 3;
                markMastered(taCurrent);
                registerResult(taCurrent.id, true);
                save();
                document.getElementById('ta-score').innerText = 'Score : ' + taScore;
                fb.innerText = '✅ ' + correctAnswer;
                fb.style.color = 'var(--success)';
            } else if (result.status === 'close') {
                taScore += 0.5;
                state.xp += 1;
                markMastered(taCurrent);
                registerResult(taCurrent.id, true);
                save();
                document.getElementById('ta-score').innerText = 'Score : ' + taScore;
                fb.innerText = '🟡 presque : ' + correctAnswer;
                fb.style.color = 'var(--gold)';
            } else {
                registerResult(taCurrent.id, false);
                save();
                fb.innerText = '❌ ' + correctAnswer;
                fb.style.color = 'var(--wrong)';
            }
            nextTAQ();
        }

        function endTimeAttack() {
            clearInterval(taInterval);
            taInterval = null;
            const relancer = confirm("Temps écoulé ! Score final : " + taScore + "\n\nRejouer avec la même durée ?");
            if (relancer) {
                startTimeAttack(taDuration);
            } else {
                showHome();
            }
        }

        function stopTimeAttack() {
            if (taInterval) { clearInterval(taInterval); taInterval = null; }
        }

        // MOT MÉLANGÉ (anagramme)
        let anagramWord = null;   // { item, target } target = mot correct à reconstituer (une seule variante, sans parenthèses/espaces)
        let anagramBuilt = [];    // indices des tuiles déjà utilisées, dans l'ordre choisi
        let anagramScore = 0;
        let anagramTiles = [];    // lettres mélangées affichées

        function anagramCandidates() {
            // Seuls les mots à réponse unique, sans espace ni parenthèse, sont adaptés à ce jeu
            const pool = byFrequencyDesc(activePool(fullDb)).slice(0, 60);
            return pool.filter(i => {
                const { answerField } = questionFor(i);
                const ans = getAcceptedAnswers(i[answerField])[0];
                return ans && !ans.includes(' ') && !ans.includes('(') && ans.length >= 3;
            });
        }

        function startAnagram() {
            const candidates = anagramCandidates();
            if (candidates.length < 1) { alert("Pas assez de mots courts et simples disponibles pour ce jeu pour l'instant."); return; }
            anagramScore = 0;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('anagram-view').classList.add('active');
            document.getElementById('anagram-score').innerText = 'Score : 0';
            nextAnagram();
        }

        function nextAnagram() {
            const candidates = anagramCandidates();
            if (candidates.length === 0) { alert("Plus de mots disponibles pour ce jeu en ce moment !"); showHome(); return; }
            const item = candidates[Math.floor(Math.random() * candidates.length)];
            const { question, answerField } = questionFor(item);
            const target = normalize(getAcceptedAnswers(item[answerField])[0].replace(/\([^)]*\)/g, ''));

            let letters = target.split('');
            let shuffled;
            do {
                shuffled = [...letters].sort(() => 0.5 - Math.random());
            } while (shuffled.join('') === target && letters.length > 1);

            anagramWord = { item, target };
            anagramTiles = shuffled;
            anagramBuilt = [];

            document.getElementById('anagram-clue').innerText = question;
            document.getElementById('anagram-feedback').innerText = '';
            document.getElementById('anagram-input').value = '';
            document.getElementById('anagram-input').focus();
            renderAnagramTiles();
        }

        function renderAnagramTiles() {
            const tilesEl = document.getElementById('anagram-tiles');
            tilesEl.innerHTML = anagramTiles.map((letter, idx) => `
                <div class="letter-tile ${anagramBuilt.includes(idx) ? 'used' : ''}" onclick="pickAnagramLetter(${idx})">${letter}</div>
            `).join('');
            document.getElementById('anagram-built').innerText = anagramBuilt.map(i => anagramTiles[i]).join('') || '\u00A0';
        }

        function pickAnagramLetter(idx) {
            if (anagramBuilt.includes(idx)) return;
            anagramBuilt.push(idx);
            renderAnagramTiles();
            if (anagramBuilt.length === anagramTiles.length) {
                finalizeAnagram(anagramBuilt.map(i => anagramTiles[i]).join(''));
            }
        }

        function submitAnagramTyped() {
            const typed = normalize(document.getElementById('anagram-input').value);
            if (!typed) return;
            finalizeAnagram(typed);
        }

        function clearAnagramAnswer() {
            anagramBuilt = [];
            document.getElementById('anagram-input').value = '';
            renderAnagramTiles();
        }

        function finalizeAnagram(built) {
            const fb = document.getElementById('anagram-feedback');
            const isCorrect = built === anagramWord.target;
            seeWord(anagramWord.item.id);
            registerResult(anagramWord.item.id, isCorrect);
            if (isCorrect) {
                markMastered(anagramWord.item);
                anagramScore++;
                fb.innerText = '✅ Bravo !';
                fb.style.color = 'var(--success)';
            } else {
                fb.innerText = '❌ Correct : ' + anagramWord.target;
                fb.style.color = 'var(--wrong)';
            }
            save();
            document.getElementById('anagram-score').innerText = 'Score : ' + anagramScore;
            setTimeout(nextAnagram, 1400);
        }

        // PROFIL & STATS
        function showProfil() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('profil-view').classList.add('active');
            setActiveNav('nav-profil');
            renderProfil();
        }

        function showInfo() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('info-view').classList.add('active');
            setActiveNav('nav-info');
        }

        function renderProfil() {
            const mc = state.stats.modeCounts;
            const seenEntries = Object.entries(state.stats.wordSeen);
            const totalDistinctSeen = seenEntries.length;
            const top5 = [...seenEntries].sort((a, b) => b[1] - a[1]).slice(0, 5)
                .map(([key, count]) => {
                    const [wid] = key.split('::');
                    const item = fullDb.find(i => i.id === wid);
                    return item ? `${item.fr} → ${item.nl} (${count}x)` : `${key} (${count}x)`;
                });
            const best = state.memoryHighScore;
            const vp = getVocabProgress();

            document.getElementById('profil-content').innerHTML = `
                <div class="study-box" style="text-align:left;">
                    <h3>📊 Niveau CECR</h3>
                    <p>Niveau estimé : <b>${vp.level}</b><br>
                    Mots maîtrisés : ${vp.masteredVocab} / ${vp.totalVocab} (${vp.pct}%)<br>
                    ${vp.nextLevel ? `Encore <b>${vp.wordsToNext}</b> mots avant le niveau ${vp.nextLevel}` : 'Niveau maximum atteint 🎉'}<br>
                    Mots vus au moins une fois : ${totalDistinctSeen}<br>
                    Mots à réviser actuellement : ${getReviewItems().length}</p>

                    <h3>🎮 Parties jouées</h3>
                    <p>Mode classique : ${mc.classique || 0}<br>
                    Memory : ${mc.memory || 0}<br>
                    Contre-la-montre : ${mc.timeattack || 0}</p>

                    <h3>🧩 Memory — meilleur score</h3>
                    <p>${best ? best.moves + ' coups en ' + best.timeSec + ' secondes' : 'Pas encore de partie terminée'}</p>

                    <h3>🔥 Mots les plus revus</h3>
                    <p>${top5.length ? top5.join('<br>') : 'Aucune donnée pour le moment'}</p>
                </div>
                <div class="study-box" style="margin-top:15px; border-color:var(--primary);">
                    <h3 style="color:var(--primary);">💾 Sauvegarde</h3>
                    <p style="font-size:0.85rem;">Exporte un fichier avec toute ta progression (à conserver, ou pour la reprendre sur un autre appareil/navigateur). L'import remplace entièrement la progression actuelle.</p>
                    <button class="btn btn-green" onclick="exportProgress()">📤 Exporter ma progression</button>
                    <input type="file" id="import-file-input" accept=".json" style="display:none;" onchange="importProgress(event)">
                    <button class="btn btn-gray" onclick="document.getElementById('import-file-input').click()">📥 Importer une sauvegarde</button>
                </div>
                <div class="study-box" style="margin-top:15px; border-color:var(--wrong);">
                    <h3 style="color:var(--wrong);">⚠️ Zone dangereuse</h3>
                    <p style="font-size:0.85rem;">Ceci efface définitivement tout ton historique (XP, mots maîtrisés, listes, high scores). Aucune récupération possible.</p>
                    <button class="btn btn-red" onclick="resetProgress()">🗑️ Réinitialiser toute la progression</button>
                </div>`;
        }

        function exportProgress() {
            const dataStr = JSON.stringify(state, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const date = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `nl-mastery-sauvegarde-${date}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }

        function importProgress(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const imported = JSON.parse(e.target.result);
                    if (!imported || typeof imported !== 'object' || !imported.stats) {
                        alert("Fichier invalide : ce n'est pas une sauvegarde reconnaissable.");
                        return;
                    }
                    const ok = confirm("Ceci va REMPLACER entièrement ta progression actuelle par celle du fichier importé. Continuer ?");
                    if (!ok) return;
                    localStorage.setItem('nl_platform_v1', JSON.stringify(imported));
                    alert("Import réussi ! La page va se recharger.");
                    location.reload();
                } catch (err) {
                    alert("Erreur : le fichier n'a pas pu être lu (" + err.message + ").");
                }
            };
            reader.readAsText(file);
        }

        function resetProgress() {
            const confirm1 = confirm("Es-tu sûr ? Toute ta progression (XP, mots maîtrisés, listes perso, stats, high scores) sera effacée définitivement.");
            if (!confirm1) return;
            const confirm2 = prompt('Pour confirmer, tape "RESET" en majuscules :');
            if (confirm2 !== 'RESET') { alert("Réinitialisation annulée."); return; }
            localStorage.removeItem('nl_platform_v1');
            location.reload();
        }

        // TEST DE NIVEAU (basé sur la fréquence réelle des mots)
        let testQueue = [];      // liste ordonnée des items à tester
        let testIndex = 0;
        let testResults = [];    // { item, isCorrect }
        let testMode = null;     // 'full' | 'adaptive'
        let adaptiveBandIdx = 0; // palier en cours pour le test accéléré

        function showTestSelect() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('test-select-view').classList.add('active');
        }

        function testableWords() {
            // On exclut les phrases (pas du vocabulaire isolé) et les mots sans fréquence connue
            return fullDb.filter(i => i.file !== 'PHRASES_LABO' && i.freq > 0);
        }

        function startFullTest() {
            const words = testableWords();
            if (words.length === 0) { alert("Pas assez de mots avec une fréquence connue pour lancer le test."); return; }
            testMode = 'full';
            testResults = [];
            // Les mots déjà vraiment maîtrisés comptent automatiquement comme acquis, sans être reposés
            const already = words.filter(i => isTrueMastered(i.id));
            already.forEach(i => testResults.push({ item: i, isCorrect: true }));
            const toTest = words.filter(i => !isTrueMastered(i.id));
            testQueue = byFrequencyDesc(toTest);
            testIndex = 0;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('test-view').classList.add('active');
            document.getElementById('test-result').innerHTML = '';
            document.getElementById('test-ans-input').style.display = '';
            document.querySelector('#test-view .btn-green').style.display = '';
            if (testQueue.length === 0) { finishTest(); return; }
            testNextQ();
        }

        function startAdaptiveTest() {
            const words = testableWords();
            if (words.length === 0) { alert("Pas assez de mots avec une fréquence connue pour lancer le test."); return; }
            testMode = 'adaptive';
            adaptiveBandIdx = 0;
            testResults = [];
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('test-view').classList.add('active');
            document.getElementById('test-result').innerHTML = '';
            document.getElementById('test-ans-input').style.display = '';
            document.querySelector('#test-view .btn-green').style.display = '';
            loadAdaptiveBand();
        }

        function loadAdaptiveBand() {
            const band = FREQ_BANDS[adaptiveBandIdx];
            if (!band || band.level === null) { finishTest(); return; }
            const words = testableWords().filter(i => freqBand(i.freq).idx === band.idx);
            if (words.length === 0) {
                // Palier vide (pas de mots dedans) : on passe directement au suivant
                adaptiveBandIdx++;
                loadAdaptiveBand();
                return;
            }
            testQueue = [...words].sort(() => 0.5 - Math.random()).slice(0, 5);
            testIndex = 0;
            testNextQ();
        }

        function testNextQ() {
            if (testIndex >= testQueue.length) {
                if (testMode === 'adaptive') {
                    checkAdaptiveBandResult();
                } else {
                    finishTest();
                }
                return;
            }
            const item = testQueue[testIndex];
            const { question } = questionFor(item);
            document.getElementById('test-q-text').innerText = question;
            document.getElementById('test-ans-input').placeholder = state.settings.direction === 'fr2nl'
                ? 'Traduire en Néerlandais...' : 'Traduire en Français...';
            document.getElementById('test-ans-input').value = '';
            document.getElementById('test-feedback').innerText = '';
            document.getElementById('test-ans-input').focus();
            const label = testMode === 'adaptive' ? `Palier "${FREQ_BANDS[adaptiveBandIdx].label}" — ` : '';
            document.getElementById('test-progress').innerText = `${label}Mot ${testIndex + 1} / ${testQueue.length}`;
        }

        function testCheckAns() {
            const item = testQueue[testIndex];
            const raw = document.getElementById('test-ans-input').value;
            const { answerField } = questionFor(item);
            const correctAnswer = item[answerField];
            const result = evaluateAnswer(raw, correctAnswer);
            const isCorrect = result.status !== 'wrong';
            const fb = document.getElementById('test-feedback');
            fb.innerText = isCorrect ? '✅ ' + correctAnswer : '❌ ' + correctAnswer;
            fb.style.color = isCorrect ? 'var(--success)' : 'var(--wrong)';
            seeWord(item.id);
            registerResult(item.id, isCorrect);
            if (isCorrect) markMastered(item);
            save();
            testResults.push({ item, isCorrect });
            testIndex++;
            setTimeout(testNextQ, 900);
        }

        function checkAdaptiveBandResult() {
            const band = FREQ_BANDS[adaptiveBandIdx];
            const bandResults = testResults.filter(r => freqBand(r.item.freq).idx === band.idx);
            const correctCount = bandResults.filter(r => r.isCorrect).length;
            const accuracy = bandResults.length ? correctCount / bandResults.length : 0;
            if (accuracy >= 0.6) {
                adaptiveBandIdx++;
                loadAdaptiveBand();
            } else {
                finishTest();
            }
        }

        function finishTest() {
            // Regroupe les résultats par palier de fréquence pour le bilan
            const byBand = {};
            testResults.forEach(r => {
                const b = freqBand(r.item.freq);
                if (!byBand[b.idx]) byBand[b.idx] = { label: b.label, level: b.level, correct: 0, total: 0 };
                byBand[b.idx].total++;
                if (r.isCorrect) byBand[b.idx].correct++;
            });

            // Niveau estimé : le dernier palier (du plus courant au plus rare) où l'accuracy reste >= 60%
            let estimatedLevel = 'A1 (bases à consolider)';
            Object.keys(byBand).sort((a, b) => a - b).forEach(idx => {
                const b = byBand[idx];
                if (b.total > 0 && b.correct / b.total >= 0.6 && b.level) {
                    estimatedLevel = b.level;
                }
            });

            const rows = Object.keys(byBand).sort((a, b) => a - b).map(idx => {
                const b = byBand[idx];
                const pct = b.total ? Math.round((b.correct / b.total) * 100) : 0;
                return `${b.label} : ${b.correct}/${b.total} (${pct}%)`;
            });

            document.getElementById('test-result').innerHTML = `
                <div class="study-box" style="text-align:left;">
                    <h2 style="text-align:center;">🎯 Niveau estimé : ${estimatedLevel}</h2>
                    <p style="font-size:0.8rem; color:#888;">Estimation heuristique basée sur la fréquence des mots — pas un test scientifiquement validé.</p>
                    <h3>Détail par palier</h3>
                    <p>${rows.join('<br>')}</p>
                    <button class="btn btn-gray" onclick="showHome()" style="margin-top:15px;">Retour au menu</button>
                </div>`;
            document.getElementById('test-progress').innerText = '';
            document.getElementById('test-q-text').innerText = '';
            document.getElementById('test-ans-input').style.display = 'none';
            document.getElementById('test-feedback').innerText = '';
            document.querySelector('#test-view .btn-green').style.display = 'none';
        }

        function save() {
            localStorage.setItem('nl_platform_v1', JSON.stringify(state));
            updateStats();
            scheduleCloudSync();
        }

        // Niveau CECR basé sur le % de vocabulaire distinct maîtrisé.
        // PHRASES_LABO est exclu du total : ce sont des phrases qui réutilisent des mots
        // déjà comptés ailleurs (verbes/noms/adjectifs/thèmes), donc les compter en plus fausserait le %.
        function getVocabProgress() {
            const vocabItems = fullDb.filter(i => i.file !== 'PHRASES_LABO');
            const totalVocab = vocabItems.length;
            const masteredVocab = vocabItems.filter(i => isMasteredAnyDirection(i.id)).length;
            const pct = totalVocab > 0 ? Math.round((masteredVocab / totalVocab) * 100) : 0;
            const thresholds = [
                { level: 'A1', min: 0 }, { level: 'A2', min: 15 },
                { level: 'B1', min: 35 }, { level: 'B2', min: 65 }
            ];
            let level = 'A1', nextLevel = 'A2', nextThresholdPct = 15;
            for (let i = 0; i < thresholds.length; i++) {
                if (pct >= thresholds[i].min) {
                    level = thresholds[i].level;
                    nextLevel = thresholds[i + 1] ? thresholds[i + 1].level : null;
                    nextThresholdPct = thresholds[i + 1] ? thresholds[i + 1].min : null;
                }
            }
            const wordsToNext = nextThresholdPct !== null
                ? Math.max(0, Math.ceil((nextThresholdPct / 100) * totalVocab) - masteredVocab)
                : 0;
            return { pct, level, nextLevel, wordsToNext, totalVocab, masteredVocab };
        }

        function updateStats() {
            const { level } = getVocabProgress();
            document.getElementById('cecr-badge').innerText = level;
            updateRevisionButton();
            updateArticleRevisionButton();
            renderMainCategories();
        }

        // Touche Enter
        document.getElementById('ans-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') checkAns(); });
        document.getElementById('ta-ans-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') checkTAAns(); });
        document.getElementById('test-ans-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') testCheckAns(); });
        document.getElementById('anagram-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') submitAnagramTyped(); });


        // ==================== JEU DE RÔLE VOCAL (Pratique orale) ====================
        let rpRecognition = null;
        let rpIsRecording = false;
        let rpConversationHistory = [];
        let rpFinalTranscript = '';
        let rpDutchVoice = null;
        let rpCurrentCategory = null;
        let rpCurrentScenario = null;

        const RP_SCENARIOS = {
            entretiens: {
                label: "Entretiens d'embauche",
                groups: [
                    { title: "🚚 Transport Planner (ton entretien de mercredi)", items: [
                        { id: 'interview_transportplanner_kennismaking', label: '🤝 Kennismakingsgesprek',
                          welcome: "Goedendag, leuk om kennis te maken! Ik ben blij dat we deze introductie kunnen doen voor de functie van transportplanner. Vertel me eerst eens iets over jezelf en waarom deze functie je aanspreekt.",
                          prompt: "Tu es un responsable RH ou operations belge qui mène un 'kennismakingsgesprek' — un premier entretien informel de prise de contact, pas encore technique — pour un poste de Transport Planner. Parle exclusivement en néerlandais simple et naturel (niveau B1-B2), sur un ton chaleureux et décontracté, c'est une prise de contact, pas un interrogatoire. Aborde dans l'ordre, une question à la fois : présentation de la personne, motivation pour le poste de transport planner, compréhension du rôle (planification des transports, coordination avec les chauffeurs et les clients, gestion des priorités et des imprévus), expérience logistique pertinente (entrepôt, production, gestion des stocks, formations Lean/SAP/Excel/Power BI si mentionnées). Pose aussi explicitement, à un moment naturel de la conversation, une question sur son niveau de néerlandais et son aisance à travailler dans cette langue au quotidien. Termine par les prochaines étapes du process. Reste bienveillant, encourageant, et donne à la personne l'occasion de bien se présenter." }
                    ]},
                    { title: "Supply Chain / Logistique", items: [
                        { id: 'interview_sc_phone', label: '📞 Présélection téléphonique RH',
                          welcome: "Goedendag, u spreekt met de personeelsdienst. Bedankt om tijd te maken voor dit korte telefonisch gesprek over de vacature Supply Chain medewerker. Kan u zich eerst kort voorstellen?",
                          prompt: "Tu es un recruteur RH belge qui mène un entretien téléphonique de présélection (10-15 minutes) pour un poste de Junior Supply Chain / Logistics Coordinator. Parle exclusivement en néerlandais simple et clair (niveau B1). Pose des questions courtes et concrètes une par une : présentation rapide, disponibilité, motivation pour le poste, expérience en entrepôt/production/gestion des stocks, connaissance d'Excel ou SAP, mobilité, prétentions salariales. Reste bref, professionnel et efficace comme un vrai screening téléphonique, pas de questions techniques poussées à ce stade." },
                        { id: 'interview_sc_technical', label: '🛠️ Entretien technique / cas pratique',
                          welcome: "Hallo, fijn dat je kon komen. Vandaag wil ik dieper ingaan op je technische kennis rond supply chain en logistiek. Kan je een situatie beschrijven waarin je een voorraadprobleem hebt opgelost?",
                          prompt: "Tu es un responsable Supply Chain/Logistique belge qui mène un entretien technique en néerlandais (niveau B1/B2) pour un poste de Junior Supply Chain Consultant/Coordinator. Pose des questions concrètes sur la gestion des stocks, les flux logistiques, l'amélioration continue (Lean), l'utilisation d'Excel/SAP/Power BI, et propose un petit cas pratique oral (ex: comment réagir à une rupture de stock, comment prioriser des livraisons en retard). Une question ou un cas à la fois, reste précis et exigeant mais bienveillant." },
                        { id: 'interview_sc_final', label: '🤝 Entretien final avec le manager',
                          welcome: "Goedendag, leuk je te ontmoeten. Ik ben de manager van het team. Laten we het hebben over hoe je zou passen binnen ons team en wat je verwachtingen zijn.",
                          prompt: "Tu es le manager d'équipe Supply Chain qui mène l'entretien final en néerlandais (niveau B1/B2) pour un poste de Junior Supply Chain/Logistics. Concentre-toi sur l'adéquation culturelle, la motivation à long terme, la disponibilité, les attentes salariales, la capacité d'apprentissage rapide, et termine par les prochaines étapes. Ton plus posé et conversationnel qu'un entretien technique, une question à la fois." }
                    ]},
                    { title: "Consultance / SAP / ERP / Power BI", items: [
                        { id: 'interview_consult_phone', label: '📞 Présélection téléphonique RH',
                          welcome: "Goedendag, bedankt voor je interesse in onze consultancyvacature. Ik doe graag een korte telefonische kennismaking. Kan je jezelf even voorstellen?",
                          prompt: "Tu es un recruteur RH belge en cabinet de consultance qui fait une présélection téléphonique (10-15 min) pour un poste de Junior Consultant SAP/ERP/Power BI. Parle en néerlandais simple (B1). Pose des questions courtes sur le parcours, la motivation pour la consultance, la disponibilité pour des déplacements chez le client, les bases en gestion de projet/data/Excel/Power BI, et les attentes salariales. Une question à la fois, reste bref et professionnel." },
                        { id: 'interview_consult_technical', label: '🛠️ Entretien technique / cas pratique',
                          welcome: "Hallo, laten we het hebben over je analytisch denken. Stel: een klant heeft een probleem met zijn voorraadbeheer in SAP. Hoe zou je dat aanpakken?",
                          prompt: "Tu es un senior consultant belge qui mène un entretien technique en néerlandais (B1/B2) pour un poste de Junior Consultant SAP/ERP/Power BI. Pose des questions sur la résolution de problèmes analytiques, la structuration d'une démarche de conseil, la relation client, et propose un mini cas pratique orienté data/process (ex: comment structurer un tableau de bord Power BI, comment gérer un client mécontent). Une question/cas à la fois, ton exigeant mais constructif." },
                        { id: 'interview_consult_final', label: '🤝 Entretien final avec le manager',
                          welcome: "Fijn je te ontmoeten. Ik wil vooral weten of je je goed zou voelen bij ons op lange termijn. Vertel me over je verwachtingen.",
                          prompt: "Tu es un manager/partner de cabinet de consultance qui mène l'entretien final en néerlandais (B1/B2) pour un poste de Junior Consultant. Aborde la culture du cabinet (rythme, déplacements clients, esprit d'équipe), les perspectives d'évolution, les attentes salariales, la disponibilité, et conclus par les prochaines étapes. Ton conversationnel, une question à la fois." }
                    ]},
                    { title: "Recrutement / RH", items: [
                        { id: 'interview_hr_phone', label: '📞 Présélection téléphonique RH',
                          welcome: "Goedendag, bedankt om te bellen voor de functie in werving en selectie. Kan je me kort vertellen waarom deze functie je aanspreekt?",
                          prompt: "Tu es un recruteur RH belge qui fait une présélection téléphonique (10-15 min) pour un poste de Junior Recruitment/Talent Consultant. Parle en néerlandais simple (B1). Pose des questions courtes sur la motivation pour le recrutement/RH, l'expérience en communication/persuasion/contact client, la disponibilité, et les attentes salariales. Une question à la fois, ton dynamique et bref." },
                        { id: 'interview_hr_technical', label: '🛠️ Mises en situation',
                          welcome: "Hallo, stel je voor: je moet een kandidaat overtuigen om een sollicitatiegesprek te plannen, maar hij twijfelt. Hoe pak je dat aan?",
                          prompt: "Tu es un responsable recrutement belge qui mène un entretien basé sur des mises en situation, en néerlandais (B1/B2), pour un poste de Junior Recruitment/Talent Consultant. Propose des mises en situation orales concrètes (convaincre un candidat hésitant, gérer un refus, faire correspondre un profil à une offre, relancer un client) et évalue la communication, la persuasion et la gestion du refus. Une mise en situation à la fois, ton dynamique et exigeant." },
                        { id: 'interview_hr_final', label: '🤝 Entretien final avec le manager',
                          welcome: "Leuk je te ontmoeten. Vertel me eens hoe je jezelf over vijf jaar ziet binnen recruitment.",
                          prompt: "Tu es le manager de l'équipe recrutement qui mène l'entretien final en néerlandais (B1/B2) pour un poste de Junior Recruitment/HR Consultant. Aborde la vision à long terme, la culture d'équipe orientée objectifs/résultats, les attentes salariales, la disponibilité, et conclus par les prochaines étapes. Ton chaleureux et conversationnel, une question à la fois." }
                    ]}
                ]
            },
            admin: {
                label: "Administration belge",
                items: [
                    { id: 'admin_cpas', label: '🏢 CPAS',
                      welcome: "Goedendag, loket OCMW. Waarmee kan ik u vandaag helpen?",
                      prompt: "Tu es un employé du CPAS (OCMW) en Belgique. Accueille la personne en néerlandais simple (B1), demande la raison de sa visite (démarche administrative générale, pas de cas personnel précis), et pose les questions typiques d'un rendez-vous administratif (documents nécessaires, situation, prochaine étape). Une question à la fois, ton neutre et professionnel." },
                    { id: 'admin_medecin', label: '🩺 Visite médicale',
                      welcome: "Goedendag, komt u binnen. Wat kan ik voor u doen vandaag?",
                      prompt: "Tu es un médecin généraliste belge qui reçoit un patient en consultation. Parle en néerlandais simple (B1), pose des questions typiques de consultation (motif de la visite, symptômes généraux bénins comme un rhume ou une douleur légère, depuis quand, antécédents simples) et donne des conseils/une ordonnance fictive à la fin. Reste sur des symptômes bénins et génériques, une question à la fois, ton rassurant et professionnel." },
                    { id: 'admin_mutuelle', label: '💳 Mutuelle',
                      welcome: "Goedendag, u spreekt met uw ziekenfonds. Waarmee kan ik u helpen?",
                      prompt: "Tu es un employé d'une mutuelle belge (ziekenfonds) au téléphone ou au guichet. Parle en néerlandais simple (B1), aide la personne sur des questions courantes : remboursement de frais médicaux, affiliation, carte européenne d'assurance maladie, documents à fournir. Pose une question à la fois pour bien comprendre la demande, ton serviable et clair." },
                    { id: 'admin_commune', label: '🏛️ Commune',
                      welcome: "Goedendag, loket van de gemeente. Waarmee kan ik u vandaag helpen?",
                      prompt: "Tu es un employé communal en Belgique. Accueille l'habitant en néerlandais simple (B1) et demande la raison de sa visite administrative (changement d'adresse, carte d'identité, composition de ménage, etc.), une question à la fois, ton neutre et professionnel." }
                ]
            },
            appels: {
                label: "Appels téléphoniques",
                items: [
                    { id: 'call_standard', label: '☎️ Standard d\'une entreprise',
                      welcome: "Goedendag, u spreekt met het onthaal van het bedrijf. Waarmee kan ik u helpen?",
                      prompt: "Tu es la standardiste/le standardiste d'une entreprise belge qui répond au téléphone. Parle en néerlandais simple (B1). L'utilisateur appelle pour une raison à préciser (transfert vers un service, demande d'information générale) — pose des questions pour comprendre sa demande et le rediriger ou répondre, une question à la fois, ton professionnel et courtois." },
                    { id: 'call_rdv', label: '📅 Prise de rendez-vous',
                      welcome: "Goedendag, met wie spreek ik en waarvoor wenst u een afspraak?",
                      prompt: "Tu es une secrétaire/un secrétaire belge qui gère la prise de rendez-vous par téléphone (cabinet, administration ou entreprise, contexte neutre). Parle en néerlandais simple (B1), demande le motif du rendez-vous, les disponibilités de la personne, ses coordonnées, et confirme un créneau à la fin. Une question à la fois, ton efficace et aimable." },
                    { id: 'call_suivi_candidature', label: '📄 Suivi de candidature',
                      welcome: "Goedendag, u spreekt met de personeelsdienst. U belde ons over de stand van uw sollicitatie, klopt dat?",
                      prompt: "Tu es un recruteur/une recruteuse belge qui répond à un appel de suivi de candidature. Parle en néerlandais simple (B1). Demande poliment de préciser pour quel poste et quand la candidature a été envoyée, donne une réponse réaliste et variable (dossier en cours d'examen, entretien à prévoir, ou décision encore en attente), et reste courtois même sans réponse définitive. Une question/réponse à la fois, ton professionnel et bienveillant." }
                ]
            },
            quotidien: {
                label: "Vie quotidienne",
                items: [
                    { id: 'cafe', label: '☕ Au café / Resto',
                      welcome: "Goedendag! Wat kan ik u vandaag aanbieden?",
                      prompt: "Tu es un serveur dans un café en Flandre. Accueille le client en néerlandais simple (B1), prends sa commande, réponds à ses questions sur le menu, une réponse/question à la fois, ton amical et naturel." }
                ]
            }
        };

        function rpFindScenario(catKey, itemId) {
            const cat = RP_SCENARIOS[catKey];
            if (!cat) return null;
            const list = cat.groups ? cat.groups.flatMap(g => g.items) : cat.items;
            return list.find(i => i.id === itemId) || null;
        }

        function rpSaveApiKey() {
            localStorage.setItem('gemini_api_key', document.getElementById('rp-api-key').value);
        }

        function rpCheckDutchVoice() {
            if (!('speechSynthesis' in window)) return;
            const findVoice = () => {
                const voices = window.speechSynthesis.getVoices();
                rpDutchVoice = voices.find(v => v.lang.toLowerCase().startsWith('nl')) || null;
                const warningDiv = document.getElementById('rp-voice-warning');
                if (!warningDiv) return;
                if (!rpDutchVoice) {
                    warningDiv.style.display = 'block';
                    warningDiv.innerHTML = "⚠️ Aucune voix néerlandaise installée sur cet appareil — le texte sera lu avec une voix par défaut. "
                        + "<br>Windows : Paramètres → Heure et langue → Voix, ajoute \"Nederlands\". "
                        + "<br>Mac : Réglages système → Accessibilité → Contenu énoncé, ajoute une voix néerlandaise. "
                        + "<br>Android/Chrome : Paramètres → Accessibilité → Synthèse vocale, installe les données néerlandaises.";
                } else {
                    warningDiv.style.display = 'none';
                }
            };
            findVoice();
            window.speechSynthesis.onvoiceschanged = findVoice;
        }

        function rpInitSpeechRecognition() {
            window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!window.SpeechRecognition) return; // le message d'erreur s'affichera au clic si besoin

            rpRecognition = new SpeechRecognition();
            rpRecognition.lang = 'nl-NL';
            rpRecognition.continuous = true; // ne coupe pas à la première pause : on gère l'arrêt via le bouton
            rpRecognition.interimResults = true;
            rpRecognition.maxAlternatives = 1;

            rpRecognition.onresult = function(event) {
                let interim = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript;
                    if (event.results[i].isFinal) {
                        rpFinalTranscript += transcript + ' ';
                    } else {
                        interim += transcript;
                    }
                }
                document.getElementById('rp-status').innerText = "🎤 " + ((rpFinalTranscript + interim).trim() || '...');
            };

            rpRecognition.onerror = function(event) {
                document.getElementById('rp-status').innerText = "Erreur de reconnaissance vocale : " + event.error;
                rpStopRecordingUI();
            };

            rpRecognition.onend = function() {
                rpStopRecordingUI();
                const text = rpFinalTranscript.trim();
                rpFinalTranscript = '';
                if (text) {
                    rpAppendMessage(text, 'user');
                    rpSendToGemini(text);
                }
            };
        }

        function rpToggleSpeechRecognition() {
            if (!window.SpeechRecognition) {
                alert("Ton navigateur ne supporte pas la reconnaissance vocale. Utilise Google Chrome.");
                return;
            }
            if (!document.getElementById('rp-api-key').value) {
                alert("Renseigne d'abord ta clé API Gemini en haut de la page.");
                return;
            }
            if (rpIsRecording) {
                rpRecognition.stop();
            } else {
                try {
                    rpFinalTranscript = '';
                    rpRecognition.start();
                    rpStartRecordingUI();
                } catch (e) {
                    console.error(e);
                }
            }
        }

        function rpStartRecordingUI() {
            rpIsRecording = true;
            const btn = document.getElementById('rp-mic-btn');
            btn.classList.add('recording');
            btn.innerText = "🛑 Écoute en cours... Cliquer pour stopper";
            document.getElementById('rp-status').innerText = "Parle en néerlandais...";
        }

        function rpStopRecordingUI() {
            rpIsRecording = false;
            const btn = document.getElementById('rp-mic-btn');
            btn.classList.remove('recording');
            btn.innerText = "🎤 Cliquer pour parler";
            document.getElementById('rp-status').innerText = "Prêt";
        }

        function rpAppendMessage(text, sender) {
            const historyDiv = document.getElementById('rp-chat-history');
            const msgDiv = document.createElement('div');
            msgDiv.className = `rp-message ${sender}`;
            msgDiv.innerText = text;
            historyDiv.appendChild(msgDiv);
            historyDiv.scrollTop = historyDiv.scrollHeight;
        }

        async function rpSendToGemini(userText) {
            const apiKey = document.getElementById('rp-api-key').value;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

            rpConversationHistory.push({ role: "user", parts: [{ text: userText }] });
            document.getElementById('rp-status').innerText = "L'IA réfléchit...";

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: rpConversationHistory })
                });

                const data = await response.json();

                if (data.error) {
                    throw new Error(data.error.message || "Erreur API inconnue");
                }

                if (data.candidates && data.candidates[0].content) {
                    const aiResponse = data.candidates[0].content.parts[0].text;
                    rpConversationHistory.push({ role: "model", parts: [{ text: aiResponse }] });
                    rpAppendMessage(aiResponse, 'assistant');
                    rpSpeakText(aiResponse);
                    document.getElementById('rp-status').innerText = "Prêt";
                } else {
                    throw new Error("Réponse invalide de l'API (pas de contenu retourné, peut-être bloqué par un filtre de sécurité)");
                }
            } catch (error) {
                console.error(error);
                document.getElementById('rp-status').innerText = `Erreur : ${error.message}`;
            }
        }

        function rpSpeakText(text) {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'nl-NL';
                if (rpDutchVoice) utterance.voice = rpDutchVoice;
                utterance.rate = 0.95;
                window.speechSynthesis.speak(utterance);
            }
        }

        function showRoleplay() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('roleplay-view').classList.add('active');
            setActiveNav('nav-roleplay');

            const savedKey = localStorage.getItem('gemini_api_key');
            if (savedKey) document.getElementById('rp-api-key').value = savedKey;

            rpShowCategoryPicker();
        }

        function rpShowCategoryPicker() {
            document.getElementById('rp-step-category').style.display = '';
            document.getElementById('rp-step-scenario').style.display = 'none';
            document.getElementById('rp-step-chat').style.display = 'none';
        }

        function rpShowCategory(catKey) {
            rpCurrentCategory = catKey;
            const cat = RP_SCENARIOS[catKey];
            const listDiv = document.getElementById('rp-scenario-list');
            let html = '';
            if (cat.groups) {
                cat.groups.forEach(group => {
                    html += `<div class="rp-group-title">${group.title}</div>`;
                    group.items.forEach(item => {
                        html += `<button class="rp-scenario-btn" onclick="rpStartScenario('${catKey}','${item.id}')">${item.label}</button>`;
                    });
                });
            } else {
                cat.items.forEach(item => {
                    html += `<button class="rp-scenario-btn" onclick="rpStartScenario('${catKey}','${item.id}')">${item.label}</button>`;
                });
            }
            listDiv.innerHTML = html;

            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = '';
            document.getElementById('rp-step-chat').style.display = 'none';
        }

        function rpShowScenarioPicker() {
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            if (rpCurrentCategory) {
                rpShowCategory(rpCurrentCategory);
            } else {
                rpShowCategoryPicker();
            }
        }

        function rpStartScenario(catKey, itemId) {
            const scenario = rpFindScenario(catKey, itemId);
            if (!scenario) return;
            rpCurrentScenario = scenario;
            rpConversationHistory = [{ role: "model", parts: [{ text: scenario.prompt }] }];

            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = 'none';
            document.getElementById('rp-step-chat').style.display = 'flex';

            document.getElementById('rp-chat-history').innerHTML = '';
            rpAppendMessage(scenario.welcome, 'assistant');
            rpSpeakText(scenario.welcome);
            document.getElementById('rp-status').innerText = "Prêt";
        }

        rpInitSpeechRecognition();
        rpCheckDutchVoice();
        init();
