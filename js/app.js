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
// Par défaut sur "Créer un compte" : la plupart des gens qui ouvrent cet écran n'ont encore
// aucun compte NL Mastery (progression purement locale jusque-là) — les accueillir sur un
// formulaire de connexion était un cul-de-sac. Un utilisateur qui a déjà un compte n'a qu'un
// clic à faire sur l'onglet "Connexion", clairement visible juste à côté.
let accMode = 'signup'; // 'login' | 'signup'
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
    accExplicitAuthInProgress = true;
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
        const rev = syncNewRev();
        const userDoc = {
            pseudo, pseudoLower,
            recoveryEmail: email || null,
            role: 'user',
            disabled: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
            progress: syncClone(state),
            progressRev: rev,
            progressEpoch: 0
        };
        await db.collection('users').doc(uid).set(userDoc);
        currentUser = cred.user;
        currentUserDoc = userDoc;
        // La progression faite sans compte sur cet appareil devient celle du nouveau compte.
        syncMetaReplace({ uid, rev, epoch: 0, dirty: false });
        cloudSetStatus('ok');
        await socialEnsureProfileDocs();
        accShowLoggedIn();
    } catch (e) {
        accSetError(accFriendlyError(e));
    } finally {
        accExplicitAuthInProgress = false;
    }
}

async function accLogin(pseudo, password) {
    const authEmail = accEmailFromPseudo(pseudo);
    accExplicitAuthInProgress = true;
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
        // Réconcilie la progression de l'appareil avec celle du compte (adoption, fusion ou
        // envoi selon le cas — voir cloudReconcile). Si la page se recharge, rien d'autre à faire.
        cloudLastCheckAt = Date.now();
        const reloading = await cloudReconcile(userDoc, true);
        if (reloading) return;
        accShowLoggedIn();
        socialEnsureProfileDocs();
        notificationsRefreshBadge();
    } catch (e) {
        accSetError(accFriendlyError(e));
    } finally {
        accExplicitAuthInProgress = false;
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

async function accLogout() {
    // Dernier envoi avant de partir : la progression locale est effacée juste après.
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
    if (syncMetaGet().dirty) {
        await cloudPush();
        if (syncMetaGet().dirty && !confirm(
            "Ta progression récente n'a pas pu être envoyée au cloud (pas de connexion ?).\n\n" +
            "Si tu te déconnectes maintenant, elle sera perdue sur cet appareil. Se déconnecter quand même ?"
        )) return;
    }
    await auth.signOut();
    currentUser = null;
    currentUserDoc = null;
    // La progression appartient au compte, pas à l'appareil : on la retire pour que le prochain
    // utilisateur du même appareil (compte partagé, ordinateur familial) n'en hérite pas, ni du
    // cache social (amis, notifications). Le rechargement remet tous les écrans à zéro.
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(SYNC_META_KEY);
    location.reload();
}

function accShowLoggedIn() {
    document.getElementById('acc-logged-out').style.display = 'none';
    document.getElementById('acc-logged-in').style.display = 'block';
    document.getElementById('acc-current-pseudo').innerText = '👤 ' + currentUserDoc.pseudo;
    document.getElementById('acc-admin-entry').style.display = currentUserDoc.role === 'admin' ? 'grid' : 'none';
    cloudSetStatus(cloudSyncStatus);
}

function accShowLoggedOut() {
    document.getElementById('acc-logged-out').style.display = 'block';
    document.getElementById('acc-logged-in').style.display = 'none';
    document.getElementById('acc-pseudo').value = '';
    document.getElementById('acc-password').value = '';
}

// ===== Synchro cloud bidirectionnelle =====
// Avant : l'app ne faisait qu'ENVOYER la progression (et ne relisait le cloud qu'à la saisie du
// mot de passe). Un deuxième appareil resté connecté écrasait donc le cloud avec sa vieille
// copie à sa première réponse. Maintenant chaque appareil retient la dernière révision du cloud
// qu'il connaît (progressRev) et sait s'il a des changements non envoyés (dirty) :
//   - cloud inchangé                  -> on envoie simplement la progression locale
//   - cloud changé, rien en local     -> on adopte la version du cloud
//   - les deux ont changé             -> on fusionne (mergeProgress), puis on envoie
//   - progressEpoch différent         -> remise à zéro/import/effacement admin faits ailleurs :
//                                        le cloud gagne, sans fusion
const STATE_KEY = 'nl_platform_v1';
const SYNC_META_KEY = 'nl_sync_meta_v1';            // { uid, rev, epoch, dirty }
const SYNC_BACKUP_FIRST_KEY = 'nl_platform_v1_backup_premiere_synchro';
const SYNC_BACKUP_LAST_KEY = 'nl_platform_v1_backup_derniere_synchro';
const SYNC_STATUS_LABELS = {
    ok: 'Synchronisé',
    syncing: 'Synchronisation...',
    offline: 'Hors ligne — envoi dès le retour de la connexion',
    error: 'Échec de la synchro — nouvel essai dans 30 s'
};
let cloudSyncStatus = 'ok';
let cloudPushPromise = null;
let cloudRetryTimer = null;
let cloudLastCheckAt = 0;
let localChangeCounter = 0;      // incrémenté à chaque save(), pour repérer un changement pendant un envoi
let accExplicitAuthInProgress = false; // connexion/inscription en cours : onAuthStateChanged ne doit pas s'en mêler

function syncMetaGet() {
    try { return JSON.parse(localStorage.getItem(SYNC_META_KEY)) || {}; } catch (e) { return {}; }
}
function syncMetaReplace(meta) { localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta)); }
function syncMetaPatch(patch) { syncMetaReplace(Object.assign(syncMetaGet(), patch)); }
function syncNewRev() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function syncClone(o) { return JSON.parse(JSON.stringify(o)); } // retire aussi les undefined, refusés par Firestore
function syncHasProgress(p) { return !!p && typeof p === 'object' && Object.keys(p).length > 0; }

// Appelée par save() : note qu'il y a du nouveau à envoyer, même si la session Firebase n'est
// pas encore reprise (les premières secondes après l'ouverture de la page).
function syncMarkDirty() {
    localChangeCounter++;
    const meta = syncMetaGet();
    if (meta.uid && !meta.dirty) syncMetaPatch({ dirty: true });
}

function cloudSetStatus(status) {
    cloudSyncStatus = status;
    const el = document.getElementById('acc-sync-status');
    if (el) el.innerText = SYNC_STATUS_LABELS[status] || '';
}

// Copie de sécurité de la progression locale avant toute fusion/adoption : la toute première est
// conservée telle quelle, la dernière est remplacée à chaque fois.
function syncBackupLocal() {
    try {
        const raw = localStorage.getItem(STATE_KEY);
        if (!raw) return;
        const backup = JSON.stringify({ date: new Date().toISOString(), data: raw });
        if (!localStorage.getItem(SYNC_BACKUP_FIRST_KEY)) localStorage.setItem(SYNC_BACKUP_FIRST_KEY, backup);
        localStorage.setItem(SYNC_BACKUP_LAST_KEY, backup);
    } catch (e) { console.warn('Sauvegarde locale avant synchro impossible :', e); }
}

// Secours manuel (console du navigateur) : restoreSyncBackup() remet la dernière copie de
// sécurité, restoreSyncBackup(true) la toute première. L'état restauré repart ensuite dans le
// cloud comme une progression normale.
function restoreSyncBackup(first) {
    const raw = localStorage.getItem(first ? SYNC_BACKUP_FIRST_KEY : SYNC_BACKUP_LAST_KEY);
    if (!raw) { console.warn('Aucune copie de sécurité.'); return; }
    localStorage.setItem(STATE_KEY, JSON.parse(raw).data);
    if (syncMetaGet().uid) syncMetaPatch({ dirty: true });
    location.reload();
}

function syncStableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(syncStableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + syncStableStringify(v[k])).join(',') + '}';
}

function syncDayDiff(later, earlier) {
    return Math.round((new Date(later) - new Date(earlier)) / 86400000);
}

// Fusionne deux progressions en gardant le meilleur des deux côtés : compteurs = le plus grand,
// "maîtrisé" d'un côté = maîtrisé, listes = union. Les réglages (sens, thème, mode libre) restent
// ceux de l'appareil courant.
function mergeProgress(local, remote) {
    const L = syncClone(local || {}), R = syncClone(remote || {});
    const out = syncMergeValue(L, R, '');
    // Streak : dépend de la date du dernier jour actif, pas un simple maximum.
    const ls = L.stats || {}, rs = R.stats || {};
    if (out.stats && ls.lastActiveDay && rs.lastActiveDay) {
        const [late, early] = ls.lastActiveDay >= rs.lastActiveDay ? [ls, rs] : [rs, ls];
        const diff = syncDayDiff(late.lastActiveDay, early.lastActiveDay);
        let streak = late.dailyStreak || 0;
        if (diff === 0) streak = Math.max(streak, early.dailyStreak || 0);
        else if (diff === 1) streak = Math.max(streak, (early.dailyStreak || 0) + 1);
        out.stats.lastActiveDay = late.lastActiveDay;
        out.stats.dailyStreak = streak;
    }
    return out;
}

function syncMergeValue(a, b, path) {
    if (a === undefined || a === null) return (b === undefined) ? a : b;
    if (b === undefined || b === null) return a;
    if (path === 'settings') return Object.assign({}, b, a);
    if (path === 'freeAccess') return a;
    if (path === 'memoryHighScore') {
        return (b.moves < a.moves || (b.moves === a.moves && b.timeSec < a.timeSec)) ? b : a;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        const seen = new Set(), res = [];
        a.concat(b).forEach(item => {
            const key = syncStableStringify(item);
            if (!seen.has(key)) { seen.add(key); res.push(item); }
        });
        if (res.length && res.every(x => x && typeof x === 'object' && typeof x.timestamp === 'number')) {
            res.sort((x, y) => x.timestamp - y.timestamp);
        }
        return res;
    }
    const isObj = v => typeof v === 'object' && !Array.isArray(v);
    if (isObj(a) && isObj(b)) {
        // Une notion : attempts/correct/lastResult vont ensemble, on garde l'entrée la plus
        // avancée en bloc plutôt que de mélanger les champs des deux appareils.
        if (path.indexOf('curriculum.notionProgress.') === 0) {
            const aa = a.attempts || 0, ba = b.attempts || 0;
            const pick = (ba > aa || (ba === aa && (b.lastAttemptAt || 0) > (a.lastAttemptAt || 0))) ? b : a;
            return Object.assign({}, pick, { opened: !!(a.opened || b.opened) });
        }
        // Une forme conjuguée : ok/ko/streak vont ensemble, on garde la réponse la plus récente.
        if (path.indexOf('conjStats.') === 0) return (b.last || 0) > (a.last || 0) ? b : a;
        const res = {};
        Object.keys(a).concat(Object.keys(b)).forEach(k => {
            if (k in res) return;
            const v = syncMergeValue(a[k], b[k], path ? path + '.' + k : k);
            if (v !== undefined) res[k] = v;
        });
        return res;
    }
    if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
    if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
    return a;
}

function syncLocalIsMeaningful() {
    const s = state || {};
    return (s.xp || 0) > 0 || (s.mastered || []).length > 0 ||
        Object.keys((s.stats && s.stats.wordSeen) || {}).length > 0 ||
        Object.keys((s.curriculum && s.curriculum.notionProgress) || {}).length > 0;
}

// Remplace la progression locale par celle du cloud puis recharge la page (les migrations de
// `state` et tous les écrans repartent ainsi d'un état propre).
function cloudAdoptRemote(userDoc) {
    syncBackupLocal();
    const remote = syncHasProgress(userDoc.progress) ? userDoc.progress : { xp: 0, mastered: [] };
    localStorage.setItem(STATE_KEY, JSON.stringify(remote));
    syncMetaReplace({ uid: currentUser.uid, rev: userDoc.progressRev || null, epoch: userDoc.progressEpoch || 0, dirty: false });
    location.reload();
}

// Fusionne le cloud dans la progression en cours SANS recharger (on peut être en plein exercice).
function cloudMergeRemoteInPlace(userDoc) {
    syncBackupLocal();
    state = mergeProgress(state, userDoc.progress);
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    syncMetaReplace({ uid: currentUser.uid, rev: userDoc.progressRev || null, epoch: userDoc.progressEpoch || 0, dirty: true });
    syncRefreshUi();
}

function syncRefreshUi() {
    try {
        updateStats();
        if (document.getElementById('home-view').classList.contains('active')) renderDashboard();
    } catch (e) { console.warn('Rafraîchissement après synchro :', e); }
}

// Compare la progression locale au document cloud et applique la bonne action.
// `askBeforeMerging` : vrai lors d'une connexion manuelle, où la progression présente sur
// l'appareil n'appartient pas forcément à ce compte. Retourne true si la page va se recharger.
async function cloudReconcile(userDoc, askBeforeMerging) {
    const meta = syncMetaGet();
    const remoteHas = syncHasProgress(userDoc.progress);
    const remoteRev = userDoc.progressRev || null;
    const remoteEpoch = userDoc.progressEpoch || 0;

    if (meta.uid !== currentUser.uid) {
        // Premier rattachement de cet appareil à ce compte.
        const localHas = syncLocalIsMeaningful();
        if (remoteHas && !localHas) { cloudAdoptRemote(userDoc); return true; }
        if (remoteHas && localHas) {
            const keepLocal = !askBeforeMerging || confirm(
                "Cet appareil contient déjà une progression (" + (state.xp || 0) + " XP).\n\n" +
                "OK : l'ajouter à ton compte (fusion avec la progression du compte).\n" +
                "Annuler : l'ignorer et garder uniquement la progression du compte."
            );
            if (!keepLocal) { cloudAdoptRemote(userDoc); return true; }
            cloudMergeRemoteInPlace(userDoc);
        } else {
            syncMetaReplace({ uid: currentUser.uid, rev: remoteRev, epoch: remoteEpoch, dirty: true });
        }
        await cloudPush();
        return false;
    }
    if (remoteEpoch !== (meta.epoch || 0)) { cloudAdoptRemote(userDoc); return true; }
    if (remoteRev === (meta.rev || null)) {
        if (meta.dirty) await cloudPush(); else cloudSetStatus('ok');
        return false;
    }
    if (!meta.dirty) { cloudAdoptRemote(userDoc); return true; }
    if (remoteHas) cloudMergeRemoteInPlace(userDoc);
    await cloudPush();
    return false;
}

// Relit le document cloud (ouverture de l'app, retour sur l'onglet) et réconcilie.
async function cloudCheck() {
    if (!firebaseAvailable || !currentUser) return false;
    cloudLastCheckAt = Date.now();
    try {
        const snap = await db.collection('users').doc(currentUser.uid).get();
        if (!snap.exists) return false;
        const userDoc = snap.data();
        if (userDoc.disabled) { await auth.signOut(); currentUser = null; currentUserDoc = null; return false; }
        currentUserDoc = userDoc;
        return await cloudReconcile(userDoc, false);
    } catch (e) {
        cloudSyncFailed(e);
        return false;
    }
}

function cloudSyncFailed(e) {
    const offline = navigator.onLine === false || (e && (e.code === 'unavailable' || /offline/i.test(e.message || '')));
    cloudSetStatus(offline ? 'offline' : 'error');
    if (!offline) console.error('Synchro cloud échouée', e);
    clearTimeout(cloudRetryTimer);
    cloudRetryTimer = setTimeout(() => { if (syncMetaGet().dirty) cloudPush(); }, 30000);
}

// Envoie la progression locale. La transaction relit d'abord le document : si un autre appareil
// a écrit entre-temps, on fusionne au lieu d'écraser ; si une remise à zéro a eu lieu ailleurs,
// on n'envoie rien et on adopte le cloud.
function cloudPush() {
    if (!firebaseAvailable || !currentUser) return Promise.resolve();
    if (cloudPushPromise) return cloudPushPromise.then(() => (syncMetaGet().dirty ? cloudPush() : undefined));
    cloudPushPromise = cloudPushOnce().finally(() => { cloudPushPromise = null; });
    return cloudPushPromise;
}

async function cloudPushOnce() {
    const uid = currentUser.uid;
    const ref = db.collection('users').doc(uid);
    const meta = syncMetaGet();
    const newRev = syncNewRev();
    const counterAtStart = localChangeCounter;
    let outcome, remoteDoc, merged;
    clearTimeout(cloudRetryTimer);
    cloudSetStatus('syncing');
    try {
        await db.runTransaction(async (tx) => {
            outcome = 'pushed'; remoteDoc = null; merged = null;
            const snap = await tx.get(ref);
            if (!snap.exists) throw new Error('Document utilisateur introuvable');
            const d = snap.data();
            if (d.disabled) { outcome = 'disabled'; return; }
            if ((d.progressEpoch || 0) !== (meta.epoch || 0)) { outcome = 'adopt'; remoteDoc = d; return; }
            let toWrite = syncClone(state);
            if ((d.progressRev || null) !== (meta.rev || null) && syncHasProgress(d.progress)) {
                merged = mergeProgress(state, d.progress);
                toWrite = merged;
                outcome = 'merged';
            }
            tx.update(ref, {
                progress: toWrite,
                progressRev: newRev,
                progressEpoch: meta.epoch || 0,
                lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });
    } catch (e) {
        cloudSyncFailed(e);
        return;
    }
    if (!currentUser || currentUser.uid !== uid) return; // déconnexion pendant l'envoi
    if (outcome === 'disabled') { await auth.signOut(); currentUser = null; currentUserDoc = null; return; }
    if (outcome === 'adopt') { cloudAdoptRemote(remoteDoc); return; }
    if (outcome === 'merged') {
        syncBackupLocal();
        // Re-fusion avec l'état courant : une réponse a pu être enregistrée pendant l'envoi.
        state = mergeProgress(state, merged);
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        syncRefreshUi();
    }
    const stillDirty = localChangeCounter !== counterAtStart;
    syncMetaReplace({ uid, rev: newRev, epoch: meta.epoch || 0, dirty: stillDirty });
    cloudSetStatus('ok');
    if (stillDirty) scheduleCloudSync();
}

// Remplace la progression du compte SANS fusion (remise à zéro, import d'une sauvegarde) :
// progressEpoch change, donc les autres appareils adopteront cette version au lieu de la
// fusionner avec la leur. Retourne false si le cloud n'a pas pu être joint.
async function cloudOverwrite(newProgress) {
    if (navigator.onLine === false) return false;
    const rev = syncNewRev(), epoch = Date.now();
    try {
        const write = db.collection('users').doc(currentUser.uid).update({
            progress: syncClone(newProgress), progressRev: rev, progressEpoch: epoch,
            lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        // Hors ligne, l'écriture Firestore reste en attente sans jamais échouer : on borne l'attente.
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('délai dépassé')), 10000));
        await Promise.race([write, timeout]);
    } catch (e) {
        console.error('Remplacement de la progression cloud échoué', e);
        return false;
    }
    clearTimeout(cloudSyncTimer);
    localStorage.setItem(STATE_KEY, JSON.stringify(newProgress));
    syncMetaReplace({ uid: currentUser.uid, rev, epoch, dirty: false });
    return true;
}

// Appelée à chaque save() local, avec un léger anti-rebond
function scheduleCloudSync(immediate) {
    if (!firebaseAvailable || !currentUser) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
    if (immediate) cloudPush();
    else cloudSyncTimer = setTimeout(() => { cloudSyncTimer = null; cloudPush(); }, 1500);
}

window.addEventListener('online', () => { if (currentUser && syncMetaGet().dirty) cloudPush(); });
document.addEventListener('visibilitychange', () => {
    if (!firebaseAvailable || !currentUser) return;
    if (document.visibilityState === 'hidden') {
        // On quitte l'onglet/l'app (cas typique sur mobile) : on n'attend pas l'anti-rebond.
        if (cloudSyncTimer) scheduleCloudSync(true);
    } else if (Date.now() - cloudLastCheckAt > 30000) {
        cloudCheck();
    }
});

function showCompte() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('compte-view').classList.add('active');
    setActiveNav('nav-profil');
    accSwitchTab(accMode);
    if (currentUser) accShowLoggedIn(); else accShowLoggedOut();
    if (!firebaseAvailable) accSetError("Service de comptes indisponible pour le moment (connexion impossible). Ta progression locale reste intacte.");
}

// ===== Couche sociale (MVP) =====
// Ne remplace ni ne duplique le compte Firebase existant : `users/{uid}` reste la SEULE source de
// vérité pour la progression pédagogique (auth, login, logout, sauvegarde, sync — tout est inchangé
// ci-dessus). Le social vit dans des collections séparées, pensées pour ne jamais pouvoir écraser ou
// lire la progression d'un autre utilisateur :
//   usernames/{pseudoLower}   { uid, discoverable }        — existe déjà, on ajoute juste `discoverable`
//   publicProfiles/{uid}      { uid, pseudo, pseudoLower, createdAt }               — identité publique minimale
//   friendStats/{uid}         { privacy:{...}, stats:{...}, updatedAt }            — sous-ensemble partageable, écrit par le propriétaire
//   friendRequests/{pairId}   { fromUid, toUid, fromPseudo, toPseudo, status, createdAt, respondedAt }
//   friendships/{pairId}      { uids:[a,b], status:'accepted'|'blocked', blockedBy, createdAt }
//   notifications/{id}        { recipientUid, senderUid, senderPseudo, type, title, message, data, read, createdAt }
// pairId = les deux uid triés alphabétiquement et joints par "_" : une seule relation possible par
// paire (jamais de doublon friendRequests+friendships pour les mêmes deux personnes).
//
// Confidentialité : `friendStats/{uid}.stats` ne contient QUE les champs que l'utilisateur a choisi
// de partager (voir socialComputeShareableStats) — la restriction se fait à l'ÉCRITURE (le
// propriétaire ne publie jamais un champ désactivé), pas en essayant de filtrer à la lecture, ce qui
// serait impossible à garantir avec Firestore seul. Un ami qui peut lire ce document ne voit donc
// jamais plus que ce que le propriétaire a explicitement autorisé.

function socialPairId(a, b) { return [a, b].sort().join('_'); }

// Calcule uniquement les statistiques que l'utilisateur autorise à partager (voir doc ci-dessus).
function socialComputeShareableStats(privacy) {
    const stats = {};
    if (privacy.shareLevel) stats.level = curriculumLoaded ? getCurriculumLevel().level : null;
    if (privacy.shareProgress) {
        stats.masteredCount = curriculumLoaded
            ? Object.keys(curriculumNotions).filter(id => curriculumNotions[id].status === 'pret' && getNotionStatus(id) === 'maitrisee').length
            : 0;
        stats.xp = state.xp || 0;
    }
    if (privacy.shareVocab) stats.vocabPct = getVocabProgress().pct;
    if (privacy.shareStreak) stats.streak = (state.stats && state.stats.dailyStreak) || 0;
    return stats;
}

const SOCIAL_DEFAULT_PRIVACY = { shareLevel: true, shareProgress: true, shareVocab: true, shareStreak: true };

// Crée (ou complète, sans écraser) les documents sociaux d'un compte — appelé après signup ET à
// chaque reprise de session, pour que les comptes créés avant cette fonctionnalité soient
// automatiquement mis à niveau (merge:true partout, donc idempotent et sans risque).
async function socialEnsureProfileDocs() {
    if (!firebaseAvailable || !currentUser || !currentUserDoc) return;
    try {
        const uid = currentUser.uid;
        const batch = db.batch();
        batch.set(db.collection('publicProfiles').doc(uid), {
            uid, pseudo: currentUserDoc.pseudo, pseudoLower: currentUserDoc.pseudoLower,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        batch.set(db.collection('friendStats').doc(uid), {
            privacy: SOCIAL_DEFAULT_PRIVACY,
            stats: socialComputeShareableStats(SOCIAL_DEFAULT_PRIVACY),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        batch.set(db.collection('usernames').doc(currentUserDoc.pseudoLower), { discoverable: true }, { merge: true });
        await batch.commit();
    } catch (e) {
        console.warn('socialEnsureProfileDocs a échoué (non bloquant) :', e);
    }
}

// Resynchronise friendStats après chaque save() local, avec le même anti-rebond que scheduleCloudSync
// mais un timer séparé (les deux écritures sont indépendantes). Respecte toujours les préférences de
// confidentialité déjà enregistrées : on les relit avant de recalculer, jamais un `set` qui les
// écraserait par des valeurs par défaut.
let friendStatsSyncTimer = null;
function scheduleFriendStatsSync() {
    if (!firebaseAvailable || !currentUser) return;
    clearTimeout(friendStatsSyncTimer);
    friendStatsSyncTimer = setTimeout(async () => {
        try {
            const ref = db.collection('friendStats').doc(currentUser.uid);
            const snap = await ref.get();
            const privacy = (snap.exists && snap.data().privacy) || SOCIAL_DEFAULT_PRIVACY;
            await ref.set({
                privacy, stats: socialComputeShareableStats(privacy),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (e) { console.warn('Synchro friendStats échouée', e); }
    }, 2000);
}

// ===== Paramètres de confidentialité =====
async function privacySetFlag(flagName, value) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        const ref = db.collection('friendStats').doc(currentUser.uid);
        const snap = await ref.get();
        const privacy = (snap.exists && snap.data().privacy) || Object.assign({}, SOCIAL_DEFAULT_PRIVACY);
        privacy[flagName] = value;
        await ref.set({ privacy, stats: socialComputeShareableStats(privacy), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        renderPrivacySettings();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function privacySetDiscoverable(value) {
    if (!firebaseAvailable || !currentUser || !currentUserDoc) return;
    try {
        await db.collection('usernames').doc(currentUserDoc.pseudoLower).set({ discoverable: value }, { merge: true });
        renderPrivacySettings();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function renderPrivacySettings() {
    const el = document.getElementById('social-privacy-content');
    if (!el) return;
    if (!firebaseAvailable || !currentUser) {
        el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Connecte-toi pour gérer tes paramètres de confidentialité.</p><button class="btn btn-green" style="margin-top:0;" onclick="showCompte()">Se connecter / créer un compte</button>`;
        return;
    }
    el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement...</p>`;
    try {
        const [unameSnap, statsSnap] = await Promise.all([
            db.collection('usernames').doc(currentUserDoc.pseudoLower).get(),
            db.collection('friendStats').doc(currentUser.uid).get()
        ]);
        const discoverable = unameSnap.exists ? unameSnap.data().discoverable !== false : true;
        const privacy = (statsSnap.exists && statsSnap.data().privacy) || SOCIAL_DEFAULT_PRIVACY;
        const toggles = [
            ['shareLevel', 'Niveau CECR'], ['shareProgress', 'Progression (XP, notions maîtrisées)'],
            ['shareVocab', 'Vocabulaire'], ['shareStreak', 'Activité / streak']
        ];
        el.innerHTML = `
            <div class="profil-menu-row" style="cursor:pointer;" onclick="privacySetDiscoverable(${!discoverable})">
                <span class="pm-icon">🔍</span><span>Qui peut me trouver : <strong>${discoverable ? 'Tout le monde' : 'Personne'}</strong></span><span class="pm-chevron">›</span>
            </div>
            <div class="section-title" style="margin-top:var(--space-3);">Que peuvent voir mes amis ?</div>
            ${toggles.map(([key, label]) => `
                <div class="profil-menu-row" style="cursor:pointer;" onclick="privacySetFlag('${key}', ${!privacy[key]})">
                    <span class="pm-icon">${privacy[key] ? '✅' : '⬜'}</span><span>${label}</span>
                </div>`).join('')}
            <p style="font-size:0.75rem; color:var(--text-secondary); margin-top:10px;">Par défaut, ces informations restent visibles uniquement par tes amis acceptés — jamais publiquement.</p>`;
    } catch (e) {
        el.innerHTML = `<p style="font-size:0.85rem; color:var(--wrong);">Erreur de chargement : ${e.message}</p>`;
    }
}

// ===== Notifications =====
async function notificationCreate(recipientUid, type, title, message, data) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        await db.collection('notifications').add({
            recipientUid, senderUid: currentUser.uid, senderPseudo: (currentUserDoc && currentUserDoc.pseudo) || '',
            type, title, message: message || '', data: data || {}, read: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { console.warn('notificationCreate a échoué :', e); }
}

let notificationsCache = [];
async function notificationsRefreshBadge() {
    const badge = document.getElementById('notif-badge');
    if (!firebaseAvailable || !currentUser) { if (badge) badge.style.display = 'none'; return; }
    try {
        const snap = await db.collection('notifications').where('recipientUid', '==', currentUser.uid).limit(50).get();
        notificationsCache = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        notificationsCache.sort((a, b) => (b.createdAt ? b.createdAt.toMillis() : 0) - (a.createdAt ? a.createdAt.toMillis() : 0));
        const unread = notificationsCache.filter(n => !n.read).length;
        if (badge) { badge.style.display = unread > 0 ? 'flex' : 'none'; badge.innerText = unread > 9 ? '9+' : String(unread); }
    } catch (e) { console.warn('Notifications non chargées :', e); }
}

function showNotifications() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('notifications-view').classList.add('active');
    renderNotifications();
}

const NOTIFICATION_ICONS = { friend_request: '👥', friend_accept: '👥', encouragement: '👏', challenge: '⚔️', challenge_completed: '🏆', session: '📅' };

async function renderNotifications() {
    const el = document.getElementById('notifications-list');
    if (!el) return;
    if (!firebaseAvailable || !currentUser) {
        el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Connecte-toi pour voir tes notifications.</p><button class="btn btn-green" style="margin-top:0;" onclick="showCompte()">Se connecter / créer un compte</button>`;
        return;
    }
    el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement...</p>`;
    await notificationsRefreshBadge();
    if (!notificationsCache.length) {
        el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucune notification pour l'instant.</p>`;
        return;
    }
    el.innerHTML = notificationsCache.map(n => {
        const icon = NOTIFICATION_ICONS[n.type] || '🔔';
        const dateStr = n.createdAt ? new Date(n.createdAt.toMillis()).toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        return `<div class="hub-card" style="cursor:pointer; ${n.read ? 'opacity:0.6;' : ''}" onclick="notificationOpen('${n.id}')">
            <div class="hub-card-title">${icon} ${n.title}</div>
            ${n.message ? `<div class="hub-card-desc">${n.message}</div>` : ''}
            <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px;">${dateStr}</div>
        </div>`;
    }).join('');
}

async function notificationOpen(id) {
    const n = notificationsCache.find(x => x.id === id);
    if (!n) return;
    if (!n.read) {
        try { await db.collection('notifications').doc(id).update({ read: true }); n.read = true; } catch (e) { /* non bloquant */ }
    }
    if (n.type === 'friend_request' || n.type === 'friend_accept') { showSocial(); socialShowTab(n.type === 'friend_request' ? 'requests' : 'friends'); }
    else if (n.type === 'challenge' || n.type === 'challenge_completed') { showSocial(); socialShowTab('challenges'); }
    else if (n.type === 'session') { showSocial(); socialShowTab('sessions'); }
    else renderNotifications();
}

// ===== Recherche + relation (amis / demandes / blocage) =====
async function socialGetRelationStatus(targetUid) {
    const pairId = socialPairId(currentUser.uid, targetUid);
    const [friendSnap, reqSnap] = await Promise.all([
        db.collection('friendships').doc(pairId).get(),
        db.collection('friendRequests').doc(pairId).get()
    ]);
    if (friendSnap.exists) {
        const f = friendSnap.data();
        if (f.status === 'blocked') return f.blockedBy === currentUser.uid ? 'blocked_by_me' : 'blocked_by_them';
        if (f.status === 'accepted') return 'friends';
    }
    if (reqSnap.exists && reqSnap.data().status === 'pending') {
        return reqSnap.data().fromUid === currentUser.uid ? 'request_sent' : 'request_received';
    }
    return 'none';
}

function socialRenderUserCard(uid, pseudo, relation) {
    const pairId = socialPairId(currentUser.uid, uid);
    const safePseudo = pseudo.replace(/'/g, "\\'");
    let actionHtml;
    if (relation === 'friends') actionHtml = `<span style="color:var(--success); font-weight:700;">✓ Déjà amis</span>`;
    else if (relation === 'request_sent') actionHtml = `<span style="color:var(--text-secondary);">Demande envoyée</span>`;
    else if (relation === 'request_received') actionHtml = `<button class="btn btn-green" style="margin:0;" onclick="friendRequestAccept('${pairId}')">Accepter sa demande</button>`;
    else if (relation === 'blocked_by_me') actionHtml = `<span style="color:var(--wrong);">Bloqué par toi — <a href="#" onclick="friendUnblock('${uid}'); return false;">débloquer</a></span>`;
    else if (relation === 'blocked_by_them') actionHtml = `<span style="color:var(--text-secondary);">Utilisateur indisponible</span>`;
    else actionHtml = `<button class="btn btn-green" style="margin:0;" onclick="friendRequestSend('${uid}', '${safePseudo}')">➕ Ajouter en ami</button>`;
    return `<div class="hub-card" style="cursor:default;">
        <div class="hub-card-title">@${pseudo}</div>
        <div style="margin-top:8px;">${actionHtml}</div>
    </div>`;
}

async function socialSearch() {
    const input = document.getElementById('social-search-input');
    const resultEl = document.getElementById('social-search-result');
    if (!input || !resultEl) return;
    if (!firebaseAvailable || !currentUser) { resultEl.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Connecte-toi pour rechercher des amis.</p><button class="btn btn-green" style="margin-top:0;" onclick="showCompte()">Se connecter / créer un compte</button>`; return; }
    const raw = input.value.trim();
    if (!raw) { resultEl.innerHTML = ''; return; }
    resultEl.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Recherche...</p>`;
    const pseudoLower = raw.replace(/^@/, '').trim().toLowerCase();
    try {
        const unameSnap = await db.collection('usernames').doc(pseudoLower).get();
        if (!unameSnap.exists || unameSnap.data().discoverable === false) {
            resultEl.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucun utilisateur trouvé avec ce pseudo (ou il a choisi de ne pas être trouvable).</p>`;
            return;
        }
        const targetUid = unameSnap.data().uid;
        if (targetUid === currentUser.uid) {
            resultEl.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">C'est ton propre pseudo 🙂</p>`;
            return;
        }
        const profSnap = await db.collection('publicProfiles').doc(targetUid).get();
        const pseudo = profSnap.exists ? profSnap.data().pseudo : raw;
        const relation = await socialGetRelationStatus(targetUid);
        resultEl.innerHTML = socialRenderUserCard(targetUid, pseudo, relation);
    } catch (e) {
        resultEl.innerHTML = `<p style="font-size:0.85rem; color:var(--wrong);">Erreur de recherche : ${e.message}</p>`;
    }
}

async function friendRequestSend(toUid, toPseudo) {
    if (!firebaseAvailable || !currentUser) return;
    const pairId = socialPairId(currentUser.uid, toUid);
    try {
        const [friendSnap, reqSnap] = await Promise.all([
            db.collection('friendships').doc(pairId).get(),
            db.collection('friendRequests').doc(pairId).get()
        ]);
        if (friendSnap.exists && friendSnap.data().status === 'blocked') { alert("Impossible d'envoyer une demande à cet utilisateur."); return; }
        if (friendSnap.exists && friendSnap.data().status === 'accepted') { alert('Vous êtes déjà amis.'); return; }
        if (reqSnap.exists && reqSnap.data().status === 'pending' && reqSnap.data().fromUid !== currentUser.uid) {
            // L'autre personne nous a déjà envoyé une demande : accepter directement plutôt que
            // de créer une deuxième relation ("ne duplique pas inutilement les relations").
            await friendRequestAccept(pairId);
            return;
        }
        await db.collection('friendRequests').doc(pairId).set({
            fromUid: currentUser.uid, toUid, fromPseudo: currentUserDoc.pseudo, toPseudo,
            status: 'pending', createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await notificationCreate(toUid, 'friend_request', `${currentUserDoc.pseudo} veut devenir ton ami`, '', { pairId });
        alert('Demande envoyée !');
        socialSearch();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function friendRequestAccept(pairId) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        const reqRef = db.collection('friendRequests').doc(pairId);
        const reqSnap = await reqRef.get();
        if (!reqSnap.exists) return;
        const req = reqSnap.data();
        if (req.toUid !== currentUser.uid || req.status !== 'pending') return;
        const batch = db.batch();
        batch.update(reqRef, { status: 'accepted', respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
        batch.set(db.collection('friendships').doc(pairId), {
            uids: [req.fromUid, req.toUid].sort(), status: 'accepted', blockedBy: null,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await batch.commit();
        await notificationCreate(req.fromUid, 'friend_accept', `${currentUserDoc.pseudo} a accepté ta demande d'ami`, '', {});
        renderFriendRequests(); renderFriendsList();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function friendRequestDecline(pairId) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        await db.collection('friendRequests').doc(pairId).update({ status: 'declined', respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
        renderFriendRequests();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function friendRemove(pairId) {
    if (!firebaseAvailable || !currentUser) return;
    if (!confirm('Retirer cet ami ?')) return;
    try {
        await db.collection('friendships').doc(pairId).delete();
        renderFriendsList();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function friendBlock(targetUid) {
    if (!firebaseAvailable || !currentUser) return;
    if (!confirm("Bloquer cet utilisateur ? Il ne pourra plus t'envoyer de demandes.")) return;
    const pairId = socialPairId(currentUser.uid, targetUid);
    try {
        await db.collection('friendships').doc(pairId).set({
            uids: [currentUser.uid, targetUid].sort(), status: 'blocked', blockedBy: currentUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        renderFriendsList();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function friendUnblock(targetUid) {
    if (!firebaseAvailable || !currentUser) return;
    const pairId = socialPairId(currentUser.uid, targetUid);
    try {
        const snap = await db.collection('friendships').doc(pairId).get();
        if (snap.exists && snap.data().blockedBy === currentUser.uid) {
            await db.collection('friendships').doc(pairId).delete();
        }
        renderFriendsList(); socialSearch();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function renderFriendsList() {
    const el = document.getElementById('social-friends-list');
    if (!el) return;
    if (!firebaseAvailable || !currentUser) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Connecte-toi pour voir tes amis.</p><button class="btn btn-green" style="margin-top:0;" onclick="showCompte()">Se connecter / créer un compte</button>`; return; }
    el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement...</p>`;
    try {
        const snap = await db.collection('friendships').where('uids', 'array-contains', currentUser.uid).get();
        const accepted = [], blockedByMe = [];
        snap.forEach(doc => {
            const f = doc.data();
            const otherUid = f.uids.find(u => u !== currentUser.uid);
            if (f.status === 'accepted') accepted.push({ pairId: doc.id, otherUid });
            else if (f.status === 'blocked' && f.blockedBy === currentUser.uid) blockedByMe.push({ pairId: doc.id, otherUid });
        });
        if (!accepted.length && !blockedByMe.length) {
            el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Tu n'as pas encore d'amis. Utilise l'onglet "Rechercher" pour en ajouter !</p>`;
            return;
        }
        const rows = await Promise.all(accepted.map(async ({ pairId, otherUid }) => {
            const [profSnap, statsSnap] = await Promise.all([
                db.collection('publicProfiles').doc(otherUid).get(),
                db.collection('friendStats').doc(otherUid).get()
            ]);
            const pseudo = profSnap.exists ? profSnap.data().pseudo : otherUid;
            const stats = statsSnap.exists ? (statsSnap.data().stats || {}) : {};
            const bits = [];
            if (stats.level) bits.push(`Niveau ${stats.level}`);
            if (typeof stats.streak === 'number') bits.push(`🔥 ${stats.streak}j`);
            if (typeof stats.vocabPct === 'number') bits.push(`📖 ${stats.vocabPct}%`);
            const safePseudo = pseudo.replace(/'/g, "\\'");
            return `<div class="hub-card" style="cursor:default;">
                <div class="hub-card-title">@${pseudo}</div>
                <div class="hub-card-desc">${bits.length ? bits.join(' · ') : 'Statistiques non partagées'}</div>
                <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
                    <button class="gemini-explain-btn" onclick="encouragementSend('${otherUid}', '${safePseudo}')">👏 Encourager</button>
                    <button class="gemini-explain-btn" onclick="challengeSend('${otherUid}', '${safePseudo}')">🎯 Défier</button>
                    <button class="gemini-explain-btn" onclick="sessionPropose('${otherUid}', '${safePseudo}')">📅 Session</button>
                    <button class="gemini-explain-btn" onclick="friendRemove('${pairId}')">Retirer</button>
                    <button class="gemini-explain-btn" style="color:var(--wrong); border-color:var(--wrong);" onclick="friendBlock('${otherUid}')">🚫 Bloquer</button>
                </div>
            </div>`;
        }));
        const blockedRows = blockedByMe.map(({ otherUid }) =>
            `<div class="hub-card" style="cursor:default; opacity:0.7;">
                <div class="hub-card-title">Utilisateur bloqué</div>
                <button class="gemini-explain-btn" style="margin-top:8px;" onclick="friendUnblock('${otherUid}')">Débloquer</button>
            </div>`);
        el.innerHTML = rows.join('') + blockedRows.join('');
    } catch (e) {
        el.innerHTML = `<p style="font-size:0.85rem; color:var(--wrong);">Erreur de chargement : ${e.message}</p>`;
    }
}

async function renderFriendRequests() {
    const el = document.getElementById('social-requests-list');
    if (!el) return;
    if (!firebaseAvailable || !currentUser) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Connecte-toi pour voir tes demandes.</p><button class="btn btn-green" style="margin-top:0;" onclick="showCompte()">Se connecter / créer un compte</button>`; return; }
    el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement...</p>`;
    try {
        const snap = await db.collection('friendRequests').where('toUid', '==', currentUser.uid).where('status', '==', 'pending').get();
        if (snap.empty) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucune demande en attente.</p>`; return; }
        el.innerHTML = snap.docs.map(doc => {
            const r = doc.data();
            return `<div class="hub-card" style="cursor:default;">
                <div class="hub-card-title">@${r.fromPseudo}</div>
                <div style="display:flex; gap:8px; margin-top:8px;">
                    <button class="btn btn-green" style="margin:0;" onclick="friendRequestAccept('${doc.id}')">Accepter</button>
                    <button class="gemini-explain-btn" onclick="friendRequestDecline('${doc.id}')">Refuser</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--wrong);">Erreur : ${e.message}</p>`; }
}

// ===== Encouragements (interactions prédéfinies — pas de messagerie libre) =====
const ENCOURAGEMENT_PRESETS = [
    { key: 'bravo', emoji: '👏', text: 'Bien joué !' },
    { key: 'streak', emoji: '🔥', text: 'Continue ton streak !' },
    { key: 'motiv', emoji: '💪', text: 'Tu peux le faire !' },
    { key: 'defi', emoji: '🎯', text: 'Défi accepté !' },
    { key: 'session', emoji: '📚', text: 'Bonne session !' },
    { key: 'continue', emoji: '🚀', text: 'Continue comme ça !' }
];

function encouragementSend(toUid, toPseudo) {
    const box = document.getElementById('social-encouragement-picker');
    if (!box) return;
    const safePseudo = toPseudo.replace(/'/g, "\\'");
    const options = ENCOURAGEMENT_PRESETS.map(p =>
        `<button class="gemini-explain-btn" style="margin:2px;" onclick="encouragementConfirmSend('${toUid}','${p.key}')">${p.emoji} ${p.text}</button>`).join('');
    box.innerHTML = `<div class="section-title" style="margin-top:var(--space-2);">Encourager @${toPseudo}</div><div style="display:flex; flex-wrap:wrap; gap:4px;">${options}</div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function encouragementConfirmSend(toUid, presetKey) {
    const preset = ENCOURAGEMENT_PRESETS.find(p => p.key === presetKey);
    if (!preset) return;
    const box = document.getElementById('social-encouragement-picker');
    try {
        await notificationCreate(toUid, 'encouragement', `${currentUserDoc.pseudo} t'a envoyé un encouragement`, `${preset.emoji} ${preset.text}`, { presetKey });
        if (box) box.innerHTML = `<p style="color:var(--success); font-size:0.85rem;">Encouragement envoyé !</p>`;
    } catch (e) { if (box) box.innerHTML = `<p style="color:var(--wrong); font-size:0.85rem;">Erreur : ${e.message}</p>`; }
}

// ===== Défis (architecture — MVP) =====
// Un défi porte sur UNE notion déjà existante du curriculum (jamais une nouvelle notion ou un
// nouveau système de points) : les deux personnes utilisent exactement le même moteur de maîtrise
// qu'ailleurs dans l'app (getNotionStatus / WeaknessEngine, inchangés). Un défi ne fait QUE lire ce
// statut pour savoir si chacun a rempli sa part — il ne le recalcule jamais lui-même.
// challenges/{id} (id auto — plusieurs défis possibles dans le temps entre les deux mêmes personnes,
// contrairement à friendships/friendRequests qui sont volontairement une relation unique par paire) :
//   { fromUid, toUid, fromPseudo, toPseudo, notionId, titre, status:'pending'|'accepted'|'declined'|
//     'completed'|'cancelled', fromCompleted, toCompleted, createdAt, respondedAt?, completedAt? }
function challengeSend(toUid, toPseudo) {
    const box = document.getElementById('social-challenge-picker');
    if (!box) return;
    if (!curriculumLoaded) { box.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Programme en cours de chargement...</p>`; return; }
    const candidates = [];
    const rec = curriculumLoaded ? getRecommendation() : null;
    if (rec) candidates.push(rec.notionId);
    getWeaknesses().slice(0, 4).forEach(w => { if (!candidates.includes(w.id)) candidates.push(w.id); });
    if (!candidates.length) {
        box.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Rien à proposer pour l'instant — avance un peu dans ta progression d'abord.</p>`;
        return;
    }
    const safePseudo = toPseudo.replace(/'/g, "\\'");
    const options = candidates.map(nid => {
        const notion = curriculumNotions[nid];
        const titre = (notion && notion.content && notion.content.titre) || nid.replace(/_/g, ' ');
        const safeTitre = titre.replace(/'/g, "\\'");
        return `<button class="gemini-explain-btn" style="margin:2px;" onclick="challengeConfirmSend('${toUid}','${safePseudo}','${nid}','${safeTitre}')">🎯 ${titre}</button>`;
    }).join('');
    box.innerHTML = `<div class="section-title" style="margin-top:var(--space-2);">Défier @${toPseudo} sur...</div><div style="display:flex; flex-wrap:wrap; gap:4px;">${options}</div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function challengeConfirmSend(toUid, toPseudo, notionId, titre) {
    if (!firebaseAvailable || !currentUser) return;
    const box = document.getElementById('social-challenge-picker');
    try {
        const ref = await db.collection('challenges').add({
            fromUid: currentUser.uid, toUid, fromPseudo: currentUserDoc.pseudo, toPseudo,
            notionId, titre, status: 'pending', fromCompleted: false, toCompleted: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await notificationCreate(toUid, 'challenge', `${currentUserDoc.pseudo} te défie sur « ${titre} »`, '', { challengeId: ref.id });
        if (box) box.innerHTML = `<p style="color:var(--success); font-size:0.85rem;">Défi envoyé !</p>`;
    } catch (e) { if (box) box.innerHTML = `<p style="color:var(--wrong); font-size:0.85rem;">Erreur : ${e.message}</p>`; }
}

async function challengeRespond(id, newStatus) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        const ref = db.collection('challenges').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return;
        const c = snap.data();
        if (c.toUid !== currentUser.uid || c.status !== 'pending') return;
        await ref.update({ status: newStatus, respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
        if (newStatus === 'accepted') await notificationCreate(c.fromUid, 'challenge', `${currentUserDoc.pseudo} a accepté ton défi sur « ${c.titre} »`, '', { challengeId: id });
        renderChallenges();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function challengeMarkMyPartDone(id) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        const ref = db.collection('challenges').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return;
        const c = snap.data();
        const isFrom = c.fromUid === currentUser.uid;
        const isTo = c.toUid === currentUser.uid;
        if ((!isFrom && !isTo) || c.status !== 'accepted') return;
        // Relit simplement le statut déjà calculé ailleurs dans l'app — aucune nouvelle règle de
        // maîtrise n'est introduite ici.
        if (getNotionStatus(c.notionId) !== 'maitrisee') {
            alert("Tu n'as pas encore maîtrisé cette notion — continue à t'entraîner, puis reviens valider ta part du défi !");
            return;
        }
        const update = isFrom ? { fromCompleted: true } : { toCompleted: true };
        const bothDone = (isFrom ? true : c.fromCompleted) && (isFrom ? c.toCompleted : true);
        if (bothDone) { update.status = 'completed'; update.completedAt = firebase.firestore.FieldValue.serverTimestamp(); }
        await ref.update(update);
        if (update.status === 'completed') {
            await notificationCreate(c.fromUid, 'challenge_completed', `Défi terminé : « ${c.titre} » 🏆`, '', { challengeId: id });
            await notificationCreate(c.toUid, 'challenge_completed', `Défi terminé : « ${c.titre} » 🏆`, '', { challengeId: id });
        }
        renderChallenges();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function challengeCancel(id) {
    if (!firebaseAvailable || !currentUser) return;
    if (!confirm('Annuler ce défi ?')) return;
    try {
        const ref = db.collection('challenges').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return;
        const c = snap.data();
        if (c.fromUid !== currentUser.uid && c.toUid !== currentUser.uid) return;
        await ref.update({ status: 'cancelled' });
        renderChallenges();
    } catch (e) { alert('Erreur : ' + e.message); }
}

const CHALLENGE_STATUS_LABELS = { pending: 'En attente', accepted: 'En cours', completed: 'Terminé 🏆', declined: 'Refusé', cancelled: 'Annulé' };

async function renderChallenges() {
    const el = document.getElementById('social-challenges-list');
    if (!el) return;
    if (!firebaseAvailable || !currentUser) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Connecte-toi pour voir tes défis.</p><button class="btn btn-green" style="margin-top:0;" onclick="showCompte()">Se connecter / créer un compte</button>`; return; }
    el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement...</p>`;
    try {
        const [sentSnap, receivedSnap] = await Promise.all([
            db.collection('challenges').where('fromUid', '==', currentUser.uid).get(),
            db.collection('challenges').where('toUid', '==', currentUser.uid).get()
        ]);
        const all = [...sentSnap.docs, ...receivedSnap.docs].map(d => Object.assign({ id: d.id }, d.data()));
        if (!all.length) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucun défi pour l'instant — défie un ami depuis l'onglet Amis.</p>`; return; }
        el.innerHTML = all.map(c => {
            const isRecipient = c.toUid === currentUser.uid;
            const otherPseudo = isRecipient ? c.fromPseudo : c.toPseudo;
            const myDone = isRecipient ? c.toCompleted : c.fromCompleted;
            let actions = '';
            if (c.status === 'pending' && isRecipient) {
                actions = `<button class="btn btn-green" style="margin:0;" onclick="challengeRespond('${c.id}','accepted')">Accepter</button>
                           <button class="gemini-explain-btn" onclick="challengeRespond('${c.id}','declined')">Refuser</button>`;
            } else if (c.status === 'pending') {
                actions = `<button class="gemini-explain-btn" onclick="challengeCancel('${c.id}')">Annuler</button>`;
            } else if (c.status === 'accepted' && !myDone) {
                actions = `<button class="btn btn-green" style="margin:0;" onclick="challengeMarkMyPartDone('${c.id}')">✓ J'ai maîtrisé cette notion</button>
                           <button class="gemini-explain-btn" onclick="challengeCancel('${c.id}')">Annuler</button>`;
            } else if (c.status === 'accepted' && myDone) {
                actions = `<span style="color:var(--success); font-size:0.8rem;">En attente de @${otherPseudo}</span>`;
            }
            return `<div class="hub-card" style="cursor:default;">
                <div class="hub-card-title">🎯 ${c.titre}</div>
                <div class="hub-card-desc">Avec @${otherPseudo} — ${CHALLENGE_STATUS_LABELS[c.status] || c.status}</div>
                <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">${actions}</div>
            </div>`;
        }).join('');
    } catch (e) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--wrong);">Erreur : ${e.message}</p>`; }
}

// ===== Sessions de travail (architecture — MVP) =====
// MVP volontairement minimal : un simple rendez-vous partagé (date + note), PAS d'appel vidéo, PAS
// de synchronisation en temps réel — conformément au cahier des charges ("ne mets pas en place une
// architecture backend lourde"). studySessions/{id} (id auto, comme challenges) :
//   { fromUid, toUid, fromPseudo, toPseudo, proposedDate, note, status:'pending'|'accepted'|
//     'declined'|'cancelled', createdAt, respondedAt? }
function sessionPropose(toUid, toPseudo) {
    const dateStr = prompt(`Proposer une session de révision à @${toPseudo} — quelle date ? (ex. 2026-10-05)`);
    if (!dateStr || !dateStr.trim()) return;
    const note = prompt('Un message pour accompagner la proposition ? (optionnel)') || '';
    sessionConfirmPropose(toUid, toPseudo, dateStr.trim(), note.trim());
}

async function sessionConfirmPropose(toUid, toPseudo, proposedDate, note) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        const ref = await db.collection('studySessions').add({
            fromUid: currentUser.uid, toUid, fromPseudo: currentUserDoc.pseudo, toPseudo,
            proposedDate, note, status: 'pending',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await notificationCreate(toUid, 'session', `${currentUserDoc.pseudo} te propose une session le ${proposedDate}`, note, { sessionId: ref.id });
        alert('Proposition envoyée !');
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function sessionRespond(id, newStatus) {
    if (!firebaseAvailable || !currentUser) return;
    try {
        const ref = db.collection('studySessions').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return;
        const s = snap.data();
        if (s.toUid !== currentUser.uid || s.status !== 'pending') return;
        await ref.update({ status: newStatus, respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
        if (newStatus === 'accepted') await notificationCreate(s.fromUid, 'session', `${currentUserDoc.pseudo} a accepté ta session du ${s.proposedDate}`, '', { sessionId: id });
        renderStudySessions();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function sessionCancel(id) {
    if (!firebaseAvailable || !currentUser) return;
    if (!confirm('Annuler cette session ?')) return;
    try {
        const ref = db.collection('studySessions').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return;
        const s = snap.data();
        if (s.fromUid !== currentUser.uid && s.toUid !== currentUser.uid) return;
        await ref.update({ status: 'cancelled', respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
        renderStudySessions();
    } catch (e) { alert('Erreur : ' + e.message); }
}

const SESSION_STATUS_LABELS = { pending: 'En attente', accepted: 'Confirmée', declined: 'Refusée', cancelled: 'Annulée' };

async function renderStudySessions() {
    const el = document.getElementById('social-sessions-list');
    if (!el) return;
    if (!firebaseAvailable || !currentUser) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Connecte-toi pour voir tes sessions.</p><button class="btn btn-green" style="margin-top:0;" onclick="showCompte()">Se connecter / créer un compte</button>`; return; }
    el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement...</p>`;
    try {
        const [sentSnap, receivedSnap] = await Promise.all([
            db.collection('studySessions').where('fromUid', '==', currentUser.uid).get(),
            db.collection('studySessions').where('toUid', '==', currentUser.uid).get()
        ]);
        const all = [...sentSnap.docs, ...receivedSnap.docs].map(d => Object.assign({ id: d.id }, d.data()));
        all.sort((a, b) => (a.proposedDate || '').localeCompare(b.proposedDate || ''));
        if (!all.length) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucune session pour l'instant — propose-en une depuis l'onglet Amis.</p>`; return; }
        el.innerHTML = all.map(s => {
            const isRecipient = s.toUid === currentUser.uid;
            const otherPseudo = isRecipient ? s.fromPseudo : s.toPseudo;
            let actions = '';
            if (s.status === 'pending' && isRecipient) {
                actions = `<button class="btn btn-green" style="margin:0;" onclick="sessionRespond('${s.id}','accepted')">Accepter</button>
                           <button class="gemini-explain-btn" onclick="sessionRespond('${s.id}','declined')">Refuser</button>`;
            } else if (s.status === 'pending' || s.status === 'accepted') {
                actions = `<button class="gemini-explain-btn" onclick="sessionCancel('${s.id}')">Annuler</button>`;
            }
            return `<div class="hub-card" style="cursor:default;">
                <div class="hub-card-title">📅 ${s.proposedDate} avec @${otherPseudo}</div>
                <div class="hub-card-desc">${SESSION_STATUS_LABELS[s.status] || s.status}${s.note ? ' — ' + s.note : ''}</div>
                <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">${actions}</div>
            </div>`;
        }).join('');
    } catch (e) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--wrong);">Erreur : ${e.message}</p>`; }
}

// ===== Vue "Social" (hub à onglets, accessible depuis Profil) =====
function showSocial() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('social-view').classList.add('active');
    setActiveNav('nav-profil');
    socialShowTab('friends');
}

function socialShowTab(tab) {
    ['friends', 'requests', 'challenges', 'sessions', 'search', 'privacy'].forEach(t => {
        const panel = document.getElementById('social-panel-' + t);
        const tabBtn = document.getElementById('social-tab-' + t);
        if (panel) panel.style.display = t === tab ? '' : 'none';
        if (tabBtn) tabBtn.classList.toggle('active', t === tab);
    });
    if (tab === 'friends') renderFriendsList();
    else if (tab === 'requests') renderFriendRequests();
    else if (tab === 'challenges') renderChallenges();
    else if (tab === 'sessions') renderStudySessions();
    else if (tab === 'privacy') renderPrivacySettings();
}

// ===== Accueil : bloc léger "👥 Avec tes amis" (secondaire, cf. cahier des charges — ne doit pas
// prendre le pas sur l'apprentissage). Chargé de façon asynchrone pour ne jamais bloquer le premier
// rendu du dashboard ; se re-rend une fois les données disponibles. =====
let socialDashboardCache = null;
async function loadSocialDashboardSnippet() {
    if (!firebaseAvailable || !currentUser) return;
    try {
        const snap = await db.collection('friendships').where('uids', 'array-contains', currentUser.uid).get();
        const acceptedUids = [];
        snap.forEach(doc => { const f = doc.data(); if (f.status === 'accepted') acceptedUids.push(f.uids.find(u => u !== currentUser.uid)); });
        if (!acceptedUids.length) { socialDashboardCache = { friendCount: 0, lines: [] }; return; }
        const sample = acceptedUids.slice(0, 5);
        const lines = [];
        for (const uid of sample) {
            const [profSnap, statsSnap] = await Promise.all([
                db.collection('publicProfiles').doc(uid).get(),
                db.collection('friendStats').doc(uid).get()
            ]);
            if (!profSnap.exists) continue;
            const pseudo = profSnap.data().pseudo;
            const stats = statsSnap.exists ? (statsSnap.data().stats || {}) : {};
            if (typeof stats.streak === 'number' && stats.streak > 1) lines.push(`🔥 ${pseudo} a un streak de ${stats.streak} jours`);
            else if (stats.level) lines.push(`📚 ${pseudo} est au niveau ${stats.level}`);
        }
        socialDashboardCache = { friendCount: acceptedUids.length, lines: lines.slice(0, 3) };
        if (document.getElementById('home-view').classList.contains('active')) renderDashboard();
    } catch (e) { console.warn('Social dashboard snippet non chargé :', e); }
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
        // progressEpoch change : les appareils de cet utilisateur adopteront la remise à zéro au
        // lieu de renvoyer leur copie locale par-dessus.
        await db.collection('users').doc(uid).update({
            progress: { xp: 0, mastered: [] }, progressRev: syncNewRev(), progressEpoch: Date.now()
        });
        alert('Progression effacée.');
    } catch (e) {
        alert('Erreur : ' + e.message);
    }
}

// Reprend la session automatiquement au rechargement de la page (Firebase garde la session en local)
if (firebaseAvailable) {
    auth.onAuthStateChanged(async (user) => {
        if (!user || accExplicitAuthInProgress) return;
        try {
            const snap = await db.collection('users').doc(user.uid).get();
            if (!snap.exists) return;
            const userDoc = snap.data();
            if (userDoc.disabled) { await auth.signOut(); return; }
            currentUser = user;
            currentUserDoc = userDoc;
            // Récupère ce qui a été fait sur un autre appareil depuis la dernière visite.
            cloudLastCheckAt = Date.now();
            if (await cloudReconcile(userDoc, false)) return; // la page se recharge
            if (document.getElementById('compte-view').classList.contains('active')) accShowLoggedIn();
            // Backfill : les comptes créés avant l'ajout de la couche sociale n'ont pas encore
            // publicProfiles/friendStats/discoverable — socialEnsureProfileDocs() est idempotent
            // (merge:true) donc l'appeler à chaque reprise de session est sans risque.
            socialEnsureProfileDocs();
            notificationsRefreshBadge();
            if (document.getElementById('home-view').classList.contains('active')) renderDashboard();
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
        if (!state.stats.dailyStreak) state.stats.dailyStreak = 0; // jours consécutifs d'utilisation
        if (!state.stats.lastActiveDay) state.stats.lastActiveDay = null; // 'YYYY-MM-DD', pour calculer dailyStreak
        if (!state.settings) state.settings = { direction: 'fr2nl' }; // 'fr2nl' ou 'nl2fr'
        if (!state.settings.theme) state.settings.theme = 'auto'; // 'auto' | 'clair' | 'sombre'

        // Streak quotidien : simple compteur de jours consécutifs, calculé une fois par jour au
        // chargement (pas à chaque save(), inutile). N'affecte aucun moteur pédagogique — c'est une
        // statistique de motivation, comme XP.
        function updateDailyStreak() {
            const todayStr = new Date().toISOString().slice(0, 10);
            if (state.stats.lastActiveDay === todayStr) return;
            if (state.stats.lastActiveDay) {
                const diffDays = Math.round((new Date(todayStr) - new Date(state.stats.lastActiveDay)) / 86400000);
                state.stats.dailyStreak = diffDays === 1 ? (state.stats.dailyStreak || 0) + 1 : 1;
            } else {
                state.stats.dailyStreak = 1;
            }
            state.stats.lastActiveDay = todayStr;
            save();
        }
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

        // ===== Synthèse vocale (prononciation) — partagée par toute l'app =====
        // Web Speech API du navigateur : gratuit, déjà utilisé par le Jeu de rôle (voir plus bas
        // rpDutchVoice/rpCheckDutchVoice, section Jeu de rôle où la détection de voix néerlandaise a
        // été introduite en premier). speakNL() est le SEUL point d'entrée que le reste de l'app
        // appelle, pour ne jamais dupliquer cette logique de sélection de voix — rpSpeakText (jeu de
        // rôle) délègue lui aussi à cette même fonction plus bas.
        // Retire la mise en forme que Gemini glisse dans ses réponses (**gras**, *italique*,
        // # titres, listes à puces, `code`) : affichée telle quelle elle encombre le texte, et la
        // voix la lisait à haute voix ("sterretje sterretje" pour **).
        function stripMarkdown(text) {
            return String(text)
                .replace(/```[a-z]*\n?/gi, '')
                .replace(/^\s{0,3}#{1,6}\s+/gm, '')
                .replace(/^\s*[-*•]\s+/gm, '')
                .replace(/[*`~]/g, '')
                .replace(/(^|\s)_+([^_]+?)_+(?=\s|[.,!?;:]|$)/g, '$1$2')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
        }

        function speakNL(text) {
            if (!('speechSynthesis' in window) || !text) return;
            // Pour la voix, on retire aussi les emojis, que certaines voix décrivent à haute voix.
            text = stripMarkdown(text).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').trim();
            if (!text) return;
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'nl-NL';
            if (typeof rpDutchVoice !== 'undefined' && rpDutchVoice) utterance.voice = rpDutchVoice;
            utterance.rate = 0.95;
            window.speechSynthesis.speak(utterance);
        }

        // Bouton 🔊 réutilisable, à insérer dans n'importe quel innerHTML affichant un mot/une phrase
        // en néerlandais. event.stopPropagation() : beaucoup de rangées appelantes (ex: wl-row,
        // lesson-vocab-item) ont elles-mêmes un onclick sur tout le bloc — sans ça, cliquer sur 🔊
        // déclencherait AUSSI l'action de la rangée (sélection, navigation...).
        function speakBtnHtml(text, extraStyle) {
            const safe = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return `<button type="button" class="speak-btn" style="${extraStyle || ''}" onclick="event.stopPropagation(); speakNL('${safe}')" title="Écouter la prononciation" aria-label="Écouter la prononciation">🔊</button>`;
        }

        // Bouton 🇫🇷 "traduire à la demande" : beaucoup de contenus du curriculum (exemples,
        // vocabulaire, réponses d'exercice) n'ont pas de traduction française stockée en dur.
        // Plutôt que de traduire ~980 items dans les données, ce bouton appelle Gemini pour UN
        // seul mot/phrase au moment où l'apprenant en a besoin, et affiche le résultat juste à
        // côté (span dédié, id unique par bouton). Même logique stopPropagation que speakBtnHtml.
        let _translateBtnSeq = 0;
        function translateBtnHtml(text) {
            const safe = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const outId = 'translate-out-' + (_translateBtnSeq++);
            return `<button type="button" class="translate-btn" onclick="event.stopPropagation(); translateNLtoFR('${safe}', '${outId}', this)" title="Traduire en français" aria-label="Traduire en français">🇫🇷</button><span class="translate-result" id="${outId}"></span>`;
        }

        async function translateNLtoFR(text, outId, btnEl) {
            const span = document.getElementById(outId);
            if (!span) return;
            if (!GeminiService.isAvailable()) {
                span.innerText = ' (pas de clé API Gemini — ajoute-en une gratuitement dans Profil → 🤖 Intelligence IA)';
                return;
            }
            if (btnEl) btnEl.disabled = true;
            span.innerText = ' …';
            try {
                const fr = await GeminiService.translateToFrench(text);
                span.innerText = ' → ' + fr.trim();
            } catch (e) {
                span.innerText = ' (traduction indisponible : ' + e.message + ')';
            } finally {
                if (btnEl) btnEl.disabled = false;
            }
        }

        async function init() {
            updateDailyStreak();
            // Fichiers de vocabulaire "de base" : obligatoires, erreur affichée si absents/vides
            const coreFiles = [
                'VERBES_NL.csv', 'NOMS_NL.csv', 'ADJECTIFS_NL.csv', 'ADVERBES_NL.csv', 'MOTS_OUTILS_NL.csv',
                'EXPRESSIONS_NL.csv', 'PHRASES_LABO_avec_frequence.csv', 'MOTS_LABO_avec_frequence.csv'
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
                    const lines = t.split(/\r?\n/);
                    // Les fichiers fr-first ont grandi au fil des enrichissements (statut_examen,
                    // priorite_frequence, niveauCECR, sousCategorie...) et n'ont plus tous le même
                    // nombre de colonnes. On lit l'en-tête pour retrouver l'index de chaque colonne
                    // nommée plutôt que de deviner par position (l'ancien "dernière colonne" cassait
                    // dès qu'une colonne était ajoutée après priorite_frequence).
                    let headerIdx = {};
                    if (!nlFirst && lines[0]) {
                        lines[0].split(';').forEach((h, idx) => { headerIdx[h.trim()] = idx; });
                    }
                    let count = 0;
                    let rowIdx = 0;
                    lines.slice(1).forEach(l => {
                        if (!l.trim()) return;
                        const c = l.split(';');
                        if (c[nlIdx] !== undefined && c[nlIdx].trim()) {
                            // La fréquence est en colonne 4 (index 3) pour les fichiers fr-first (id;fr;nl;freq;...).
                            // Pour THEME_BASE (nl-first), elle reste en toute dernière colonne comme avant.
                            const freqStr = nlFirst ? c[c.length - 1] : c[3];
                            const freqRaw = parseFloat(freqStr);
                            const get = (name) => (headerIdx[name] !== undefined ? (c[headerIdx[name]] || '').trim() : '');
                            // Priorité (Essentiel/Courant/Spécialisé/Auxiliaire-Modal), si présente.
                            const tier = nlFirst ? '' : get('priorite_frequence');
                            const niveauCECR = nlFirst ? '' : get('niveauCECR');
                            const niveauCECRSource = nlFirst ? '' : get('niveauCECRSource');
                            const sousCategorie = nlFirst ? '' : get('sousCategorie');
                            const sousCategorieSource = nlFirst ? '' : get('sousCategorieSource');
                            fullDb.push({
                                id: f + '_row' + rowIdx, fr: (c[frIdx] || '').trim(), nl: c[nlIdx].trim(),
                                file: base, freq: isNaN(freqRaw) ? 0 : freqRaw, tier: tier,
                                niveauCECR: niveauCECR || undefined, niveauCECRSource: niveauCECRSource || undefined,
                                sousCategorie: sousCategorie || undefined, sousCategorieSource: sousCategorieSource || undefined
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
            updateStats(); // relit le niveau CECR maintenant que le curriculum est chargé (getCurriculumLevel)
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

        if (!state.curriculum) state.curriculum = { notionProgress: {} };
        // { [notionId]: { opened, attempts, correct,
        //   weaknessCount, lastResult, lastAttemptAt } }
        // weaknessCount/lastResult/lastAttemptAt sont ajoutés par cette version pour donner une
        // conséquence aux erreurs (voir MasteryEngine/WeaknessEngine plus bas). Migration douce :
        // les anciennes entrées n'ont pas ces champs, ils sont donc TOUJOURS lus avec un défaut
        // (`|| 0`, etc.) plutôt que backfillés en masse — aucune donnée existante n'est invalidée.
        if (!state.productionWeaknessSignals) state.productionWeaknessSignals = [];
        // ===== Placement Engine : historique des évaluations de niveau =====
        // Ne contient QUE de l'historique/traçabilité (source déclarée, résultat estimé). Aucune
        // donnée de maîtrise ne vit ici : le Placement Engine écrit exclusivement dans
        // state.curriculum.notionProgress via recordNotionAttempt/ntProgress, exactement comme un
        // exercice normal — migration douce, tableau vide par défaut.
        if (!state.placement) state.placement = { history: [] };
        if (state.onboardingSeen === undefined) state.onboardingSeen = false; // migration douce, jamais réécrit ailleurs qu'ici et dans onboardingMarkSeen
        // ===== Mode libre (déverrouille toutes les notions) — désactivé par défaut, à activer soi-même
        // dans Profil si on veut sauter le déverrouillage progressif (ex. attaquer direct du B2). Ne
        // change rien d'autre : la maîtrise réelle (WeaknessEngine) continue d'être calculée normalement,
        // seul l'accès à l'écran de leçon change. =====
        if (state.freeAccess === undefined) state.freeAccess = false;

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

        // ===== MasteryEngine (v2) : score 0-5 par notion (calcul de base inchangé) =====
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
            if (state.freeAccess) return true; // mode libre : l'utilisateur a choisi de sauter le déverrouillage progressif
            const notion = curriculumNotions[notionId];
            if (!notion) return false;
            if (!notion.prerequisites || notion.prerequisites.length === 0) return true;
            return notion.prerequisites.every(pid => computeNotionMastery(pid) >= 3);
        }

        function toggleFreeAccess(value) {
            state.freeAccess = value;
            save();
            if (document.getElementById('apprendre-view').classList.contains('active')) renderApprendreLevel(apprendreCurrentLevel);
            if (document.getElementById('profil-view').classList.contains('active')) renderProfil();
        }

        // ===== Niveau CECR global : dérivé du curriculum (MasteryEngine), PLUS du vocabulaire =====
        // Le vocabulaire reste une statistique de couverture séparée (voir getVocabProgress plus
        // bas, renommée en usage "couverture lexicale"). Ici, on agrège computeNotionMastery — déjà
        // existant — par niveau CECR : aucun nouvel état, aucune nouvelle source de vérité. Un
        // niveau est considéré "largement acquis" à 60% de ses notions prêtes en mastery >= 3 (le
        // même seuil qui débloque déjà la suite via isNotionUnlocked), cohérent avec le seuil 0.6
        // déjà utilisé ailleurs dans l'appli (ex. progression de palier du test de vocabulaire).
        // Comme le Placement Engine écrit exclusivement dans notionProgress (jamais une structure
        // séparée), un résultat de placement se reflète ici automatiquement, sans rien connecter en plus.
        const CECR_LEVEL_THRESHOLD = 0.6;

        function getCurriculumLevelStats() {
            if (!curriculumLoaded) return [];
            return curriculumLevels.map(lvl => {
                const ids = Object.keys(curriculumNotions).filter(id => curriculumNotions[id].level === lvl.id && curriculumNotions[id].status === 'pret');
                const masteredCount = ids.filter(id => computeNotionMastery(id) >= 3).length;
                const pct = ids.length ? Math.round((masteredCount / ids.length) * 100) : 0;
                let statusLabel;
                if (!ids.length) statusLabel = 'à venir';
                else if (pct >= CECR_LEVEL_THRESHOLD * 100) statusLabel = 'largement maîtrisé';
                else if (ids.some(id => computeNotionMastery(id) >= 1)) statusLabel = 'en progression';
                else statusLabel = 'exploration';
                return { level: lvl.id, label: lvl.label, pct, total: ids.length, mastered: masteredCount, statusLabel };
            });
        }

        // Renvoie le niveau CECR global (le dernier niveau, dans l'ordre du programme, dont au
        // moins 60% des notions prêtes sont en mastery >= 3) ainsi que le détail par niveau.
        function getCurriculumLevel() {
            const stats = getCurriculumLevelStats();
            if (!stats.length) return { level: (curriculumLevels[0] && curriculumLevels[0].id) || 'A1', stats: [] };
            let current = stats[0].level;
            stats.forEach(s => {
                if (s.total > 0 && s.pct >= CECR_LEVEL_THRESHOLD * 100) current = s.level;
            });
            return { level: current, stats };
        }

        // ===== Signal de faiblesse "exercices", pondéré par la récence =====
        // weaknessCount est incrémenté à chaque erreur et décrémenté à chaque réussite suivante
        // (voir checkExerciseAnswer) : ce n'est jamais un compteur qui condamne durablement une
        // notion. En plus de ça, on atténue son poids avec le temps ici, pour qu'une erreur
        // ancienne pèse moins qu'une erreur récente même sans nouvelle tentative :
        // - de 14 à 30 jours sans y retoucher : poids divisé par 2
        // - au-delà de 30 jours : on ne la compte plus comme un signal actif
        function getEffectiveWeakness(notionId) {
            const p = state.curriculum.notionProgress[notionId];
            const raw = (p && p.weaknessCount) || 0;
            if (raw <= 0 || !p || !p.lastAttemptAt) return raw;
            const daysSince = (Date.now() - p.lastAttemptAt) / 86400000;
            if (daysSince >= 30) return 0;
            if (daysSince >= 14) return raw * 0.5;
            return raw;
        }

        // ===== Signal de faiblesse "production" (Gemini) =====
        // Lecture seule de productionWeaknessSignals (déjà alimenté par
        // recordProductionWeaknessSignals) : aucune deuxième structure de données n'est créée.
        function getProductionWeaknessCount(notionId) {
            return (state.productionWeaknessSignals || []).filter(s => s.notionId === notionId).length;
        }

        // ===== WeaknessEngine (v2) : 7 états par notion =====
        // jamais_etudiee / decouverte / en_cours / faible / entrainee / presque_maitrisee / maitrisee
        // (+ a_pratiquer : exercices bons mais un signal ponctuel — exercice ou production — reste).
        // Garde-fous demandés : (1) un signal de production ne peut JAMAIS, à lui seul, faire
        // basculer une notion en "faible" — il ne fait que la pousser vers "à pratiquer" ; (2) il
        // faut au moins 2 erreurs d'exercice encore actives (récentes) pour parler de "faible" —
        // une erreur isolée ne déclasse pas une notion déjà solide.
        function getNotionStatus(notionId) {
            const notion = curriculumNotions[notionId];
            if (!notion) return 'jamais_etudiee';
            const mastery = computeNotionMastery(notionId);
            if (mastery === 0) return 'jamais_etudiee';
            if (mastery === 1) return 'decouverte';

            const effWeak = getEffectiveWeakness(notionId);
            const prodCount = getProductionWeaknessCount(notionId);

            if (effWeak >= 2) return 'faible';
            if (mastery === 2) return 'en_cours';
            if (mastery === 3) return 'entrainee';
            if (mastery === 4) return (effWeak >= 1 || prodCount >= 1) ? 'a_pratiquer' : 'presque_maitrisee';
            // mastery === 5
            return (effWeak >= 1 || prodCount >= 1) ? 'a_pratiquer' : 'maitrisee';
        }

        function getNotionStatusLabel(status) {
            return ({
                jamais_etudiee: 'Jamais étudiée',
                decouverte: 'Découverte',
                en_cours: 'En cours',
                faible: '🔁 À revoir',
                a_pratiquer: '🎯 À pratiquer',
                entrainee: 'Entraînée',
                presque_maitrisee: 'Presque maîtrisée',
                maitrisee: 'Maîtrisée'
            })[status] || status;
        }

        // ===== WeaknessEngine (v2) =====
        // Ne regarde que les notions déjà rédigées (status "pret") — le reste n'a pas encore de
        // contenu, ce n'est pas une "faiblesse" mais du programme pas encore construit. Une notion
        // jamais étudiée n'est pas non plus une "faiblesse" : c'est juste du programme pas encore vu.
        function getWeaknesses() {
            return Object.keys(curriculumNotions)
                .filter(id => curriculumNotions[id].status === 'pret')
                .map(id => ({
                    id, label: id,
                    mastery: computeNotionMastery(id),
                    status: getNotionStatus(id),
                    notion: curriculumNotions[id]
                }))
                .filter(w => w.status === 'faible' || w.status === 'a_pratiquer')
                .sort((a, b) => {
                    // "faible" avant "à pratiquer", puis par intensité du signal d'exercice
                    if (a.status !== b.status) return a.status === 'faible' ? -1 : 1;
                    return getEffectiveWeakness(b.id) - getEffectiveWeakness(a.id);
                });
        }

        // ===== RecommendationEngine (v2) =====
        // Le moteur dit quoi proposer MAINTENANT (une seule suggestion) — il n'impose pas de
        // programme quotidien. Toujours filtré par : notion.status === 'pret', prérequis acquis
        // (isNotionUnlocked), ordre du programme. Priorités, dans l'ordre :
        //   1. faiblesse d'exercice réelle et non isolée (statut "faible")
        //   2. notion récemment abordée mais encore fragile (découverte / en cours)
        //   3. à consolider : exercices bons mais signal (exercice ponctuel ou production) restant
        //      ("à pratiquer"), ou notion presque maîtrisée pas revue depuis longtemps (spaced review)
        //   4. nouvelle notion débloquée, jamais étudiée
        //   5. repli : comportement historique (1ère notion du programme pas encore à 5)
        function getRecommendation() {
            const modulesSorted = [...curriculumModules].sort((a, b) => a.order - b.order);
            const ordered = modulesSorted.flatMap(mod => (mod.notions || []).map(notionId => ({ notionId, module: mod })));
            const ready = ordered.filter(o => {
                const n = curriculumNotions[o.notionId];
                return n && n.status === 'pret' && isNotionUnlocked(o.notionId);
            });

            const pick = (list, reason) => {
                if (!list.length) return null;
                const o = list[0];
                return { notionId: o.notionId, notion: curriculumNotions[o.notionId], module: o.module, reason };
            };

            // Priorité 1
            let candidates = ready.filter(o => getNotionStatus(o.notionId) === 'faible')
                .sort((a, b) => getEffectiveWeakness(b.notionId) - getEffectiveWeakness(a.notionId));
            if (candidates.length) {
                const titre = curriculumNotions[candidates[0].notionId].content.titre || candidates[0].notionId;
                const r = pick(candidates, `À revoir : tu as fait plusieurs erreurs récentes sur « ${titre} ».`);
                if (r) return r;
            }

            // Priorité 2
            candidates = ready.filter(o => ['decouverte', 'en_cours'].includes(getNotionStatus(o.notionId)));
            if (candidates.length) {
                const r = pick(candidates, "À consolider : tu viens de l'aborder, elle n'est pas encore stabilisée.");
                if (r) return r;
            }

            // Priorité 3a : à pratiquer (exercices bons, signal exercice ponctuel ou production restant)
            candidates = ready.filter(o => getNotionStatus(o.notionId) === 'a_pratiquer');
            if (candidates.length) {
                const r = pick(candidates, "À pratiquer : les exercices sont bons mais un point mérite encore un peu d'entraînement (parfois vu en production).");
                if (r) return r;
            }

            // Priorité 3b : spaced review — notion presque maîtrisée mais pas revue depuis longtemps
            const REVIEW_GAP_DAYS = 21;
            candidates = ready.filter(o => {
                if (getNotionStatus(o.notionId) !== 'presque_maitrisee') return false;
                const p = state.curriculum.notionProgress[o.notionId];
                if (!p || !p.lastAttemptAt) return false;
                return (Date.now() - p.lastAttemptAt) / 86400000 >= REVIEW_GAP_DAYS;
            });
            if (candidates.length) {
                const r = pick(candidates, "À consolider : ça fait un moment, un petit rappel te ferait du bien.");
                if (r) return r;
            }

            // Priorité 4 : nouvelle notion débloquée
            candidates = ready.filter(o => getNotionStatus(o.notionId) === 'jamais_etudiee');
            if (candidates.length) {
                const r = pick(candidates, 'Nouvelle notion : tes prérequis sont maîtrisés.');
                if (r) return r;
            }

            // Priorité 5 : repli, comportement historique
            for (const o of ready) {
                if (computeNotionMastery(o.notionId) >= 5) continue;
                return { notionId: o.notionId, notion: curriculumNotions[o.notionId], module: o.module, reason: 'Continue ta progression dans le programme.' };
            }
            return null;
        }

        // ===== « Que faire maintenant ? » — couche d'expérience au-dessus du moteur existant =====
        // Ceci n'est PAS un nouveau moteur de progression ni un DailyPlanEngine : c'est uniquement
        // de l'orchestration d'interface. La seule source de vérité reste getRecommendation()
        // (donc MasteryEngine → WeaknessEngine → RecommendationEngine). Cette couche se contente de
        // (1) traduire le statut d'une notion en une activité concrète déjà existante dans l'appli
        // (leçon, exercices, production), et (2) recalculer getRecommendation() après chaque
        // activité pour proposer la suite — sans jamais imposer de programme ni de durée.
        //
        // guidedFlowActive/guidedFlowNotionId sont des variables d'état d'interface transitoires,
        // au même titre que currentLessonNotionId ou exerciseQueue : elles ne sont pas persistées,
        // et l'utilisateur reste libre de quitter à tout moment (aucune confirmation requise).
        let guidedFlowActive = false;
        let guidedFlowNotionId = null;

        function endGuidedFlow() {
            guidedFlowActive = false;
            guidedFlowNotionId = null;
            const banner = document.getElementById('guided-flow-banner');
            if (banner) banner.innerHTML = '';
        }

        // Traduit un statut WeaknessEngine (voir getNotionStatus) en libellé d'activité pour
        // l'interface. Purement cosmétique : ne recalcule rien, ne décide de rien.
        function getRecommendedActivityMeta(status) {
            return ({
                jamais_etudiee: { icon: '🆕', label: 'Nouvelle notion débloquée', duration: '~10 min' },
                decouverte: { icon: '📚', label: 'Continuer la leçon', duration: '~10 min' },
                en_cours: { icon: '📚', label: 'Continuer la leçon', duration: '~8 min' },
                faible: { icon: '🔁', label: 'Revoir cette notion', duration: '~5 min' },
                a_pratiquer: { icon: '🎯', label: 'Consolider (exercices + production)', duration: '~5 min' },
                entrainee: { icon: '🎯', label: 'Continuer les exercices', duration: '~5 min' },
                presque_maitrisee: { icon: '🔄', label: 'Petit rappel', duration: '~3 min' },
                maitrisee: { icon: '✅', label: 'Notion maîtrisée', duration: '' }
            })[status] || { icon: '📚', label: 'Continuer', duration: '' };
        }

        // Démarre l'activité recommandée pour une notion donnée, en réutilisant exclusivement les
        // vues/fonctions déjà existantes (showLesson, showExercise, openProductionPanel). N'invente
        // aucune nouvelle vue.
        function startRecommendedActivity(notionId) {
            guidedFlowActive = true;
            guidedFlowNotionId = notionId;
            const status = getNotionStatus(notionId);
            if (status === 'a_pratiquer') {
                // Les exercices sont déjà bons : on va directement à la production, déjà présente
                // dans la leçon (bloc "✍️ À toi de jouer").
                showLesson(notionId);
                setTimeout(() => {
                    openProductionPanel(notionId, 'ecrit');
                    const panel = document.getElementById('production-panel');
                    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 50);
            } else if (status === 'jamais_etudiee' || status === 'decouverte' || status === 'en_cours') {
                // Notion pas encore stabilisée : on repart de la leçon (elle propose déjà le bouton
                // vers les exercices).
                showLesson(notionId);
            } else {
                // faible / entrainee / presque_maitrisee : la leçon est déjà connue, on va droit aux
                // exercices ciblés (réutilise les exercices existants, n'en génère pas de nouveaux).
                showExercise(notionId);
            }
        }

        // Affiche le petit bandeau "activité terminée" une fois qu'une activité du flux guidé se
        // termine (fin de la file d'exercices, ou retour de feedback Gemini sur une production).
        function renderGuidedFlowCompletion(notionId) {
            if (!guidedFlowActive || guidedFlowNotionId !== notionId) return;
            const banner = document.getElementById('guided-flow-banner');
            if (!banner) return;
            banner.innerHTML = `
                <div class="dash-card guided-flow-card">
                    <div class="guided-flow-label">✅ Activité terminée</div>
                    <div class="guided-flow-actions">
                        <button class="btn btn-green" onclick="continueGuidedFlow()">Continuer</button>
                        <button class="gemini-explain-btn" onclick="exitGuidedFlow()">Choisir autre chose</button>
                    </div>
                </div>`;
        }

        // « activité → résultat → recalcul → prochaine proposition » : les résultats de l'activité
        // ont déjà mis à jour notionProgress/productionWeaknessSignals (via checkExerciseAnswer /
        // submitProduction) ; on relit donc simplement getRecommendation() à l'instant présent —
        // aucune nouvelle logique de recommandation n'est créée ici.
        function continueGuidedFlow() {
            const banner = document.getElementById('guided-flow-banner');
            if (banner) banner.innerHTML = '';
            const rec = getRecommendation();
            if (rec) {
                startRecommendedActivity(rec.notionId);
            } else {
                endGuidedFlow();
                showHome();
            }
        }

        // « Choisir autre chose » : sortie libre, sans confirmation, vers le reste de l'application.
        function exitGuidedFlow() {
            endGuidedFlow();
            showApprendre();
        }

        // L'ancien onglet "Jouer" n'existe plus : ses jeux sont dans l'onglet Réviser, la
        // conjugaison et les particules séparables dans Apprendre. showJouer() est conservé
        // comme alias pour les appels existants.
        function showJouer() {
            showReviser();
        }
        // Ouvre la leçon d'une notion puis le panneau de production déjà existant (même schéma que
        // la branche 'a_pratiquer' de startRecommendedActivity) : aucun nouveau système Gemini.
        function goToProduction(notionId) {
            showLesson(notionId);
            setTimeout(() => {
                openProductionPanel(notionId, 'ecrit');
                const panel = document.getElementById('production-panel');
                if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 50);
        }

        // ===== Vue "Pratiquer" (roleplay, pratique ciblée, production — 100% de systèmes existants) =====
        function showPratiquer() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('pratiquer-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            renderPratiquer();
        }

        // Un seul barème de priorité, partagé par la pratique ciblée (orale) et la production
        // (écrite) : une notion identifiée comme faiblesse par le curriculum remonte en premier
        // dans les deux listes — c'est ça, "la pratique ciblée lancée depuis une faiblesse".
        const PRATIQUER_STATUS_PRIORITY = { faible: 0, a_pratiquer: 1, en_cours: 2, decouverte: 3, entrainee: 4, presque_maitrisee: 5, maitrisee: 6, jamais_etudiee: 7 };

        function renderPratiquer() {
            const targetedList = document.getElementById('pratiquer-targeted-list');
            if (targetedList) {
                const entries = Object.keys(NOTION_TARGETED_PRACTICE)
                    .sort((a, b) => (PRATIQUER_STATUS_PRIORITY[getNotionStatus(a)] ?? 9) - (PRATIQUER_STATUS_PRIORITY[getNotionStatus(b)] ?? 9));
                targetedList.innerHTML = entries.length ? entries.map(nid => {
                    const cfg = NOTION_TARGETED_PRACTICE[nid];
                    const status = curriculumLoaded ? getNotionStatus(nid) : null;
                    return `<div class="hub-card" onclick="rpStartTargetedPractice('${nid}')">
                        <span class="hub-card-icon">🎯</span>
                        <div class="hub-card-title">${cfg.label}</div>
                        <div class="hub-card-desc">${status ? getNotionStatusLabel(status) + ' · ' : ''}Pratique orale ciblée avec Gemini.</div>
                    </div>`;
                }).join('') : `<div style="font-size:0.8rem; color:var(--text-secondary);">Pas encore de pratique ciblée disponible.</div>`;
            }

            const prodList = document.getElementById('pratiquer-production-list');
            if (prodList) {
                if (!curriculumLoaded) {
                    prodList.innerHTML = `<div style="font-size:0.8rem; color:var(--text-secondary);">Chargement du programme...</div>`;
                } else {
                    const statusPriority = PRATIQUER_STATUS_PRIORITY;
                    const candidates = Object.keys(curriculumNotions)
                        .filter(id => curriculumNotions[id].status === 'pret' && isNotionUnlocked(id) && curriculumNotions[id].content && curriculumNotions[id].content.tacheProduction)
                        .sort((a, b) => (statusPriority[getNotionStatus(a)] ?? 9) - (statusPriority[getNotionStatus(b)] ?? 9))
                        .slice(0, 8);
                    prodList.innerHTML = candidates.length ? candidates.map(id => {
                        const notion = curriculumNotions[id];
                        const titre = notion.content.titre || id.replace(/_/g, ' ');
                        return `<div class="hub-card" onclick="goToProduction('${id}')">
                            <span class="hub-card-icon">✍️</span>
                            <div class="hub-card-title">${titre}</div>
                            <div class="hub-card-desc">${getNotionStatusLabel(getNotionStatus(id))}</div>
                        </div>`;
                    }).join('') : `<div style="font-size:0.8rem; color:var(--text-secondary);">Débloque des notions dans Apprendre pour accéder à la production écrite.</div>`;
                }
            }
        }

        // ===== Vue "Réviser" (mots ratés, déterminants, notions fragiles — systèmes existants) =====
        function showReviser() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('reviser-view').classList.add('active');
            setActiveNav('nav-reviser');
            renderReviser();
        }

        function renderReviser() {
            const el = document.getElementById('reviser-content');
            if (!el) return;
            const wordCount = getReviewItems().length;
            const articleCount = getArticleReviewItems().length;
            const weaknesses = curriculumLoaded ? getWeaknesses().slice(0, 8) : [];
            el.innerHTML = `
                <div class="hub-grid single">
                    <div class="hub-card" onclick="startRevision()">
                        <span class="hub-card-icon">🔁</span>
                        <div class="hub-card-title">Mots à revoir</div>
                        <div class="hub-card-desc">${wordCount} mot${wordCount > 1 ? 's' : ''} raté${wordCount > 1 ? 's' : ''} à retravailler.</div>
                    </div>
                    <div class="hub-card" onclick="startArticleRevision()">
                        <span class="hub-card-icon">🔤</span>
                        <div class="hub-card-title">Déterminants (de/het)</div>
                        <div class="hub-card-desc">${articleCount} mot${articleCount > 1 ? 's' : ''} à revoir.</div>
                    </div>
                </div>
                ${weaknesses.length ? `
                <div class="section-title" style="margin:var(--space-4) 0 var(--space-2);">Notions fragiles</div>
                <div class="hub-grid single">
                    ${weaknesses.map(w => {
                        const titre = w.notion.content.titre || w.id.replace(/_/g, ' ');
                        // Phrase explicite plutôt qu'un simple badge de statut, pour répondre à
                        // "pourquoi on me propose ça" (réutilise le statut déjà calculé par
                        // WeaknessEngine, n'invente aucune nouvelle donnée).
                        const reason = w.status === 'faible'
                            ? `🔁 Tu as eu des difficultés récentes avec « ${titre} ».`
                            : `🎯 Il te reste à consolider « ${titre} ».`;
                        return `
                        <div class="hub-card" onclick="showLesson('${w.id}')">
                            <div class="hub-card-title">${reason}</div>
                            <div class="dash-mini-bar"><div class="dash-mini-fill" style="width:${w.mastery * 20}%"></div></div>
                            ${NOTION_TARGETED_PRACTICE[w.id] ? `<button class="gemini-explain-btn" onclick="event.stopPropagation(); rpStartTargetedPractice('${w.id}')">🎯 Pratiquer à l'oral cette notion</button>` : ''}
                        </div>`;
                    }).join('')}
                </div>` : ''}`;
        }

        // ===== Vue "Comprendre" (indexe les notions de grammaire DÉJÀ écrites dans le curriculum,
        // par leur contenu `comprendre` déjà existant — aucun nouveau contenu pédagogique n'est créé
        // ici, uniquement une entrée directe vers le mécanisme plutôt que par Niveau→Module) =====
        function showComprendre() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('comprendre-view').classList.add('active');
            setActiveNav('nav-apprendre');
            renderComprendre();
        }

        function renderComprendre() {
            const el = document.getElementById('comprendre-content');
            if (!el) return;
            if (!curriculumLoaded) { el.innerHTML = `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement du programme...</p>`; return; }
            const byLevel = {};
            Object.keys(curriculumNotions).forEach(id => {
                const n = curriculumNotions[id];
                if (n.status !== 'pret' || !(n.skills || []).includes('grammaire') || !n.content || !n.content.comprendre) return;
                (byLevel[n.level] = byLevel[n.level] || []).push({ id, n });
            });
            const sections = curriculumLevels.map(lvl => {
                const items = byLevel[lvl.id];
                if (!items || !items.length) return '';
                return `<div class="section-title" style="margin:var(--space-4) 0 var(--space-2);">${lvl.id} · ${lvl.label}</div>
                    <div class="hub-grid single">
                        ${items.map(({ id, n }) => {
                            const excerpt = n.content.comprendre.length > 110 ? n.content.comprendre.slice(0, 110) + '…' : n.content.comprendre;
                            return `<div class="hub-card" onclick="showLesson('${id}')">
                                <div class="hub-card-title">${n.content.titre || id.replace(/_/g, ' ')}</div>
                                <div class="hub-card-desc">${excerpt}</div>
                            </div>`;
                        }).join('')}
                    </div>`;
            }).join('');
            el.innerHTML = sections || `<p style="font-size:0.85rem; color:var(--text-secondary);">Rien à afficher pour l'instant.</p>`;
        }

        // ===== Hub "Mots" : bascule entre les onglets Liste / Par thème (aucun changement de données) =====
        function motsShowTab(tab) {
            const liste = document.getElementById('mots-panel-liste');
            const themes = document.getElementById('mots-panel-themes');
            const tabListe = document.getElementById('mots-tab-liste');
            const tabThemes = document.getElementById('mots-tab-themes');
            if (liste) liste.style.display = tab === 'liste' ? '' : 'none';
            if (themes) themes.style.display = tab === 'themes' ? '' : 'none';
            if (tabListe) tabListe.classList.toggle('active', tab === 'liste');
            if (tabThemes) tabThemes.classList.toggle('active', tab === 'themes');
        }

        // ===== Placement Engine =====
        // Détermine un point de départ pédagogique en réutilisant EXCLUSIVEMENT les briques déjà
        // existantes (curriculumModules/curriculumNotions/curriculumExercises, isNotionUnlocked,
        // getNotionStatus, recordNotionAttempt, l'écran #exercise-view). Ne remplace ni ne double
        // MasteryEngine/WeaknessEngine/RecommendationEngine : il les alimente une fois, puis
        // getRecommendation() reprend la main normalement.
        //
        //   PlacementEngine → notionProgress (recordNotionAttempt / seedInferredMastery) →
        //   MasteryEngine → WeaknessEngine → RecommendationEngine → "🎯 Pour toi maintenant"
        //
        // Deux façons d'alimenter notionProgress, jamais un troisième champ/système :
        //  1. Notion réellement testée : on pose une VRAIE question (réutilise l'écran d'exercice
        //     existant) et recordNotionAttempt() est appelé avec la vraie réponse — rien n'est
        //     inventé, c'est le même chemin qu'un exercice normal.
        //  2. Notion "sautée" parce qu'un niveau déclaré/externe avance le point de départ :
        //     seedInferredMastery() écrit un attempts/correct qui, via LA MÊME formule de
        //     computeNotionMastery, tombe pile sur mastery 3 ("entraînée") — assez pour débloquer
        //     la suite (isNotionUnlocked exige mastery >= 3), jamais "maîtrisée" : les exercices
        //     normaux devront encore la pousser vers 4 puis 5.
        const PLACEMENT_SKILL_LABELS = {
            grammaire: 'Grammaire', vocabulaire: 'Vocabulaire', production: 'Production',
            expression_orale: 'Expression orale', expression_ecrite: 'Expression écrite',
            interaction: 'Interaction', comprehension: 'Compréhension', ecriture: 'Écriture',
            comprehension_ecrite: 'Compréhension écrite', comprehension_orale: 'Compréhension orale',
            registre: 'Registre'
        };
        const PLACEMENT_MAX_QUESTIONS = 40; // garde-fou : jamais un test interminable

        let placementState = null;

        function seedInferredMastery(notionId, force) {
            const p = ntProgress(notionId);
            // ne jamais écraser une vraie donnée déjà présente — sauf déclaration EXPLICITE de
            // l'utilisateur lui-même (voir markNotionAsKnown), jamais une inférence automatique
            if (p.attempts > 0 && !force) return;
            p.opened = true;
            p.attempts = 2;
            p.correct = 1;
            p.weaknessCount = 0;
            p.lastResult = 'inferred';
            p.lastAttemptAt = Date.now();
            save();
        }

        // Applique la plage de seed différée (niveaux avant le point de départ déclaré/externe),
        // UNE FOIS que la toute première vraie vérification l'a confirmée (voir
        // placementHandleModuleVerdict). Tant que cette fonction n'a pas été appelée, aucun niveau
        // sauté n'est marqué acquis — c'est le garde-fou contre le déclassement/sur-classement
        // injustifié d'un niveau simplement déclaré.
        function placementApplyPendingSeed() {
            if (!placementState || !placementState.pendingSeedRange) return;
            const [from, to] = placementState.pendingSeedRange;
            for (let i = from; i < to; i++) {
                (placementState.modules[i].notions || []).forEach(nid => {
                    if (curriculumNotions[nid] && curriculumNotions[nid].status === 'pret') seedInferredMastery(nid);
                });
            }
            placementState.pendingSeedRange = null;
        }

        function placementOrderedModules() {
            return [...curriculumModules].sort((a, b) => {
                const la = curriculumLevels.find(l => l.id === a.level);
                const lb = curriculumLevels.find(l => l.id === b.level);
                const lo = (la ? la.order : 0) - (lb ? lb.order : 0);
                return lo !== 0 ? lo : a.order - b.order;
            });
        }

        function showPlacementIntro() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('placement-view').classList.add('active');
            setActiveNav('nav-profil');
            const hasProgress = curriculumLoaded && Object.values(state.curriculum.notionProgress).some(p => p.attempts > 0);
            const hasHistory = (state.placement.history || []).length > 0;
            document.getElementById('placement-content').innerHTML = `
                <div class="placement-intro">
                    <div class="placement-intro-title">Déjà un niveau en néerlandais ?</div>
                    <p class="placement-intro-text">Ne recommence pas depuis le début. NL Mastery va identifier ce que tu maîtrises déjà et trouver où tu dois vraiment progresser.</p>
                    ${(hasProgress || hasHistory) ? `<div class="placement-warning">Tu as déjà une progression. Une nouvelle évaluation peut ajuster ton parcours, mais ne supprimera pas tes acquis.</div>` : ''}
                    <div class="placement-choice-list">
                        <button class="btn btn-green" onclick="placementStart('test')">🚀 Évaluer mon niveau</button>
                        <button class="gemini-explain-btn" onclick="placementShowDeclare()">📊 J'ai déjà un niveau</button>
                        <button class="gemini-explain-btn" onclick="placementShowExternal()">🏅 J'ai déjà passé un test ailleurs</button>
                        <button class="dash-reco-btn-secondary" style="color:var(--text-secondary); border-color:var(--border);" onclick="showHome()">▶️ Commencer normalement</button>
                    </div>
                </div>`;
        }

        function placementShowDeclare() {
            document.getElementById('placement-content').innerHTML = `
                <div class="placement-intro">
                    <div class="placement-intro-title">Quel niveau penses-tu avoir ?</div>
                    <p class="placement-intro-text">On vérifie quand même avec quelques questions — ça ne veut pas dire qu'on va tout te faire refaire depuis A1.</p>
                    <div class="placement-choice-list">
                        ${curriculumLevels.map(l => `<button class="gemini-explain-btn" onclick="placementStart('declared','${l.id}')">${l.id} — ${l.label}</button>`).join('')}
                    </div>
                    <button class="back-btn" style="margin-top:12px;" onclick="showPlacementIntro()">← Retour</button>
                </div>`;
        }

        function placementShowExternal() {
            document.getElementById('placement-content').innerHTML = `
                <div class="placement-intro">
                    <div class="placement-intro-title">Résultat d'un test externe</div>
                    <p class="placement-intro-text">Indique la source et le niveau obtenu. C'est une information de départ, pas une preuve de maîtrise — on vérifie quand même avec quelques questions.</p>
                    <select id="placement-ext-source" style="width:100%; max-width:320px; margin-bottom:10px;">
                        <option value="Duolingo">Duolingo</option>
                        <option value="Babbel">Babbel</option>
                        <option value="Certificat CECR">Certificat / test CECR officiel</option>
                        <option value="Autre">Autre</option>
                    </select>
                    <select id="placement-ext-level" style="width:100%; max-width:320px; margin-bottom:14px;">
                        ${curriculumLevels.map(l => `<option value="${l.id}">${l.id} — ${l.label}</option>`).join('')}
                    </select>
                    <button class="btn btn-green" onclick="placementConfirmExternal()">Continuer</button>
                    <button class="back-btn" style="margin-top:12px;" onclick="showPlacementIntro()">← Retour</button>
                </div>`;
        }

        function placementConfirmExternal() {
            const source = document.getElementById('placement-ext-source').value;
            const level = document.getElementById('placement-ext-level').value;
            placementStart('external', level, source);
        }

        function placementStart(mode, anchorLevel, externalSource) {
            const modulesSorted = placementOrderedModules();
            let startIdx = 0;
            if (mode !== 'test') {
                // Point de départ = le niveau juste avant celui déclaré/externe, pour vérifier
                // rapidement quelques compétences du niveau précédent plutôt que de plonger
                // directement dedans sans aucune vérification (cf. cahier des charges).
                const anchorOrder = (curriculumLevels.find(l => l.id === anchorLevel) || {}).order || 1;
                const priorLevel = curriculumLevels.find(l => l.order === anchorOrder - 1);
                const effectiveAnchor = priorLevel ? priorLevel.id : anchorLevel;
                startIdx = modulesSorted.findIndex(m => m.level === effectiveAnchor);
                if (startIdx < 0) startIdx = 0;
            }
            // Tout ce qui précède le point de départ SERAIT traité comme un prérequis supposé
            // acquis — mais un niveau déclaré/externe ne vaut jamais preuve de maîtrise tant que la
            // toute première vraie vérification ne l'a pas confirmé. On ne seed donc PAS ici : on
            // mémorise seulement la plage à seeder plus tard (placementApplyPendingSeed), appliquée
            // uniquement si ce premier vrai test réussit (voir placementHandleModuleVerdict). En cas
            // d'échec, l'hypothèse est abandonnée et le test reprend depuis le vrai début du programme.
            placementState = {
                active: true, mode, anchorLevel: anchorLevel || null, externalSource: externalSource || null,
                modules: modulesSorted, moduleIdx: startIdx, anchorModuleIdx: startIdx,
                pendingSeedRange: (mode !== 'test' && startIdx > 0) ? [0, startIdx] : null,
                currentNotionId: null, currentExercise: null, currentAttemptsOnNotion: 0,
                moduleFailedNotion: null, askedCount: 0,
                levelStats: {}, skillStats: {}, testedNotionIds: []
            };
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('placement-view').classList.add('active');
            placementNextStep();
        }

        function placementPickNotionForModule(mod) {
            // Une notion représentative par module : la première prête et pas déjà testée dans ce
            // passage de placement (voir "ne pas tester chaque notion" du cahier des charges).
            const candidates = (mod.notions || []).filter(nid => {
                const n = curriculumNotions[nid];
                return n && n.status === 'pret' && !placementState.testedNotionIds.includes(nid);
            });
            return candidates[0] || null;
        }

        function placementExercisesFor(notionId, attemptIdx) {
            const notion = curriculumNotions[notionId];
            const exs = (notion.exerciseIds || []).map(id => curriculumExercises.find(e => e.id === id)).filter(Boolean);
            if (!exs.length) return null;
            // 1er essai : de préférence un QCM (reconnaissance, rapide) ; en cas de doute, 2e essai
            // sur un type différent (texte à trous / remise en ordre) pour ne pas conclure sur un
            // seul format (cf. "reconnaissance → compréhension → discrimination → construction").
            const preferredOrder = attemptIdx === 0 ? ['qcm', 'texte_a_trous', 'remise_en_ordre'] : ['texte_a_trous', 'remise_en_ordre', 'qcm'];
            for (const type of preferredOrder) {
                const match = exs.find(e => e.type === type);
                if (match) return match;
            }
            return exs[0];
        }

        function placementNextStep() {
            if (!placementState) return;
            if (placementState.askedCount >= PLACEMENT_MAX_QUESTIONS || placementState.moduleIdx >= placementState.modules.length) {
                placementFinish();
                return;
            }
            const mod = placementState.modules[placementState.moduleIdx];
            const notionId = placementPickNotionForModule(mod);
            if (!notionId) {
                // Module pas encore rédigé, ou déjà couvert : module suivant.
                placementState.moduleIdx++;
                placementState.moduleFailedNotion = null;
                placementNextStep();
                return;
            }
            placementState.currentNotionId = notionId;
            placementState.currentAttemptsOnNotion = 0;
            placementAskExercise(notionId);
        }

        // Pose une vraie question en réutilisant intégralement l'écran d'exercice existant
        // (#exercise-view / renderCurrentExercise / checkExerciseAnswer) : aucun composant de
        // question n'est recréé. checkExerciseAnswer() appelle déjà recordNotionAttempt() avec la
        // vraie réponse ; nextExercise() route vers placementAfterAnswer() quand placementState est
        // actif (voir plus bas) au lieu du comportement normal de fin de file d'exercices.
        function placementAskExercise(notionId, forcedExercise) {
            const ex = forcedExercise || placementExercisesFor(notionId, placementState.currentAttemptsOnNotion);
            if (!ex) {
                // Notion sans exercice exploitable : on la saute proprement plutôt que de bloquer
                // le test (ne devrait pas arriver, chaque notion "prête" a au moins un exercice).
                placementState.testedNotionIds.push(notionId);
                placementHandleModuleVerdict(notionId, true);
                return;
            }
            placementState.currentExercise = ex;
            placementState.askedCount++;
            exerciseQueue = [ex];
            exerciseIndex = 0;
            const backBtn = document.getElementById('exercise-back-btn');
            backBtn.onclick = () => placementQuit();
            backBtn.innerText = "✕ Arrêter l'évaluation";
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('exercise-view').classList.add('active');
            renderCurrentExercise();
        }

        function placementTrackStats(notionId, isCorrect) {
            const notion = curriculumNotions[notionId];
            const lvl = notion.level;
            if (!placementState.levelStats[lvl]) placementState.levelStats[lvl] = { correct: 0, total: 0 };
            placementState.levelStats[lvl].total++;
            if (isCorrect) placementState.levelStats[lvl].correct++;
            (notion.skills || []).forEach(sk => {
                if (!placementState.skillStats[sk]) placementState.skillStats[sk] = { correct: 0, total: 0 };
                placementState.skillStats[sk].total++;
                if (isCorrect) placementState.skillStats[sk].correct++;
            });
        }

        function placementAdvanceToNextModule() {
            placementState.moduleIdx++;
            placementState.moduleFailedNotion = null;
            placementNextStep();
        }

        // Distingue une faiblesse isolée d'un vrai plafond de niveau : un seul échec ne suffit
        // jamais à arrêter le test (cf. garde-fou "ne pas fausser le déclassement" déjà appliqué
        // dans WeaknessEngine) — on redemande une 2e notion du même module avant de conclure.
        function placementHandleModuleVerdict(notionId, wasCorrect) {
            // Ce verdict porte-t-il sur le tout premier module réellement testé, alors qu'une plage
            // de niveaux précédente est en attente de seed (niveau déclaré/externe) ? Si oui, ce
            // verdict est ce qui confirme — ou infirme — l'hypothèse, jamais un fait déjà acquis.
            const isAnchorVerdict = !!placementState.pendingSeedRange && placementState.moduleIdx === placementState.anchorModuleIdx;
            if (wasCorrect) {
                if (isAnchorVerdict) placementApplyPendingSeed();
                placementAdvanceToNextModule();
                return;
            }
            if (!placementState.moduleFailedNotion) {
                placementState.moduleFailedNotion = notionId;
                const mod = placementState.modules[placementState.moduleIdx];
                const second = placementPickNotionForModule(mod);
                if (second) {
                    placementState.currentNotionId = second;
                    placementState.currentAttemptsOnNotion = 0;
                    placementAskExercise(second);
                    return;
                }
            }
            // 2e notion aussi ratée, ou aucune 2e notion disponible pour trancher.
            if (isAnchorVerdict) {
                // Le niveau déclaré/externe ne se confirme pas dès la première vraie vérification :
                // on abandonne l'hypothèse (rien n'est seedé) et on reprend le test depuis le vrai
                // début du programme, conformément au principe "un niveau déclaré ou externe ne doit
                // jamais être considéré comme une maîtrise complète".
                placementState.pendingSeedRange = null;
                placementState.moduleIdx = 0;
                placementState.anchorModuleIdx = 0;
                placementState.moduleFailedNotion = null;
                placementNextStep();
                return;
            }
            // Ce module devient la frontière du placement : on arrête d'avancer plus loin dans le programme.
            placementFinish();
        }

        function placementAfterAnswer() {
            const notionId = placementState.currentNotionId;
            const p = state.curriculum.notionProgress[notionId];
            const wasCorrect = !!(p && p.lastResult === 'correct');
            placementState.currentAttemptsOnNotion++;

            if (!wasCorrect && placementState.currentAttemptsOnNotion < 2) {
                const altEx = placementExercisesFor(notionId, 1);
                if (altEx && (!placementState.currentExercise || altEx.id !== placementState.currentExercise.id)) {
                    placementAskExercise(notionId, altEx);
                    return;
                }
            }
            // Verdict définitif pour cette notion (1 ou 2 essais épuisés) : on relit lastResult
            // après le dernier essai réel.
            const finalP = state.curriculum.notionProgress[notionId];
            const finalCorrect = !!(finalP && finalP.lastResult === 'correct');
            placementState.testedNotionIds.push(notionId);
            placementTrackStats(notionId, finalCorrect);
            placementHandleModuleVerdict(notionId, finalCorrect);
        }

        function placementQuit() {
            if (!confirm("Arrêter l'évaluation ? Ce qui a déjà été identifié reste enregistré.")) return;
            clearTimeout(exerciseAutoAdvanceTimer);
            placementState = null;
            const backBtn = document.getElementById('exercise-back-btn');
            if (backBtn) backBtn.innerText = '← Retour à la leçon';
            showHome();
        }

        function placementFinish() {
            if (!placementState) return;
            placementState.active = false;
            const levelOrder = curriculumLevels.map(l => l.id);

            // Niveau estimé : le dernier niveau CECR dont au moins une notion testée a été
            // confirmée avec une accuracy suffisante.
            let estimatedLevel = levelOrder[0];
            levelOrder.forEach(lvl => {
                const s = placementState.levelStats[lvl];
                if (s && s.total > 0 && s.correct / s.total >= 0.5) estimatedLevel = lvl;
            });

            const testedCount = placementState.testedNotionIds.length;
            const confidence = testedCount >= 6 ? 'élevée' : testedCount >= 3 ? 'moyenne' : 'faible';

            const perLevelPct = {};
            levelOrder.forEach(lvl => {
                const lvlModIdx = placementState.modules.findIndex(m => m.level === lvl);
                const s = placementState.levelStats[lvl];
                if (s && s.total > 0) {
                    perLevelPct[lvl] = Math.round((s.correct / s.total) * 100);
                } else if (lvlModIdx >= 0 && lvlModIdx < placementState.moduleIdx) {
                    perLevelPct[lvl] = 95; // niveau entièrement sauté avant le point de départ : supposé largement acquis
                } else {
                    perLevelPct[lvl] = 0; // jamais atteint : exploration future
                }
            });

            const perSkillPct = {};
            Object.keys(placementState.skillStats).forEach(sk => {
                const s = placementState.skillStats[sk];
                if (s.total > 0) perSkillPct[sk] = Math.round((s.correct / s.total) * 100);
            });

            state.placement.history.push({
                timestamp: Date.now(), mode: placementState.mode, anchorLevel: placementState.anchorLevel,
                externalSource: placementState.externalSource, estimatedLevel, confidence, testedCount,
                perLevelPct, perSkillPct
            });
            save();

            placementRenderResult(estimatedLevel, confidence, perLevelPct, perSkillPct);
        }

        function placementRenderResult(estimatedLevel, confidence, perLevelPct, perSkillPct) {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('placement-view').classList.add('active');
            const levelBarsHtml = curriculumLevels.map(l => `
                <div class="placement-level-row">
                    <span class="placement-level-name">${l.id}</span>
                    <div class="module-progress-bar"><div class="module-progress-fill" style="width:${perLevelPct[l.id] || 0}%"></div></div>
                    <span class="module-progress-pct">${perLevelPct[l.id] || 0}%</span>
                </div>`).join('');
            const skillKeys = Object.keys(perSkillPct);
            const skillBarsHtml = skillKeys.map(sk => `
                <div class="placement-level-row">
                    <span class="placement-level-name">${PLACEMENT_SKILL_LABELS[sk] || sk}</span>
                    <div class="module-progress-bar"><div class="module-progress-fill" style="width:${perSkillPct[sk]}%"></div></div>
                    <span class="module-progress-pct">${perSkillPct[sk]}%</span>
                </div>`).join('');

            document.getElementById('placement-content').innerHTML = `
                <div class="placement-intro">
                    <div class="placement-intro-title">🎯 Ton parcours est prêt</div>
                    <p class="placement-intro-text">Niveau estimé : <b>${estimatedLevel}</b> · confiance ${confidence}</p>
                    <div class="section-title" style="margin-top:var(--space-4);">Ton profil par niveau</div>
                    ${levelBarsHtml}
                    ${skillBarsHtml ? `<div class="section-title" style="margin-top:var(--space-4);">Ce qu'on a pu observer</div>${skillBarsHtml}` : ''}
                    <button class="btn btn-green" style="margin-top:var(--space-5);" onclick="placementGoToApp()">Commencer mon parcours →</button>
                </div>`;
        }

        function placementGoToApp() {
            placementState = null;
            const backBtn = document.getElementById('exercise-back-btn');
            if (backBtn) backBtn.innerText = '← Retour à la leçon';
            showHome();
        }

        // Vrai compte neuf : aucune notion jamais tentée, aucun historique de placement. Utilisé à
        // la fois par le nudge du dashboard et par l'onboarding — un seul et même critère.
        function isBrandNewUser() {
            return curriculumLoaded
                && Object.values(state.curriculum.notionProgress).every(p => !p.attempts)
                && !(state.placement.history || []).length;
        }

        // ===== Portes d'entrée "Qu'est-ce que tu veux faire ?" qui n'ont pas déjà une vue dédiée =====
        // Toutes deux ne font que relire getRecommendation() (RecommendationEngine, inchangé) pour
        // choisir une cible parmi les vues déjà existantes — aucune nouvelle logique de choix.
        function enterModeEntrainer() {
            const rec = curriculumLoaded ? getRecommendation() : null;
            if (rec) showExercise(rec.notionId); else showApprendre();
        }

        function enterModeChoisir() {
            const rec = curriculumLoaded ? getRecommendation() : null;
            if (rec) startRecommendedActivity(rec.notionId); else showApprendre();
        }

        // ===== Apprendre → "🆕 Nouvelle notion" =====
        // Simple porte UX vers RecommendationEngine, identique à enterModeChoisir() (même moteur,
        // même comportement) : on ne crée pas un deuxième "quoi étudier ensuite", on réutilise
        // exactement la même suggestion que "🎯 Pour toi maintenant" sur l'accueil.
        function apprendreNouvelleNotion() {
            enterModeChoisir();
        }

        // ===== Onboarding (court, skippable) =====
        // Une seule page, pas 10-15 écrans : présentation courte + les 6 façons d'utiliser l'appli +
        // 2 choix terminaux (évaluer son niveau via le Placement Engine déjà existant, ou commencer
        // directement). Ne construit aucun nouveau système, ne fait qu'expliquer puis rediriger.
        function showOnboarding() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('onboarding-view').classList.add('active');
            document.getElementById('onboarding-content').innerHTML = `
                <div class="placement-intro">
                    <div class="placement-intro-title">👋 Bienvenue sur NL Mastery</div>
                    <p class="placement-intro-text">Un vrai programme structuré (A1 → B2) pour apprendre le néerlandais professionnel — pas juste des flashcards à mémoriser.</p>
                    <div class="section-title" style="margin-top:var(--space-4);">Comment utiliser l'appli</div>
                    <div class="intent-grid" style="margin-top:var(--space-2);">
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">📚</div><div class="qa-label">Apprendre</div></div>
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">🔁</div><div class="qa-label">Réviser</div></div>
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">🗣️</div><div class="qa-label">Pratiquer</div></div>
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">👤</div><div class="qa-label">Profil</div></div>
                    </div>
                    <p style="font-size:0.78rem; color:var(--text-secondary); margin-top:var(--space-3);">📚 Les leçons, les mots et la conjugaison · 🔁 Revoir ce que tu as raté, et les jeux · 🗣️ Parler et écrire en situation réelle · 👤 Ta progression et ton compte. L'accueil te propose toujours la prochaine chose à faire.</p>
                    <button class="btn btn-green" style="margin-top:var(--space-5);" onclick="onboardingGoTo('placement')">🚀 Évaluer mon niveau</button>
                    <button class="btn btn-gray" style="margin-top:10px;" onclick="onboardingGoTo('start')">Commencer directement</button>
                    <p style="font-size:0.78rem; margin-top:var(--space-4);">${currentUser ? '' : `<a href="#" onclick="onboardingGoTo('compte'); return false;">Créer un compte pour synchroniser ta progression (optionnel)</a>`}</p>
                </div>`;
        }

        function onboardingMarkSeen() {
            state.onboardingSeen = true;
            save();
        }

        function onboardingGoTo(dest) {
            onboardingMarkSeen();
            if (dest === 'placement') showPlacementIntro();
            else if (dest === 'compte') showCompte();
            else showHome();
        }

        function onboardingFinish() {
            onboardingMarkSeen();
            showHome();
        }

        // ===== Dashboard =====
        // Résumé du module "en cours" pour le petit bloc secondaire "▶️ Continuer" (voir
        // getCurrentModuleProgress). Ne crée aucun nouvel état : relit simplement
        // curriculumModules/curriculumNotions + getNotionStatus/isNotionUnlocked déjà existants,
        // pour trouver le premier module non entièrement maîtrisé sur lequel l'utilisateur a accès.
        function getCurrentModuleProgress() {
            if (!curriculumLoaded) return null;
            const modulesSorted = [...curriculumModules].sort((a, b) => {
                const la = curriculumLevels.find(l => l.id === a.level);
                const lb = curriculumLevels.find(l => l.id === b.level);
                const lo = (la ? la.order : 0) - (lb ? lb.order : 0);
                return lo !== 0 ? lo : a.order - b.order;
            });
            for (const mod of modulesSorted) {
                const readyIds = (mod.notions || []).filter(nid => curriculumNotions[nid] && curriculumNotions[nid].status === 'pret');
                if (!readyIds.length) continue;
                const masteredCount = readyIds.filter(nid => getNotionStatus(nid) === 'maitrisee').length;
                const workedCount = readyIds.filter(nid => computeNotionMastery(nid) >= 1).length;
                const hasUnlocked = readyIds.some(nid => isNotionUnlocked(nid));
                if (masteredCount < readyIds.length && hasUnlocked) {
                    return { module: mod, workedCount, total: readyIds.length, masteredCount };
                }
            }
            return null;
        }

        function continueCurrentModule(levelId) {
            showApprendre();
            renderApprendreLevel(levelId);
        }

        function renderDashboard() {
            const block = document.getElementById('dashboard-block');
            if (!block) return;
            const vp = getVocabProgress();
            const reviewCount = getReviewItems().length;

            // ===== 0. Première utilisation : proposer l'évaluation avant de plonger en A1.01 =====
            // Ne s'affiche que pour un compte réellement neuf (aucune notion jamais tentée, aucun
            // historique de placement) — dès la première vraie réponse, ce bloc disparaît de
            // lui-même au prochain rendu.
            // ===== -1. Bonjour / état actuel =====
            // Première ligne de l'écran : qui es-tu et où en es-tu, avant toute recommandation —
            // pas de nouvelle donnée, juste une phrase construite à partir de ce qui existe déjà
            // (pseudo du compte, streak).
            const greetName = currentUserDoc && currentUserDoc.pseudo ? currentUserDoc.pseudo : '';
            const streak = (state.stats && state.stats.dailyStreak) || 0;
            const greetStateLine = streak > 1
                ? `🔥 ${streak} jours de suite — continue comme ça !`
                : "Prêt(e) à continuer ton apprentissage du néerlandais ?";

            const isBrandNew = isBrandNewUser();
            const placementNudgeHtml = isBrandNew ? `
                <div class="dash-card dash-secondary-card" style="cursor:default;">
                    <div class="dash-secondary-label">👋 Nouveau ici</div>
                    <div class="dash-secondary-title">Découvre comment utiliser NL Mastery</div>
                    <div class="dash-secondary-sub" style="margin-bottom:10px;">Présentation courte, puis on identifie ce que tu maîtrises déjà pour ne pas te faire recommencer depuis zéro.</div>
                    <button class="btn btn-green" style="margin-top:0;" onclick="showOnboarding()">👋 Découvrir NL Mastery</button>
                </div>` : '';

            // ===== 0bis. Compte non créé : visible dès l'accueil (pas seulement enfoui dans Profil)
            // — sans ça, un nouvel utilisateur n'a aucune raison de deviner que "Compte" (menu Profil)
            // sert à sauvegarder sa progression et à pouvoir ajouter des amis ensuite.
            // Une ligne discrète en bas d'écran plutôt qu'une carte entière au-dessus de l'action
            // principale : l'information reste visible sans concurrencer "Commencer".
            const accountNudgeHtml = !currentUser ? `
                <div class="dash-footnote" onclick="showCompte()">🔓 Progression enregistrée sur cet appareil seulement — <u>créer un compte gratuit</u></div>` : '';

            // ===== 1. Bloc dominant : "🎯 Pour toi maintenant" (mode "professeur") =====
            let recoHtml = '';
            if (curriculumLoaded) {
                const rec = getRecommendation();
                if (rec) {
                    const activity = getRecommendedActivityMeta(getNotionStatus(rec.notionId));
                    const titre = rec.notion.content.titre || rec.notionId;
                    recoHtml = `
                        <div class="dash-card dash-continue-card dash-reco-card">
                            <div class="dash-continue-label">🎯 Pour toi maintenant</div>
                            <div class="dash-reco-titre">${rec.notion.level} · ${titre}</div>
                            <div class="dash-continue-title">${activity.icon} ${activity.label}</div>
                            <div class="dash-reco-reason">${rec.reason || ''}</div>
                            ${activity.duration ? `<div class="dash-reco-duration">${activity.duration}</div>` : ''}
                            <div class="dash-reco-actions">
                                <button class="btn btn-green" onclick="startRecommendedActivity('${rec.notionId}')">Commencer</button>
                                <button class="dash-reco-btn-secondary" onclick="showApprendre()">Choisir autre chose</button>
                            </div>
                        </div>`;
                } else {
                    recoHtml = `<div class="dash-card dash-continue-card" style="text-align:center;">Toutes les leçons disponibles sont maîtrisées pour l'instant — d'autres arrivent bientôt 🎉</div>`;
                }
            }

            // ===== 2. Progression : niveau CECR réel (curriculum), vocabulaire affiché à part =====
            const masteredCount = curriculumLoaded
                ? Object.keys(curriculumNotions).filter(id => curriculumNotions[id].status === 'pret' && getNotionStatus(id) === 'maitrisee').length
                : 0;
            const totalReadyCount = curriculumLoaded
                ? Object.keys(curriculumNotions).filter(id => curriculumNotions[id].status === 'pret').length
                : 0;
            const cecrInfo = curriculumLoaded ? getCurriculumLevel() : { level: 'A1' };
            const cecrPct = totalReadyCount ? Math.round((masteredCount / totalReadyCount) * 100) : 0;
            // En-tête unique : bonjour, série de jours, niveau et progression sur une seule carte
            // compacte (avant : une carte "Bonjour" en haut et une carte "Ta progression" en bas).
            const headerHtml = `
                <div class="dash-card dash-header-card">
                    <div class="dash-header-top">
                        <div>
                            <div style="font-size:1.05rem; font-weight:700;">${greetName ? `Bonjour ${greetName} 👋` : 'Bonjour 👋'}</div>
                            <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px;">${greetStateLine}</div>
                        </div>
                        <span class="dash-level-badge">${cecrInfo.level}</span>
                    </div>
                    <div class="dash-progress-bar"><div class="dash-progress-fill" style="width:${cecrPct}%"></div></div>
                    ${curriculumLoaded ? `<div style="font-size:0.76rem; color:var(--text-secondary); margin-top:6px;">${masteredCount}/${totalReadyCount} notions maîtrisées · vocabulaire couvert ${vp.pct}%</div>` : ''}
                </div>`;

            // ===== 3. Raccourcis secondaires, discrets, sous l'action principale =====
            // Remplace la grille "Qu'est-ce que tu veux faire maintenant ?" (8 boutons qui
            // doublaient la barre d'onglets du bas) : il ne reste que ce qui dépend de TA
            // situation — reprendre ton module en cours, et réviser s'il y a quelque chose à revoir.
            const curMod = getCurrentModuleProgress();
            const linksHtml = (curMod || reviewCount > 0) ? `
                <div class="dash-links-row">
                    ${curMod ? `<button type="button" class="dash-link-chip" onclick="continueCurrentModule('${curMod.module.level}')">▶️ Reprendre ${curMod.module.level} · ${curMod.module.label} <span>${curMod.workedCount}/${curMod.total}</span></button>` : ''}
                    ${reviewCount > 0 ? `<button type="button" class="dash-link-chip" onclick="showReviser()">🔁 ${reviewCount} mot${reviewCount > 1 ? 's' : ''} à réviser</button>` : ''}
                </div>` : '';

            // ===== 5. À revoir (optionnel, court) =====
            const weaknesses = curriculumLoaded ? getWeaknesses().slice(0, 3) : [];
            const weakHtml = weaknesses.length ? weaknesses.map(w => `
                <div class="dash-weak-row" style="cursor:pointer;" onclick="showLesson('${w.id}')">
                    <span>${getNotionStatusLabel(w.status)} — ${(w.notion.content.titre || w.id.replace(/_/g, ' '))}</span>
                    <div class="dash-mini-bar"><div class="dash-mini-fill" style="width:${w.mastery * 20}%"></div></div>
                </div>`).join('') : '';

            // ===== 6. Social (secondaire, discret — ne doit jamais passer devant l'apprentissage) =====
            // Chargé de façon asynchrone (voir loadSocialDashboardSnippet) pour ne jamais retarder le
            // premier rendu ; tant que le cache est vide on ne montre rien (pas de placeholder qui
            // clignote), et on relance le chargement une seule fois par session.
            let socialHtml = '';
            if (currentUser && socialDashboardCache && socialDashboardCache.friendCount > 0) {
                socialHtml = `
                    <div class="dash-card dash-secondary-card" style="cursor:pointer;" onclick="showSocial()">
                        <div class="dash-secondary-label">👥 Avec tes amis</div>
                        ${socialDashboardCache.lines.length
                            ? socialDashboardCache.lines.map(l => `<div class="dash-secondary-sub">${l}</div>`).join('')
                            : `<div class="dash-secondary-sub">${socialDashboardCache.friendCount} ami${socialDashboardCache.friendCount > 1 ? 's' : ''} — voir leur progression</div>`}
                    </div>`;
            }
            if (currentUser && socialDashboardCache === null) loadSocialDashboardSnippet();

            // Accueil volontairement court : où tu en es, UNE action évidente, puis le reste en
            // retrait. La navigation générale est assurée par la barre d'onglets, pas par l'accueil.
            block.innerHTML = `
                ${headerHtml}
                ${placementNudgeHtml}
                ${recoHtml}
                ${linksHtml}
                ${weakHtml ? `<div class="dash-card">
                    <h3 style="margin:0 0 10px; font-size:0.9rem;">À revoir</h3>
                    ${weakHtml}
                </div>` : ''}
                ${socialHtml}
                ${accountNudgeHtml}`;
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
                const readyNotionIds = mod.notions.filter(nid => curriculumNotions[nid] && curriculumNotions[nid].status === 'pret');
                const masteredInModule = readyNotionIds.filter(nid => getNotionStatus(nid) === 'maitrisee').length;
                const modPct = readyNotionIds.length ? Math.round((masteredInModule / readyNotionIds.length) * 100) : 0;

                const rows = mod.notions.map(nid => {
                    const notion = curriculumNotions[nid];
                    if (!notion) return '';
                    const ready = notion.status === 'pret';
                    const unlocked = ready && isNotionUnlocked(nid);
                    const label = (ready && notion.content && notion.content.titre) ? notion.content.titre : nid.replace(/_/g, ' ');

                    // Traduction en 5 états compréhensibles pour l'utilisateur (la donnée 0-5 et les
                    // 7 statuts internes de WeaknessEngine restent inchangés en dessous — ceci est
                    // uniquement une lecture simplifiée pour l'écran Apprendre).
                    let emoji, statusLabel, statusClass;
                    if (!ready) {
                        emoji = '○'; statusLabel = 'à venir'; statusClass = 'st-pending';
                    } else if (!unlocked) {
                        emoji = '🔒'; statusLabel = 'Verrouillée'; statusClass = 'st-pending';
                    } else {
                        const status = getNotionStatus(nid);
                        if (status === 'maitrisee') { emoji = '✓'; statusLabel = 'Maîtrisée'; statusClass = 'st-maitrisee'; }
                        else if (status === 'a_pratiquer' || status === 'entrainee' || status === 'presque_maitrisee') { emoji = '●'; statusLabel = 'À pratiquer'; statusClass = 'st-a_pratiquer'; }
                        else if (status === 'jamais_etudiee') { emoji = '○'; statusLabel = 'À découvrir'; statusClass = 'st-jamais_etudiee'; }
                        else { emoji = '◐'; statusLabel = 'En cours'; statusClass = 'st-en_cours'; }
                    }

                    const clickAttr = (ready && unlocked) ? `onclick="showLesson('${nid}')"` : '';
                    return `<div class="notion-row ${(!ready || !unlocked) ? 'locked' : ''}" ${clickAttr}>
                        <span class="notion-emoji">${emoji}</span>
                        <span class="notion-label">${label}</span>
                        <span class="notion-status ${statusClass}">${statusLabel}</span>
                    </div>`;
                }).join('');

                return `<div class="module-card">
                    <div class="module-card-head">
                        <span class="module-card-num">Module ${mod.order}</span>
                    </div>
                    <div class="module-card-title">${mod.label}</div>
                    ${readyNotionIds.length ? `<div class="module-progress-row">
                        <div class="module-progress-bar"><div class="module-progress-fill" style="width:${modPct}%"></div></div>
                        <span class="module-progress-pct">${modPct}%</span>
                    </div>` : ''}
                    ${rows}
                </div>`;
            }).join('');
        }

        // ===== Vue Leçon =====
        let currentLessonNotionId = null;

        function showLesson(notionId) {
            clearTimeout(exerciseAutoAdvanceTimer);
            currentLessonNotionId = notionId;
            const notion = curriculumNotions[notionId];
            if (!notion || !notion.content) return;
            ntProgress(notionId).opened = true;
            save();

            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('lesson-view').classList.add('active');
            // On repart d'un bandeau vide à chaque (ré)ouverture de leçon ; il n'est repeuplé que
            // par renderGuidedFlowCompletion(), juste après, quand une activité du flux guidé vient
            // de se terminer.
            const guidedBanner = document.getElementById('guided-flow-banner');
            if (guidedBanner) guidedBanner.innerHTML = '';

            const c = notion.content;
            const exCount = (notion.exerciseIds || []).length;
            const mastery = computeNotionMastery(notionId);
            const rpSuggestion = mastery >= 4 ? getRoleplaySuggestion(notionId) : null;
            const mod = curriculumModules.find(m => m.id === notion.module);
            const masteryDots = Array.from({ length: 5 }, (_, i) => `<span class="mastery-dot ${i < mastery ? 'filled' : ''}"></span>`).join('');
            const hasFriction = c.contrastes || (c.erreursFrequentes && c.erreursFrequentes.length);
            document.getElementById('lesson-content').innerHTML = `
                <div class="lesson-header">
                    <div class="lesson-breadcrumb">${notion.level}${mod ? ' · ' + mod.label : ''}</div>
                    ${c.titre ? `<div class="lesson-titre">${c.titre}</div>` : ''}
                </div>
                <div class="lesson-stage">
                    <div class="lesson-stage-label">🎯 Objectif</div>
                    <div class="lesson-block"><p>${c.objectif || ''}</p></div>
                </div>
                <div class="lesson-stage">
                    <div class="lesson-stage-label">📖 Comprendre</div>
                    <div class="lesson-block"><p>${c.comprendre || ''}</p></div>
                    ${c.regle ? `<div class="lesson-block"><p>${c.regle}</p></div>` : ''}
                </div>
                <div class="lesson-stage">
                    <div class="lesson-stage-label">👀 Exemple</div>
                    <div class="lesson-block">${(c.exemples || []).map(ex => `<div class="lesson-example">${ex} ${speakBtnHtml(ex)}${translateBtnHtml(ex)}</div>`).join('')}</div>
                </div>
                ${hasFriction ? `<div class="lesson-stage">
                    <div class="lesson-stage-label">⚠️ Point de friction</div>
                    ${c.contrastes ? `<div class="lesson-block lesson-contrastes"><p>${c.contrastes}</p></div>` : ''}
                    ${(c.erreursFrequentes && c.erreursFrequentes.length) ? `<div class="lesson-block">${c.erreursFrequentes.map(er => `<div class="lesson-error">${er}</div>`).join('')}</div>` : ''}
                    <button class="gemini-explain-btn" onclick="askGeminiExplainOtherwise('${notionId}')">🤖 Explique-moi autrement</button>
                    <div class="gemini-box" id="gemini-explain-box" style="display:none;"></div>
                </div>` : `<div class="lesson-stage">
                    <button class="gemini-explain-btn" onclick="askGeminiExplainOtherwise('${notionId}')">🤖 Explique-moi autrement</button>
                    <div class="gemini-box" id="gemini-explain-box" style="display:none;"></div>
                </div>`}
                <div class="lesson-stage">
                    <div class="lesson-stage-label">💬 Pose ta question</div>
                    <div class="lesson-block" style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:8px;">Une question sur cette notion, ou "comment dit-on ... ?" — réponse en français.</div>
                    <input type="text" id="lesson-question-input" placeholder="Ex : comment dit-on 'réunion' ?" style="width:100%; margin-bottom:8px;" autocomplete="off" onkeypress="if(event.key==='Enter') askGeminiFreeQuestion('${notionId}')">
                    <button class="gemini-explain-btn" onclick="askGeminiFreeQuestion('${notionId}')">💬 Demander</button>
                    <div class="gemini-box" id="gemini-question-box" style="display:none;"></div>
                </div>
                ${exCount ? `<div class="lesson-stage">
                    <div class="lesson-stage-label">🧩 S'entraîner</div>
                    <button class="btn btn-green" onclick="showExercise('${notionId}')">🧩 Commencer les exercices (${exCount})</button>
                </div>` : ''}
                ${c.tacheProduction ? `<div class="lesson-stage">
                    <div class="lesson-stage-label">✍️ Produire</div>
                    ${renderProductionBlock(notionId, c.tacheProduction)}
                </div>` : ''}
                ${(c.objectifCommunication || (c.vocabulaire && c.vocabulaire.length) || rpSuggestion) ? `<div class="lesson-stage">
                    <div class="lesson-stage-label">💬 Utiliser</div>
                    ${c.objectifCommunication ? `<div class="lesson-block"><p>${c.objectifCommunication}</p></div>` : ''}
                    ${(c.vocabulaire && c.vocabulaire.length) ? `<div class="lesson-block"><div class="lesson-vocab-list">${c.vocabulaire.map(v => `<span class="lesson-vocab-item">${v} ${speakBtnHtml(v)}${translateBtnHtml(v)}</span>`).join('')}</div></div>` : ''}
                    ${rpSuggestion ? `<div class="roleplay-suggestion-card" onclick="showRoleplay(); rpShowCategory('${rpSuggestion.category}');">🎙️ Notion maîtrisée ! Envie de pratiquer à l'oral ?<br><b>${rpSuggestion.label}</b></div>` : ''}
                </div>` : ''}
                <div class="lesson-stage">
                    <div class="lesson-stage-label">✅ Maîtrise</div>
                    <div class="lesson-mastery-row">${masteryDots}</div>
                    ${c.criteresMaitrise ? `<div class="lesson-block"><p>${c.criteresMaitrise}</p></div>` : ''}
                    ${mastery < 3 ? `<button class="gemini-explain-btn" onclick="markNotionAsKnown('${notionId}')">✅ Je connais déjà cette notion — passer</button>` : ''}
                </div>
            `;
        }

        // Déclaration explicite "je connais déjà cette notion", pour sauter en avant sans passer
        // par les exercices — réutilise EXACTEMENT le même mécanisme que le Placement Engine
        // (seedInferredMastery avec force=true, voir plus bas) : la notion passe à mastery 3
        // ("entraînée", suffisant pour débloquer la suite via isNotionUnlocked), jamais directement
        // à "maîtrisée" — cohérent avec le principe "une déclaration n'est jamais une preuve
        // complète de maîtrise" déjà appliqué au Placement Engine. Les vrais exercices restent
        // nécessaires ensuite pour progresser vers 4 puis 5.
        function markNotionAsKnown(notionId) {
            const notion = curriculumNotions[notionId];
            if (!notion) return;
            if (computeNotionMastery(notionId) >= 3) return;
            const titre = (notion.content && notion.content.titre) || notionId.replace(/_/g, ' ');
            const ok = confirm(`Marquer "${titre}" comme déjà connue ?\n\nElle passera directement au statut "entraînée" (comme un niveau déclaré au Placement Engine) : ça débloque la suite du programme, mais ce n'est pas encore "maîtrisée" — il faudra encore réussir des exercices pour y arriver.`);
            if (!ok) return;
            seedInferredMastery(notionId, true);
            showLesson(notionId);
            renderDashboard();
        }

        // ===== Production / Feedback (cycle NOTION → ENTRAÎNEMENT → PRODUCTION → FEEDBACK → RÉVISION) =====
        // Réutilise entièrement GeminiService (evaluateProductionWithContext) et le moteur de
        // reconnaissance vocale déjà présent dans le jeu de rôle (voir productionToggleVoiceCapture
        // plus bas, section jeu de rôle). N'introduit ni deuxième service Gemini, ni deuxième
        // système de reconnaissance vocale, ni deuxième moteur de progression.
        function renderProductionBlock(notionId, task) {
            const targeted = NOTION_TARGETED_PRACTICE[notionId];
            return `
                <div class="lesson-block lesson-tache">
                    <h3>✍️ À toi de jouer</h3>
                    <p>${task}</p>
                    <div class="production-actions">
                        <button class="gemini-explain-btn" onclick="openProductionPanel('${notionId}','ecrit')">✍️ Produire (écrit)</button>
                        <button class="gemini-explain-btn" onclick="openProductionPanel('${notionId}','oral')">🎙️ Parler (oral)</button>
                        ${targeted ? `<button class="gemini-explain-btn" onclick="rpStartTargetedPractice('${notionId}')">🎯 Pratique ciblée</button>` : ''}
                    </div>
                    <div id="production-panel" class="production-panel" style="display:none;"></div>
                </div>`;
        }

        function openProductionPanel(notionId, mode) {
            const panel = document.getElementById('production-panel');
            panel.style.display = '';
            if (mode === 'ecrit') {
                panel.innerHTML = `
                    <textarea id="production-text-input" rows="4" placeholder="Schrijf je antwoord in het Nederlands..."></textarea>
                    <button class="btn btn-green" onclick="submitProduction('${notionId}','ecrit')">🤖 Envoyer à Gemini</button>
                    <div id="production-feedback-box" class="gemini-box" style="display:none;"></div>`;
            } else {
                panel.innerHTML = `
                    <button class="btn btn-green" id="production-mic-btn" onclick="toggleProductionRecording('${notionId}')">🎤 Cliquer pour parler</button>
                    <div id="production-status">Prêt</div>
                    <div id="production-transcript" class="production-transcript"></div>
                    <div id="production-feedback-box" class="gemini-box" style="display:none;"></div>`;
            }
        }

        function toggleProductionRecording(notionId) {
            productionToggleVoiceCapture('production-mic-btn', 'production-status', (text) => {
                const transcriptDiv = document.getElementById('production-transcript');
                if (transcriptDiv) transcriptDiv.innerText = text;
                submitProduction(notionId, 'oral', text);
            });
        }

        async function submitProduction(notionId, mode, userTextOverride) {
            const notion = curriculumNotions[notionId];
            const box = document.getElementById('production-feedback-box');
            let userText = userTextOverride;
            if (userText === undefined) {
                const input = document.getElementById('production-text-input');
                userText = input ? input.value.trim() : '';
            }
            if (!userText) { alert("Écris ou dis quelque chose avant d'envoyer."); return; }
            if (!box) return;
            if (!GeminiService.isAvailable()) {
                box.style.display = '';
                box.innerHTML = "Pas de clé API Gemini enregistrée. Ajoute-en une gratuitement depuis Profil → 🤖 Intelligence IA pour activer le feedback.";
                return;
            }
            box.style.display = '';
            box.innerHTML = "L'IA analyse ta production...";
            try {
                const raw = await GeminiService.evaluateProductionWithContext(notion, mode, userText);
                const parsed = parseProductionFeedback(raw);
                box.innerHTML = renderProductionFeedbackHTML(parsed);
                const mapped = recordProductionWeaknessSignals(notionId, mode, parsed.motsCles);
                if (!state.productions) state.productions = [];
                state.productions.push({
                    id: 'prod_' + Date.now(),
                    notionId, mode, userText,
                    feedback: parsed,
                    linkedWeaknesses: mapped,
                    timestamp: Date.now()
                });
                save();
                // Fin d'activité du flux guidé (si cette production a été lancée depuis "Pour toi
                // maintenant") : on propose de recalculer la suite plutôt que de rester bloqué ici.
                renderGuidedFlowCompletion(notionId);
            } catch (e) {
                box.innerHTML = "Erreur Gemini : " + escapeHtml(e.message);
            }
        }

        // ===== Vue Exercice =====
        let exerciseQueue = [];
        let exerciseIndex = 0;
        let exerciseSelectedAnswer = null;
        let exerciseAutoAdvanceTimer = null; // voir checkExerciseAnswer/nextExercise : auto-avance après correction

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
            clearTimeout(exerciseAutoAdvanceTimer);
            const ex = exerciseQueue[exerciseIndex];
            exerciseSelectedAnswer = null;
            document.getElementById('exercise-progress').innerText = (placementState && placementState.active)
                ? `Évaluation de ton niveau — Question ${placementState.askedCount}`
                : `Exercice ${exerciseIndex + 1} / ${exerciseQueue.length}`;
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

        // ===== Mise à jour de notionProgress suite à une vraie réponse (exercice normal OU exercice
        // posé pendant le Placement Engine) =====
        // Point d'entrée UNIQUE vers MasteryEngine/WeaknessEngine pour toute réponse réelle à un
        // exercice de notion : aucune deuxième logique de mise à jour n'existe ailleurs. Extrait tel
        // quel de checkExerciseAnswer (même comportement, mêmes champs) pour que le Placement Engine
        // puisse l'appeler avec de vraies réponses sans dupliquer/réinventer cette logique.
        function recordNotionAttempt(notionId, isCorrect) {
            const p = ntProgress(notionId);
            p.attempts++;
            if (isCorrect) {
                p.correct++;
                // Une réussite fait diminuer progressivement la faiblesse — jamais un reset brutal
                // à 0 : plusieurs notions ont plusieurs exercices, une bonne réponse ne prouve pas
                // à elle seule que l'erreur précédente est totalement résolue.
                p.weaknessCount = Math.max(0, (p.weaknessCount || 0) - 1);
            } else {
                // Une erreur a une conséquence : elle est enregistrée au niveau de la notion (et pas
                // seulement dans le ratio attempts/correct), pour que WeaknessEngine/
                // RecommendationEngine puissent la traiter comme un vrai signal de faiblesse.
                p.weaknessCount = (p.weaknessCount || 0) + 1;
            }
            p.lastResult = isCorrect ? 'correct' : 'incorrect';
            p.lastAttemptAt = Date.now();
            save();
            return p;
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
            recordNotionAttempt(ex.notionId, isCorrect);

            const fb = document.getElementById('exercise-feedback');
            fb.style.color = isCorrect ? 'var(--success)' : 'var(--wrong)';
            // ex.answer est toujours en néerlandais dans exercises.json (qcm/texte_a_trous/remise_en_ordre) — bouton écoute sans risque de dévoiler une traduction dans la mauvaise langue.
            fb.innerHTML = (isCorrect ? `✅ Correct ! → ${expected}` : `❌ Réponse attendue : ${expected}`) + ' ' + speakBtnHtml(expected) + translateBtnHtml(expected);

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
            // Auto-avance : une réponse valide fait déjà connaître l'étape suivante, donc on
            // n'oblige pas un clic "Suivant" en plus (voir cahier UX — réduire les clics
            // inutiles). Le bouton reste affiché et cliquable pour zapper l'attente si
            // l'utilisateur va plus vite ; nextExercise() annule ce minuteur dans ce cas pour ne
            // jamais avancer deux fois.
            exerciseAutoAdvanceTimer = setTimeout(nextExercise, isCorrect ? 1100 : 2200);
        }

        function nextExercise() {
            clearTimeout(exerciseAutoAdvanceTimer);
            exerciseIndex++;
            if (exerciseIndex >= exerciseQueue.length) {
                if (placementState && placementState.active) { placementAfterAnswer(); return; }
                const notionId = exerciseQueue[0].notionId;
                showLesson(notionId);
                renderDashboard();
                // Fin d'activité du flux guidé : on recalcule via getRecommendation() plus tard,
                // seulement si l'utilisateur clique "Continuer" (voir continueGuidedFlow).
                renderGuidedFlowCompletion(notionId);
                return;
            }
            renderCurrentExercise();
        }

        // ===== Catégorisation du vocabulaire (verbes) — pilote de l'architecture proposée par
        // l'utilisateur : catégories/sous-catégories + niveau CECR + fréquence, plutôt qu'une
        // simple liste. Commence par les verbes car c'est le seul type de mot où la sous-
        // catégorisation est en grande partie déjà déductible des données existantes (régulier/
        // irrégulier via le prétérit, particule séparable via isSeparableVerb) plutôt que de
        // demander une relecture sémantique mot par mot comme pour les noms/adjectifs. Chaque
        // verbe peut porter PLUSIEURS étiquettes à la fois (ex: aanbieden = irrégulier + à
        // particule) — choix confirmé avec l'utilisateur plutôt qu'une catégorie unique.
        //
        // Niveau CECR : initialement dérivé uniquement de la fréquence interne (approximation par
        // quintiles), puis REMPLACÉ pour les verbes par de vraies données du NT2Lex (Nederlands
        // Tweede-taal Lexicon, corpus stratifié par niveau CECR réel — CGN + ODWN, KU Leuven) que
        // l'utilisateur a fourni : 312 des 322 verbes ont un niveau directement attesté par corpus
        // (v.niveauCECR + v.niveauCECRSource = "nt2lex" dans conjugation.json), les 10 restants
        // (verbes trop rares ou locutions à plusieurs mots absentes du lexique, ex: "arbeiden",
        // "aanwezig zijn") retombent sur l'estimation par fréquence ("freq_estime"). La formule
        // par quintiles ci-dessous reste la méthode de secours — et sera la méthode principale
        // pour les catégories de mots pas encore croisées avec le NT2Lex (noms, adjectifs...),
        // jusqu'à ce qu'elles le soient à leur tour. Seuils calculés sur l'ensemble des 5 fichiers
        // de vocabulaire de base (1556 mots), pas seulement les verbes, pour que "B1" veuille dire
        // la même chose partout une fois toutes les catégories traitées.
        const CECR_FREQ_THRESHOLDS = { A1: 5.34, A2: 4.90, B1: 4.57, B2: 4.24 }; // en dessous de B2 => C1

        function freqToNiveauCECR(freq) {
            if (freq >= CECR_FREQ_THRESHOLDS.A1) return 'A1';
            if (freq >= CECR_FREQ_THRESHOLDS.A2) return 'A2';
            if (freq >= CECR_FREQ_THRESHOLDS.B1) return 'B1';
            if (freq >= CECR_FREQ_THRESHOLDS.B2) return 'B2';
            return 'C1';
        }

        // Niveau CECR d'un verbe : privilégie la valeur réelle stockée (NT2Lex ou fallback déjà
        // calculé une fois pour toutes dans les données), ne recalcule que si le champ est absent
        // (robustesse si jamais appelé sur une entrée non enrichie).
        function getVerbNiveauCECR(v) {
            return v.niveauCECR || freqToNiveauCECR(v.freq);
        }

        // Verbes de modalité : liste fermée, aucune ambiguïté possible.
        const MODAL_VERBS = ['kunnen', 'mogen', 'moeten', 'willen', 'zullen'];

        // Verbes à préposition fixe ("vaste voorzetsels") : contrairement à régulier/irrégulier/
        // séparable, RIEN dans les données ne permet de déduire ça automatiquement — c'est un
        // travail de connaissance de la langue, pas un calcul. Liste volontairement prudente :
        // seulement les verbes où la préposition est vraiment fixe/obligatoire dans le sens
        // précis enseigné ici (vérifié contre la traduction FR stockée pour ce verbe, pour éviter
        // de taguer le mauvais sens d'un verbe à plusieurs sens — ex: "houden" est stocké ici avec
        // le sens "tenir/garder", pas "aimer", donc "houden van" n'a PAS été ajouté). Verbes au
        // sens trop générique ou à préposition non-obligatoire (praten, spreken, vragen, zoeken,
        // gaan, komen, staan...) volontairement exclus plutôt que de deviner. Complétable plus
        // tard si des oublis sont repérés en testant l'appli.
        const VERBE_PREPOSITIONS = {
            'afhangen (van)': 'van', 'behoren (tot)': 'tot', 'belangstellen (in)': 'in',
            'beperken (zich)': 'tot', 'deelnemen (aan)': 'aan', 'genieten (van)': 'van',
            'denken': 'aan', 'dromen': 'van', 'geloven': 'in', 'herinneren (zich)': 'aan',
            'hopen': 'op', 'kijken': 'naar', 'klagen': 'over', 'letten (op)': 'op',
            'lijden': 'aan', 'luisteren': 'naar', 'passen': 'bij', 'rekenen': 'op',
            'schrikken': 'van', 'vergelijken': 'met', 'verschillen': 'van', 'vertrouwen': 'op',
            'voorbereiden': 'op', 'wachten': 'op', 'wennen': 'aan', 'wijzen': 'op',
            'zorgen': 'voor', 'beginnen': 'met'
        };

        const VERB_CATEGORY_LABELS = {
            irregulier: '⚡ Irrégulier', regulier: '📏 Régulier', particule_separable: '✂️ À particule',
            modalite: '🔧 Modalité', prepositionnel: '🔗 + préposition'
        };

        // Retourne la liste des étiquettes applicables à un verbe (toujours régulier XOR
        // irrégulier, plus 0 à plusieurs étiquettes supplémentaires).
        function getVerbCategories(v) {
            const cats = [isStrongPreteritum(v) ? 'irregulier' : 'regulier'];
            if (isSeparableVerb(v)) cats.push('particule_separable');
            if (MODAL_VERBS.includes(v.infinitief)) cats.push('modalite');
            if (VERBE_PREPOSITIONS[v.infinitief]) cats.push('prepositionnel');
            return cats;
        }

        function verbCategoryBadgesHtml(v) {
            return getVerbCategories(v).map(c => {
                let label = VERB_CATEGORY_LABELS[c];
                if (c === 'prepositionnel') label += ` (${VERBE_PREPOSITIONS[v.infinitief]})`;
                return `<span class="verb-cat-badge">${label}</span>`;
            }).join('');
        }

        // ===== Vue Conjugaison =====
        let conjugaisonSelectedVerb = null;
        let conjFilterCategory = 'toutes';

        function showConjugaison() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('conjugaison-view').classList.add('active');
            setActiveNav('nav-apprendre');
            document.getElementById('conj-detail').innerHTML = '';
            if (!conjugationLoaded) {
                document.getElementById('conj-list').innerHTML = '<p style="color:#888;">Données de conjugaison en cours de chargement...</p>';
                return;
            }
            renderConjugaisonList();
        }

        const CONJ_FILTER_CHIPS = [
            { key: 'toutes', label: 'Toutes' },
            { key: 'regulier', label: '📏 Réguliers' },
            { key: 'irregulier', label: '⚡ Irréguliers' },
            { key: 'particule_separable', label: '✂️ À particule' },
            { key: 'modalite', label: '🔧 Modalité' },
            { key: 'prepositionnel', label: '🔗 + préposition' }
        ];

        // Tranche de fréquence : "les verbes les plus courants d'abord". 0 = tous les verbes.
        const CONJ_RANGE_CHIPS = [
            { key: 25, label: 'Top 25' },
            { key: 50, label: 'Top 50' },
            { key: 100, label: 'Top 100' },
            { key: 0, label: 'Tous' }
        ];
        const CONJ_TENSES = ['present', 'imperfectum', 'perfectum', 'futur'];
        const CONJ_TENSE_NAMES = { present: 'Présent', imperfectum: 'Prétérit', perfectum: 'Perfectum', futur: 'Futur' };
        let conjFilterRange = 50;
        let conjCurrentList = []; // infinitifs de la liste affichée, dans l'ordre : sert à "précédent / suivant"

        // Verbes triés du plus courant au plus rare (fréquence d'usage déjà présente dans
        // conjugation.json), calculé une seule fois. `rank` = position dans ce classement.
        let conjFreqCache = null;
        function conjByFrequency() {
            if (!conjFreqCache || conjFreqCache.sorted.length !== conjugationData.length) {
                const sorted = conjugationData.slice().sort((a, b) => (b.freq || 0) - (a.freq || 0));
                const rank = {};
                sorted.forEach((v, i) => { rank[v.infinitief] = i + 1; });
                conjFreqCache = { sorted, rank };
            }
            return conjFreqCache;
        }

        // ===== Mémoire des réponses de conjugaison =====
        // state.conjStats[`infinitif|temps|pronom`] = { ok, ko, streak, last }. Alimentée par les deux
        // entraînements (sur un verbe, et la session réglable) ; sert à faire revenir en priorité les
        // formes ratées et à afficher un indicateur de maîtrise par verbe. Vit dans `state`, donc
        // sauvegardée et synchronisée comme le reste de la progression.
        function conjStatKey(infinitief, tense, pronomKey) {
            // Au prétérit, ik / jij / hij partagent la même forme : une seule entrée pour les trois.
            const p = (tense === 'imperfectum' && pronomKey !== 'wij') ? 'hij' : pronomKey;
            return infinitief + '|' + tense + '|' + p;
        }

        function conjGetStat(infinitief, tense, pronomKey) {
            return (state.conjStats || {})[conjStatKey(infinitief, tense, pronomKey)] || null;
        }

        function conjRecordResult(infinitief, tense, pronomKey, isCorrect) {
            if (!state.conjStats) state.conjStats = {};
            const key = conjStatKey(infinitief, tense, pronomKey);
            const s = state.conjStats[key] || { ok: 0, ko: 0, streak: 0, last: 0 };
            if (isCorrect) { s.ok++; s.streak++; } else { s.ko++; s.streak = 0; }
            s.last = Date.now();
            state.conjStats[key] = s;
        }

        // Une forme est "à revoir" tant que la dernière réponse donnée dessus était fausse.
        function conjIsWeak(stat) { return !!stat && stat.streak === 0; }

        function conjVerbMastery(v) {
            let tried = 0, weak = 0;
            CONJ_TENSES.forEach(t => ['ik', 'jij', 'hij', 'wij'].forEach(p => {
                if (t === 'imperfectum' && (p === 'ik' || p === 'jij')) return; // même entrée que hij
                const s = conjGetStat(v.infinitief, t, p);
                if (!s) return;
                tried++;
                if (conjIsWeak(s)) weak++;
            }));
            if (!tried) return { level: 'none', html: '' };
            if (weak) return { level: 'weak', html: `<span class="wl-badge review">À revoir · ${weak}</span>` };
            if (tried >= 6) return { level: 'ok', html: '<span class="wl-badge true-mastered">Maîtrisé</span>' };
            return { level: 'progress', html: '<span class="wl-badge mastered">En cours</span>' };
        }

        function conjSetFilter(key) {
            conjFilterCategory = key;
            renderConjugaisonList();
        }

        function conjSetRange(n) {
            conjFilterRange = n;
            renderConjugaisonList();
        }

        function renderConjugaisonList() {
            if (!conjugationLoaded) return;
            const q = normalize((document.getElementById('conj-search').value || '').trim());
            const listEl = document.getElementById('conj-list');
            const filterEl = document.getElementById('conj-filter-chips');
            if (filterEl) {
                filterEl.innerHTML =
                    CONJ_RANGE_CHIPS.map(c =>
                        `<button type="button" class="conj-filter-chip${c.key === conjFilterRange ? ' active' : ''}" onclick="conjSetRange(${c.key})">${c.label}</button>`
                    ).join('') +
                    '<span class="conj-chip-sep"></span>' +
                    CONJ_FILTER_CHIPS.map(c =>
                        `<button type="button" class="conj-filter-chip${c.key === conjFilterCategory ? ' active' : ''}" onclick="conjSetFilter('${c.key}')">${c.label}</button>`
                    ).join('');
            }
            const { sorted, rank } = conjByFrequency();
            // Une recherche porte toujours sur les 322 verbes : on ne veut pas "ne pas trouver" un
            // verbe simplement parce qu'il est hors de la tranche Top N sélectionnée.
            let results = (q || !conjFilterRange) ? sorted : sorted.slice(0, conjFilterRange);
            if (conjFilterCategory !== 'toutes') {
                results = results.filter(v => getVerbCategories(v).includes(conjFilterCategory));
            }
            if (q) {
                results = results.filter(v =>
                    normalize(v.infinitief).includes(q) || normalize(v.fr).includes(q)
                );
            }
            conjCurrentList = results.map(v => v.infinitief);
            const totalMatching = results.length;
            results = results.slice(0, 100);
            if (!results.length) {
                listEl.innerHTML = '<p style="color:#888;">Aucun verbe trouvé.</p>';
                return;
            }
            listEl.innerHTML =
                `<p style="font-size:0.72rem; color:var(--text-secondary);">${totalMatching} verbe(s), du plus courant au plus rare${totalMatching > 100 ? ' — les 100 premiers affichés, affine ta recherche pour voir les autres' : ''}.</p>` +
                results.map(v =>
                `<div class="conj-list-item" onclick="showConjugaisonDetail('${v.infinitief.replace(/'/g, "\\'")}')">
                    <div><span class="conj-rank">#${rank[v.infinitief]}</span> <b>${v.infinitief}</b> <span style="color:#888;">— ${v.fr}</span></div>
                    <div class="conj-list-badges"><span class="conj-niveau-badge">${getVerbNiveauCECR(v)}</span>${verbCategoryBadgesHtml(v)}${conjVerbMastery(v).html}</div>
                </div>`
            ).join('');
        }

        // ===== Grille de conjugaison façon "tableau d'école" (pronoms x temps) =====
        // Construit à partir des données déjà existantes (aucune modification de conjugation.json) :
        // - Présent : déjà stocké, wij/jullie/zij partagent la même forme (grammaire réelle du NL).
        // - Futur : jamais stocké mais 100% mécanique — "zullen" (auxiliaire irrégulier mais fixe) +
        //   l'infinitif complet du verbe, valable pour les 322 verbes sans exception.
        // - Perfectum : participePasse (stocké, invariable) + auxiliaire hebben/zijn (stocké, conjugué
        //   ci-dessous via une table fixe) — également sans exception.
        // - Prétérit pluriel (wij/jullie/zij) : jamais stocké (seul le singulier ik/jij/hij existe dans
        //   conjugation.json). PAS dérivé par une règle générique — trop de vraies exceptions en
        //   néerlandais (was→waren, kon→konden, zou→zouden, begon→begonnen avec doublement...) pour
        //   qu'une règle automatique soit fiable à 100%. À la place : table de correspondance vérifiée
        //   à la main, forme par forme, pour les 117 verbes forts/irréguliers réellement présents dans
        //   cette base (les 179 verbes faibles restants suivent la seule règle sans exception du
        //   néerlandais : prétérit pluriel = prétérit singulier + "n").
        const HULPWERKWOORDEN = {
            hebben: { ik: 'heb', jij: 'hebt', hij: 'heeft', wij: 'hebben', jullie: 'hebben', zij: 'hebben' },
            zijn:   { ik: 'ben', jij: 'bent', hij: 'is',    wij: 'zijn',   jullie: 'zijn',   zij: 'zijn' },
            zullen: { ik: 'zal', jij: 'zal',  hij: 'zal',   wij: 'zullen', jullie: 'zullen', zij: 'zullen' }
        };

        // wij/jullie/zij partagent toujours exactement la même forme (présent, futur, prétérit
        // pluriel, perfectum) — regroupés sur une seule ligne pour gagner de la place dans la
        // grille, plutôt que de répéter 3 fois une ligne identique.
        const CONJ_PRONOUNS = [
            { key: 'ik', label: 'ik' },
            { key: 'jij', label: 'jij / u' },
            { key: 'hij', label: 'hij / zij / het' },
            { key: 'wij', label: 'wij / jullie / zij' }
        ];

        // Table vérifiée à la main (voir commentaire ci-dessus) — couvre les 117 premiers-mots de
        // prétérit "forts/irréguliers" réellement présents dans conjugation.json (vérifié par script,
        // 0 verbe manquant). Clé = 1er mot du prétérit singulier tel que stocké, valeur = sa forme au
        // pluriel ; la particule éventuelle ("aan", "op"...) est rattachée telle quelle ensuite.
        const IMPERFECTUM_PLURAL_MAP = {
            at:'aten', bad:'baden', bedroeg:'bedroegen', beet:'beten', begon:'begonnen',
            begreep:'begrepen', bekeek:'bekeken', benam:'benamen', beschreef:'beschreven',
            besloot:'besloten', bestond:'bestonden', betrof:'betroffen', bevond:'bevonden',
            bewees:'bewezen', bewoog:'bewogen', bezat:'bezaten', bezocht:'bezochten',
            bleef:'bleven', bleek:'bleken', bond:'bonden', bood:'boden', boog:'bogen',
            bracht:'brachten', brak:'braken', dacht:'dachten', deed:'deden', dreef:'dreven',
            droeg:'droegen', dronk:'dronken', dwong:'dwongen', ervoer:'ervoeren', gaf:'gaven',
            genoot:'genoten', ging:'gingen', gleed:'gleden', gold:'golden', goot:'goten',
            greep:'grepen', had:'hadden', hield:'hielden', hielp:'hielpen', hing:'hingen',
            keek:'keken', klom:'klommen', kocht:'kochten', kon:'konden', koos:'kozen',
            kreeg:'kregen', kwam:'kwamen', lag:'lagen', las:'lazen', leed:'leden', leek:'leken',
            liep:'liepen', liet:'lieten', mat:'maten', mocht:'mochten', moest:'moesten',
            nam:'namen', ontbeet:'ontbeten', ontbrak:'ontbraken', onthield:'onthielden',
            ontstond:'ontstonden', ontving:'ontvingen', overleed:'overleden', reed:'reden',
            riep:'riepen', scheen:'schenen', schiep:'schiepen', schonk:'schonken',
            schreef:'schreven', schrok:'schrokken', sliep:'sliepen', sloeg:'sloegen',
            sloot:'sloten', smeet:'smeten', sneed:'sneden', sprak:'spraken', sprong:'sprongen',
            stak:'staken', steeg:'stegen', stierf:'stierven', stond:'stonden', trok:'trokken',
            verbond:'verbonden', vergat:'vergaten', vergeleek:'vergeleken', verkocht:'verkochten',
            verliet:'verlieten', verloor:'verloren', vermeed:'vermeden', vertrok:'vertrokken',
            verving:'vervingen', verzond:'verzonden', viel:'vielen', ving:'vingen', vloog:'vlogen',
            vocht:'vochten', voer:'voeren', vond:'vonden', vroeg:'vroegen', vroor:'vroren',
            was:'waren', wees:'wezen', werd:'werden', wierp:'wierpen', wist:'wisten', won:'wonnen',
            zag:'zagen', zat:'zaten', zei:'zeiden', zocht:'zochten', zond:'zonden', zong:'zongen',
            zou:'zouden', zweeg:'zwegen', zwom:'zwommen'
        };

        function deriveImperfectumPluriel(preteritum) {
            const words = preteritum.split(' ');
            const first = words[0];
            const rest = words.slice(1);
            // Verbes faibles (prétérit finit par -de/-te) : règle sans exception en néerlandais.
            const pluralFirst = (first.endsWith('de') || first.endsWith('te'))
                ? first + 'n'
                : (IMPERFECTUM_PLURAL_MAP[first] || (first + 'en')); // filet de sécurité, ne devrait jamais servir (0 manquant vérifié)
            return [pluralFirst, ...rest].join(' ');
        }

        function buildConjugationGrid(v) {
            const futurAux = HULPWERKWOORDEN.zullen;
            const perfAux = HULPWERKWOORDEN[v.auxiliaire] || HULPWERKWOORDEN.hebben;
            const preteritumPluriel = deriveImperfectumPluriel(v.preteritum);
            return CONJ_PRONOUNS.map(p => {
                const isPlural = (p.key === 'wij');
                return {
                    pronom: p.label,
                    pronomKey: p.key,
                    present: isPlural ? v.present.wij : v.present[p.key],
                    futur: `${futurAux[p.key]} ${v.infinitief}`,
                    imperfectum: isPlural ? preteritumPluriel : v.preteritum,
                    perfectum: `${perfAux[p.key]} ${v.participePasse}`
                };
            });
        }

        // Fiche d'un verbe : une carte par temps (au lieu d'un tableau à 5 colonnes qu'il fallait
        // faire glisser sur téléphone), les temps primitifs en tête, les formes ratées en rouge, et
        // des boutons précédent / suivant pour enchaîner les verbes dans l'ordre de la liste.
        function showConjugaisonDetail(infinitief) {
            const v = conjugationData.find(x => x.infinitief === infinitief);
            if (!v) return;
            conjugaisonSelectedVerb = v;
            const rows = buildConjugationGrid(v);
            const esc = s => s.replace(/'/g, "\\'");
            const tenseCards = CONJ_TENSES.map(t => `
                <div class="conj-tense-card">
                    <div class="conj-tense-name">${CONJ_TENSE_NAMES[t]}</div>
                    ${rows.map(r => `
                        <div class="conj-tense-row">
                            <span class="conj-grid-pronom">${r.pronom}</span>
                            <span class="conj-form${conjIsWeak(conjGetStat(v.infinitief, t, r.pronomKey)) ? ' weak' : ''}">${r[t]}<span class="conj-form-fr" id="conj-fr-${t}-${r.pronomKey}"></span></span>
                            ${speakBtnHtml(r[t])}
                        </div>`).join('')}
                </div>`).join('');

            const { rank } = conjByFrequency();
            const pos = conjCurrentList.indexOf(v.infinitief);
            const prev = pos > 0 ? conjCurrentList[pos - 1] : null;
            const next = (pos >= 0 && pos < conjCurrentList.length - 1) ? conjCurrentList[pos + 1] : null;
            const navBtn = (target, label) => target
                ? `<button type="button" class="conj-filter-chip" onclick="showConjugaisonDetail('${esc(target)}')">${label}</button>`
                : `<button type="button" class="conj-filter-chip" disabled style="opacity:0.35; cursor:default;">${label}</button>`;
            const aux = HULPWERKWOORDEN[v.auxiliaire] || HULPWERKWOORDEN.hebben;
            const hasWeak = conjVerbMastery(v).level === 'weak';

            document.getElementById('conj-detail').innerHTML = `
                <div class="conj-card">
                    <div class="conj-detail-nav">
                        ${navBtn(prev, '← Précédent')}
                        <span>#${rank[v.infinitief]} des plus courants</span>
                        ${navBtn(next, 'Suivant →')}
                    </div>
                    <div class="conj-verb-title">${v.infinitief} ${speakBtnHtml(v.infinitief)}</div>
                    <div style="color:#888; margin-bottom:6px;">${v.fr}</div>
                    <div class="conj-list-badges" style="margin-bottom:10px;"><span class="conj-niveau-badge">${getVerbNiveauCECR(v)}</span>${verbCategoryBadgesHtml(v)}${conjVerbMastery(v).html}</div>
                    <div class="conj-principal">${v.infinitief} · ${v.preteritum} · ${aux.hij} ${v.participePasse}</div>
                    <div class="conj-tense-grid">${tenseCards}</div>
                    <div id="conj-fr-note" style="font-size:0.72rem; color:var(--text-secondary); margin-top:8px;"></div>
                    ${hasWeak ? '<div style="font-size:0.72rem; color:var(--wrong); margin-top:8px;">En rouge : les formes ratées à ta dernière tentative.</div>' : ''}
                    <div class="conj-sentence">${v.exempleNl} ${speakBtnHtml(v.exempleNl)}<br>${v.exempleFr}</div>
                    <button class="btn btn-green" style="margin-top:12px;" onclick="conjExerciseStart('${esc(v.infinitief)}')">🎯 S'entraîner sur ce verbe</button>
                </div>
                <div id="conj-exercise-box"></div>`;
            document.getElementById('conj-detail').scrollIntoView({ block: 'start' });
            conjLoadFrenchForms(v);
        }

        // ===== Traduction française de chaque forme conjuguée =====
        // conjugation.json ne contient que la traduction de l'infinitif. Les 16 formes de la fiche
        // sont traduites par Gemini en UN appel à la première ouverture d'un verbe, puis gardées
        // sur l'appareil (localStorage, hors de `state` pour ne pas alourdir la synchro) : les
        // ouvertures suivantes sont instantanées et ne consomment plus rien.
        const CONJ_FR_CACHE_KEY = 'nl_conj_fr_cache_v1';
        function conjFrCacheGet() {
            try { return JSON.parse(localStorage.getItem(CONJ_FR_CACHE_KEY)) || {}; } catch (e) { return {}; }
        }

        async function conjLoadFrenchForms(v) {
            const setNote = msg => { const n = document.getElementById('conj-fr-note'); if (n) n.innerText = msg; };
            let data = conjFrCacheGet()[v.infinitief];
            if (!data) {
                if (!GeminiService.isAvailable()) {
                    setNote('Traduction de chaque forme : nécessite Gemini (Profil → 🤖 Intelligence IA).');
                    return;
                }
                setNote('Traduction des formes en cours...');
                const rows = buildConjugationGrid(v);
                const forms = CONJ_TENSES.map(t => t + ' : ' + rows.map(r => r.pronomKey + ' = ' + r[t]).join(' ; ')).join('\n');
                try {
                    const raw = await GeminiService.generate(
                        'Traduis en français chaque forme conjuguée du verbe néerlandais "' + v.infinitief + '" (sens : ' + v.fr + ').\n\n' + forms + '\n\n' +
                        'Correspondances : ik = je, jij = tu, hij = il, wij = nous. Temps français à utiliser : present → présent, imperfectum → imparfait, perfectum → passé composé, futur → futur simple. ' +
                        'Garde un seul sens du verbe, le même partout, et inclus le pronom (ex : "je suis", "nous avons été").\n' +
                        'Réponds UNIQUEMENT avec un objet JSON, sans texte autour : {"present": {"ik": "...", "jij": "...", "hij": "...", "wij": "..."}, "imperfectum": {...}, "perfectum": {...}, "futur": {...}}'
                    );
                    const m = raw.match(/\{[\s\S]*\}/);
                    data = JSON.parse(m ? m[0] : raw);
                    if (!CONJ_TENSES.every(t => data[t] && typeof data[t] === 'object')) throw new Error('réponse incomplète');
                } catch (e) {
                    setNote('Traduction des formes impossible pour le moment (' + e.message + ').');
                    return;
                }
                try {
                    const cache = conjFrCacheGet();
                    cache[v.infinitief] = data;
                    localStorage.setItem(CONJ_FR_CACHE_KEY, JSON.stringify(cache));
                } catch (e) { /* stockage plein : la traduction reste affichée, simplement pas mémorisée */ }
            }
            if (conjugaisonSelectedVerb !== v) return; // on a changé de verbe pendant l'appel
            CONJ_TENSES.forEach(t => ['ik', 'jij', 'hij', 'wij'].forEach(p => {
                const el = document.getElementById('conj-fr-' + t + '-' + p);
                if (el && data[t] && data[t][p]) el.innerText = String(data[t][p]);
            }));
            setNote('Traductions françaises générées par IA : elles peuvent contenir une erreur.');
        }

        // ===== Exercices sur la grille de conjugaison =====
        // Pioche des cases (pronom x temps) au hasard dans la grille déjà construite ci-dessus et fait
        // taper la forme correspondante. Réutilise evaluateAnswer() (même tolérance orthographique que
        // le reste de l'app) plutôt que de réinventer une logique de correction séparée.
        let conjExerciseState = null;
        const CONJ_TENSE_LABELS = { present: 'au présent', futur: 'au futur', imperfectum: "à l'imperfectum (prétérit)", perfectum: 'au perfectum (passé composé)' };

        function conjExerciseStart(infinitief) {
            const v = conjugationData.find(x => x.infinitief === infinitief);
            if (!v) return;
            const rows = buildConjugationGrid(v);
            const tenses = ['present', 'futur', 'imperfectum', 'perfectum'];
            const pool = [];
            rows.forEach(r => tenses.forEach(t => pool.push({ pronom: r.pronom, pronomKey: r.pronomKey, tense: t, answer: r[t] })));
            // Mélange (Fisher-Yates) puis limite à 8 questions par session — assez pour réviser un
            // verbe sans que ce soit trop long.
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            conjExerciseState = { verb: v, pool: pool.slice(0, 8), index: 0, score: 0 };
            conjExerciseRenderQuestion();
        }

        function conjExerciseRenderQuestion() {
            const box = document.getElementById('conj-exercise-box');
            if (!box || !conjExerciseState) return;
            const st = conjExerciseState;
            if (st.index >= st.pool.length) {
                box.innerHTML = `
                    <div class="conj-card">
                        <div class="conj-verb-title">Résultat : ${st.score}/${st.pool.length}</div>
                        <button class="btn btn-green" style="margin-top:10px;" onclick="conjExerciseStart('${st.verb.infinitief.replace(/'/g, "\\'")}')">🔁 Recommencer sur ce verbe</button>
                        <button class="btn btn-gray" style="margin-top:8px;" onclick="conjExerciseStop()">Fermer</button>
                    </div>`;
                return;
            }
            const q = st.pool[st.index];
            box.innerHTML = `
                <div class="conj-card">
                    <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:4px;">Question ${st.index + 1}/${st.pool.length} · Score : ${st.score}</div>
                    <div style="font-weight:600; margin-bottom:10px;">${q.pronom} — ${st.verb.infinitief} (${st.verb.fr}) — ${CONJ_TENSE_LABELS[q.tense]}</div>
                    <input type="text" id="conj-ex-input" placeholder="Tape la forme conjuguée..." style="width:100%; margin-bottom:8px;" autocomplete="off" onkeypress="if(event.key==='Enter') conjExerciseCheck()">
                    <div class="acc-error" id="conj-ex-feedback"></div>
                    <button class="btn btn-green" onclick="conjExerciseCheck()">Vérifier</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="conjExerciseStop()">Arrêter</button>
                </div>`;
            const input = document.getElementById('conj-ex-input');
            if (input) input.focus();
        }

        function conjExerciseCheck() {
            const st = conjExerciseState;
            if (!st) return;
            const input = document.getElementById('conj-ex-input');
            const fb = document.getElementById('conj-ex-feedback');
            const q = st.pool[st.index];
            const result = evaluateAnswer(input.value, q.answer);
            if (result.status === 'correct') {
                st.score++;
                fb.style.color = 'var(--success)';
                fb.innerText = '✅ Bravo ! → ' + q.answer;
            } else if (result.status === 'close') {
                st.score++;
                fb.style.color = 'var(--success)';
                fb.innerText = '🟡 Presque, on valide ! → ' + q.answer;
            } else {
                fb.style.color = 'var(--wrong)';
                fb.innerText = '❌ → ' + q.answer;
            }
            conjRecordResult(st.verb.infinitief, q.tense, q.pronomKey, result.status !== 'wrong');
            save();
            st.index++;
            setTimeout(conjExerciseRenderQuestion, 1300);
        }

        function conjExerciseStop() {
            conjExerciseState = null;
            const box = document.getElementById('conj-exercise-box');
            if (box) box.innerHTML = '';
        }

        // ===== Entraînement réglable (Jouer → Conjugaison) =====
        // Remplace l'ancien entraînement "30 verbes irréguliers, prétérit + participe" : on choisit
        // maintenant la tranche de verbes (les 25 / 50 / 100 plus courants, ou tous), les temps à
        // travailler, et éventuellement les irréguliers seulement. Chaque question porte sur UNE
        // forme (verbe + pronom + temps). Les réponses sont mémorisées (conjStats) : une forme
        // ratée revient en priorité aux sessions suivantes jusqu'à être réussie.
        // L'ancien réglage correspond à : Irréguliers seulement + Prétérit + Perfectum.
        function isStrongPreteritum(v) {
            const first = v.preteritum.split(' ')[0];
            return !(first.endsWith('de') || first.endsWith('te'));
        }

        const CONJ_TRAINING_SESSION_SIZE = 20;
        const CONJ_TRAINING_MAX_PER_VERB = 2;   // pas plus de 2 questions sur le même verbe par session
        const CONJ_TRAINING_PRONOUN_LABELS = { ik: 'ik', jij: 'jij / u', hij: 'hij / zij / het', wij: 'wij / jullie / zij' };

        // Réglages mémorisés d'une session à l'autre (dans state.settings, donc propres à l'appareil).
        function conjTrainingConfig() {
            if (!state.settings.conjTraining) {
                state.settings.conjTraining = { range: 50, tenses: ['present', 'imperfectum', 'perfectum'], irregOnly: false };
            }
            return state.settings.conjTraining;
        }

        function conjTrainingVerbPool(cfg) {
            const { sorted } = conjByFrequency();
            // "Top N" s'applique APRÈS le filtre irréguliers : Top 25 irréguliers = les 25 verbes
            // irréguliers les plus courants, pas les irréguliers parmi les 25 premiers verbes.
            const base = cfg.irregOnly ? sorted.filter(isStrongPreteritum) : sorted;
            return cfg.range ? base.slice(0, cfg.range) : base;
        }

        // Toutes les formes interrogeables pour ces réglages : une par (verbe, temps, pronom).
        // Au prétérit, ik/jij/hij ont la même forme : une seule question pour les trois.
        function conjTrainingCells(cfg) {
            const cells = [];
            conjTrainingVerbPool(cfg).forEach(v => {
                const rows = buildConjugationGrid(v);
                cfg.tenses.forEach(t => rows.forEach(r => {
                    if (t === 'imperfectum' && (r.pronomKey === 'ik' || r.pronomKey === 'jij')) return;
                    cells.push({
                        verb: v, tense: t, pronomKey: r.pronomKey, answer: r[t],
                        pronom: (t === 'imperfectum' && r.pronomKey === 'hij') ? 'ik / jij / hij' : CONJ_TRAINING_PRONOUN_LABELS[r.pronomKey],
                        stat: conjGetStat(v.infinitief, t, r.pronomKey)
                    });
                }));
            });
            return cells;
        }

        // Composition d'une session : d'abord les formes ratées la dernière fois (jusqu'à la moitié
        // de la session, les plus anciennes en premier), puis un tirage pondéré sans remise parmi
        // le reste — poids = fréquence du verbe, renforcé pour les formes jamais vues et réduit pour
        // celles déjà réussies deux fois de suite. Même méthode de tirage (clés exponentielles) que
        // l'ancien entraînement, pour que les sessions varient d'un lancement à l'autre.
        function pickConjTrainingQuestions(cfg) {
            const cells = conjTrainingCells(cfg);
            const perVerb = {};
            const picked = [];
            const take = c => {
                const n = perVerb[c.verb.infinitief] || 0;
                if (n >= CONJ_TRAINING_MAX_PER_VERB) return false;
                perVerb[c.verb.infinitief] = n + 1;
                picked.push(c);
                return true;
            };
            const due = cells.filter(c => conjIsWeak(c.stat)).sort((a, b) => a.stat.last - b.stat.last);
            for (const c of due) {
                if (picked.length >= CONJ_TRAINING_SESSION_SIZE / 2) break;
                take(c);
            }
            const rest = cells.filter(c => !picked.includes(c)).map(c => {
                const boost = !c.stat ? 1.5 : (c.stat.streak >= 2 ? 0.3 : 1);
                return { c, key: Math.pow(Math.random(), 1 / (((c.verb.freq || 0) + 1) * boost)) };
            });
            rest.sort((a, b) => b.key - a.key);
            for (const r of rest) {
                if (picked.length >= CONJ_TRAINING_SESSION_SIZE) break;
                take(r.c);
            }
            for (let i = picked.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [picked[i], picked[j]] = [picked[j], picked[i]];
            }
            return picked;
        }

        let conjTrainingState = null;

        // Point d'entrée (Jouer → Conjugaison) : ouvre l'écran de réglages.
        function startConjTrainingSession() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('conj-training-view').classList.add('active');
            setActiveNav('nav-apprendre');
            const content = document.getElementById('conj-training-content');
            if (!conjugationLoaded) {
                content.innerHTML = '<p style="color:#888;">Données de conjugaison en cours de chargement...</p>';
                return;
            }
            conjTrainingState = null;
            renderConjTrainingSetup();
        }

        function conjTrainingSetRange(n) { conjTrainingConfig().range = n; save(); renderConjTrainingSetup(); }
        function conjTrainingToggleIrreg() { const c = conjTrainingConfig(); c.irregOnly = !c.irregOnly; save(); renderConjTrainingSetup(); }
        function conjTrainingToggleTense(t) {
            const c = conjTrainingConfig();
            if (c.tenses.includes(t)) {
                if (c.tenses.length === 1) return; // il faut au moins un temps
                c.tenses = c.tenses.filter(x => x !== t);
            } else {
                c.tenses = CONJ_TENSES.filter(x => x === t || c.tenses.includes(x));
            }
            save();
            renderConjTrainingSetup();
        }

        function renderConjTrainingSetup() {
            const content = document.getElementById('conj-training-content');
            if (!content) return;
            const cfg = conjTrainingConfig();
            const cells = conjTrainingCells(cfg);
            const verbCount = conjTrainingVerbPool(cfg).length;
            const dueCount = cells.filter(c => conjIsWeak(c.stat)).length;
            const seenCount = cells.filter(c => c.stat).length;
            const chip = (active, onclick, label) =>
                `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
            content.innerHTML = `
                <div class="conj-card">
                    <div class="conj-setup-label">Quels verbes ?</div>
                    <div class="conj-filter-chips-row">
                        ${CONJ_RANGE_CHIPS.map(c => chip(c.key === cfg.range, `conjTrainingSetRange(${c.key})`, c.key ? c.label.replace('Top', 'Les') + ' plus courants' : 'Tous')).join('')}
                        ${chip(cfg.irregOnly, 'conjTrainingToggleIrreg()', '⚡ Irréguliers seulement')}
                    </div>
                    <div class="conj-setup-label">Quels temps ?</div>
                    <div class="conj-filter-chips-row">
                        ${CONJ_TENSES.map(t => chip(cfg.tenses.includes(t), `conjTrainingToggleTense('${t}')`, CONJ_TENSE_NAMES[t])).join('')}
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-secondary); margin:6px 0 12px;">
                        ${verbCount} verbe(s) · ${cells.length} formes · ${seenCount} déjà travaillée(s)${dueCount ? ` · <b style="color:var(--wrong);">${dueCount} à revoir, posée(s) en priorité</b>` : ''}
                    </div>
                    <button class="btn btn-green" onclick="conjTrainingLaunch()">▶️ Lancer (${Math.min(CONJ_TRAINING_SESSION_SIZE, cells.length)} questions)</button>
                </div>`;
        }

        function conjTrainingLaunch() {
            const questions = pickConjTrainingQuestions(conjTrainingConfig());
            if (!questions.length) return;
            conjTrainingState = { questions, index: 0, score: 0, missed: [] };
            renderConjTrainingQuestion();
        }

        function renderConjTrainingQuestion() {
            const content = document.getElementById('conj-training-content');
            const st = conjTrainingState;
            if (!content || !st) return;
            if (st.index >= st.questions.length) {
                renderConjTrainingSummary();
                return;
            }
            const q = st.questions[st.index];
            content.innerHTML = `
                <div class="conj-card">
                    <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:4px;">Question ${st.index + 1}/${st.questions.length} · Score : ${st.score}${conjIsWeak(q.stat) ? ' · <span style="color:var(--wrong);">à revoir</span>' : ''}</div>
                    <div class="conj-verb-title">${q.verb.infinitief} ${speakBtnHtml(q.verb.infinitief)}</div>
                    <div style="color:#888; margin-bottom:12px;">${q.verb.fr}</div>
                    <div class="conj-question-prompt"><b>${q.pronom}</b> — ${CONJ_TENSE_LABELS[q.tense]}</div>
                    <input type="text" id="conj-tr-input" style="width:100%; margin-bottom:8px;" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Tape la forme conjuguée..." onkeypress="if(event.key==='Enter') conjTrainingCheck()">
                    <div class="acc-error" id="conj-tr-feedback" style="margin-top:0;"></div>
                    <button class="btn btn-green" id="conj-tr-check-btn" onclick="conjTrainingCheck()">Vérifier</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="conjTrainingStop()">Arrêter</button>
                </div>`;
            const input = document.getElementById('conj-tr-input');
            if (input) input.focus();
        }

        function conjTrainingCheck() {
            const st = conjTrainingState;
            if (!st || st.checking) return;
            st.checking = true; // évite un double comptage si on appuie deux fois sur Entrée
            const q = st.questions[st.index];
            const result = evaluateAnswer(document.getElementById('conj-tr-input').value, q.answer);
            const isCorrect = result.status !== 'wrong';
            const fb = document.getElementById('conj-tr-feedback');
            if (isCorrect) {
                st.score++;
                fb.style.color = 'var(--success)';
                fb.innerHTML = (result.status === 'close' ? '🟡 Presque, on valide ! → ' : '✅ ') + q.answer;
            } else {
                st.missed.push(q);
                fb.style.color = 'var(--wrong)';
                fb.innerHTML = `❌ Réponse attendue : ${q.answer}`;
            }
            fb.innerHTML += ' ' + speakBtnHtml(q.answer);
            conjRecordResult(q.verb.infinitief, q.tense, q.pronomKey, isCorrect);
            save();
            const checkBtn = document.getElementById('conj-tr-check-btn');
            if (checkBtn) checkBtn.style.display = 'none';
            st.index++;
            setTimeout(() => { st.checking = false; renderConjTrainingQuestion(); }, isCorrect ? 1100 : 2400);
        }

        function conjTrainingStop() {
            conjTrainingState = null;
            renderConjTrainingSetup();
        }

        // Récap de fin de session : uniquement les formes ratées, avec la bonne réponse et un
        // bouton d'écoute — sert de fiche de révision rapide. Elles reviendront en priorité à la
        // prochaine session.
        function renderConjTrainingSummary() {
            const content = document.getElementById('conj-training-content');
            const st = conjTrainingState;
            const missedHtml = st.missed.length ? `
                <div class="section-title" style="margin-top:var(--space-4);">📌 À retenir (reviendront en priorité)</div>
                ${st.missed.map(m => `
                    <div class="conj-tense-row" style="border-bottom:1px solid var(--border); padding:8px 0;">
                        <span class="conj-grid-pronom" style="flex:1 1 45%;"><b style="color:var(--text);">${m.verb.infinitief}</b> · ${m.pronom}<br>${CONJ_TENSE_NAMES[m.tense]}</span>
                        <span class="conj-form">${m.answer}</span>
                        ${speakBtnHtml(m.answer)}
                    </div>`).join('')}` : `<p style="color:var(--success); margin-top:var(--space-4);">Aucune erreur, bien joué ! 🎉</p>`;
            content.innerHTML = `
                <div class="conj-card">
                    <div class="conj-verb-title">Résultat : ${st.score}/${st.questions.length}</div>
                    ${missedHtml}
                    <button class="btn btn-green" style="margin-top:14px;" onclick="conjTrainingLaunch()">🔁 Nouvelle session</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="startConjTrainingSession()">⚙️ Changer les réglages</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="showConjugaison()">Retour</button>
                </div>`;
        }

        // ===== Entraînement "verbes à particule séparable" (Jouer → Verbes à particule séparable) =====
        // Question posée par l'utilisateur : "je ne sais pas si ils fonctionnent tous de la même
        // façon". Réponse courte : non — un même verbe à particule séparable (ex: aanbieden, "aan"
        // + "bieden") se comporte différemment selon le contexte :
        //   1) après un verbe de modalité + infinitif (vouloir/pouvoir/devoir...) : la particule
        //      RESTE collée à l'infinitif ("ik wil het aanbieden").
        //   2) au présent, seul dans une phrase simple : la particule SE DÉTACHE et part en fin de
        //      phrase ("ik bied het aan").
        //   3) au perfectum : la particule se recolle, mais AVANT le préfixe "ge-" du participe
        //      ("aangeboden" = "aan" + "ge" + "boden", jamais "geaanboden").
        // D'où les 3 types de questions ci-dessous plutôt qu'un seul — c'est justement ça qui
        // rend ces verbes différents des autres et qui mérite un entraînement à part.
        //
        // Détection des verbes concernés : verbes dont le prétérit stocké a la forme "radical
        // particule" (2 mots), en excluant les faux positifs déjà repérés dans les données
        // (formes alternatives séparées par "/", verbes réfléchis dont le 2e mot est "zich",
        // groupes verbaux à 2 mots comme "aanwezig zijn" qui ne sont pas de vrais verbes à
        // particule séparable). 38 verbes de la base correspondent à ce filtre.
        function isSeparableVerb(v) {
            const pret = v.preteritum;
            if (pret.includes('/')) return false;
            if (v.infinitief.includes(' ') || v.infinitief.includes('(')) return false;
            const words = pret.split(' ');
            if (words.length !== 2) return false;
            if (words[1] === 'zich') return false;
            return true;
        }

        const SEPARABLE_QUESTION_TYPES = [
            {
                key: 'infinitive_after_modal',
                prompt: (v) => `Après "willen / kunnen / moeten..." (${v.fr}) :`,
                hint: 'Devant un infinitif, la particule reste collée au verbe.',
                expected: (v) => v.infinitief
            },
            {
                key: 'present_split',
                prompt: (v) => `Au présent, avec "ik" (${v.fr}) :`,
                hint: 'Dans une phrase simple, la particule se détache et part à la fin.',
                expected: (v) => v.present.ik
            },
            {
                key: 'perfectum',
                prompt: (v) => `Au perfectum (${v.fr}) :`,
                hint: 'La particule se recolle, mais avant le "ge-" du participe.',
                expected: (v) => {
                    const aux = HULPWERKWOORDEN[v.auxiliaire] || HULPWERKWOORDEN.hebben;
                    return `${aux.hij} ${v.participePasse}`;
                }
            }
        ];

        const SEPARABLE_TRAINING_SESSION_SIZE = 24;

        // Même méthode de tirage pondéré que l'entraînement verbes irréguliers (voir
        // pickConjTrainingVerbs) : favorise les verbes les plus fréquents sans jamais exclure les
        // autres, et varie à chaque session. Chaque "cellule" est un couple (verbe, type de
        // question) — un même verbe peut revenir avec un cas différent dans une session.
        function pickSeparableTrainingCells() {
            const verbs = conjugationData.filter(isSeparableVerb);
            const cells = [];
            verbs.forEach(v => SEPARABLE_QUESTION_TYPES.forEach(qt => cells.push({ v, qt })));
            const keyed = cells.map(c => ({ c, key: Math.pow(Math.random(), 1 / (c.v.freq + 1)) }));
            keyed.sort((a, b) => b.key - a.key);
            return keyed.slice(0, SEPARABLE_TRAINING_SESSION_SIZE).map(k => k.c);
        }

        let separableTrainingState = null;

        function startSeparableTrainingSession() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('separable-training-view').classList.add('active');
            setActiveNav('nav-apprendre');
            const content = document.getElementById('separable-training-content');
            if (!conjugationLoaded) {
                content.innerHTML = '<p style="color:#888;">Données de conjugaison en cours de chargement...</p>';
                return;
            }
            separableTrainingState = { cells: pickSeparableTrainingCells(), index: 0, score: 0, missed: [] };
            renderSeparableTrainingQuestion();
        }

        function renderSeparableTrainingQuestion() {
            const content = document.getElementById('separable-training-content');
            const st = separableTrainingState;
            if (!content || !st) return;
            if (st.index >= st.cells.length) {
                renderSeparableTrainingSummary();
                return;
            }
            const { v, qt } = st.cells[st.index];
            content.innerHTML = `
                <div class="conj-card">
                    <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:4px;">Question ${st.index + 1}/${st.cells.length} · Score : ${st.score}</div>
                    <div class="conj-verb-title">${v.infinitief} ${speakBtnHtml(v.infinitief)}</div>
                    <div style="color:#888; margin-bottom:6px;">${v.fr}</div>
                    <div style="font-weight:600; margin-bottom:4px;">${qt.prompt(v)}</div>
                    <div style="font-size:0.72rem; color:var(--text-secondary); margin-bottom:10px;">💡 ${qt.hint}</div>
                    <input type="text" id="sep-tr-input" style="width:100%; margin-bottom:8px;" autocomplete="off" placeholder="Tape ta réponse..." onkeypress="if(event.key==='Enter') separableTrainingCheck()">
                    <div class="acc-error" id="sep-tr-feedback"></div>
                    <button class="btn btn-green" id="sep-tr-check-btn" onclick="separableTrainingCheck()">Vérifier</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="separableTrainingStop()">Arrêter</button>
                </div>`;
            const input = document.getElementById('sep-tr-input');
            if (input) input.focus();
        }

        function separableTrainingCheck() {
            const st = separableTrainingState;
            if (!st) return;
            const { v, qt } = st.cells[st.index];
            const expected = qt.expected(v);
            const raw = document.getElementById('sep-tr-input').value;
            const result = evaluateAnswer(raw, expected);
            const isCorrect = result.status !== 'wrong';
            const fb = document.getElementById('sep-tr-feedback');
            if (isCorrect) {
                st.score++;
                fb.style.color = 'var(--success)';
                fb.innerHTML = `✅ ${expected}`;
            } else {
                st.missed.push({ infinitief: v.infinitief, fr: v.fr, question: qt.prompt(v), expected });
                fb.style.color = 'var(--wrong)';
                fb.innerHTML = `❌ Réponse attendue : ${expected}`;
            }
            fb.innerHTML += ' ' + speakBtnHtml(expected);
            const checkBtn = document.getElementById('sep-tr-check-btn');
            if (checkBtn) checkBtn.style.display = 'none';
            st.index++;
            setTimeout(renderSeparableTrainingQuestion, isCorrect ? 1100 : 2400);
        }

        function separableTrainingStop() {
            separableTrainingState = null;
            showConjugaison();
        }

        function renderSeparableTrainingSummary() {
            const content = document.getElementById('separable-training-content');
            const st = separableTrainingState;
            const missedHtml = st.missed.length ? `
                <div class="section-title" style="margin-top:var(--space-4);">📌 À retenir</div>
                <div style="overflow-x:auto;">
                    <table class="conj-grid-table">
                        <tr><th>Verbe</th><th>Cas</th><th>Réponse attendue</th></tr>
                        ${st.missed.map(m => `
                            <tr>
                                <td>${m.infinitief}<br><span style="color:var(--text-secondary); font-size:0.7rem;">${m.fr}</span></td>
                                <td style="font-size:0.72rem;">${m.question}</td>
                                <td>${m.expected} ${speakBtnHtml(m.expected)}</td>
                            </tr>`).join('')}
                    </table>
                </div>` : `<p style="color:var(--success); margin-top:var(--space-4);">Aucune erreur, bien joué ! 🎉</p>`;
            content.innerHTML = `
                <div class="conj-card">
                    <div class="conj-verb-title">Résultat : ${st.score}/${st.cells.length}</div>
                    ${missedHtml}
                    <button class="btn btn-green" style="margin-top:14px;" onclick="startSeparableTrainingSession()">🔁 Nouvelle session</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="showConjugaison()">Retour</button>
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
                if (!apiKey) throw new Error('Aucune clé API Gemini enregistrée (Profil → 🤖 Intelligence IA).');
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
                getKey,
                generate,
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
                // Question libre posée par l'apprenant en français pendant une leçon (ex: "comment on
                // dit X ?"), avec le contexte de la notion en cours pour rester pertinent et au bon
                // niveau — jamais pour redéfinir le curriculum, seulement pour répondre à CETTE
                // question précise.
                answerFreeQuestion: (notionContent, userQuestion) => generate(
                    `Tu es un professeur de néerlandais pour francophones, en train d'expliquer la notion suivante à un apprenant :\n${notionContent}\n\nL'apprenant te pose cette question en français, pendant la leçon : "${userQuestion}"\n\nRéponds en français, en 3-4 phrases maximum, de façon simple et concrète. Si sa question porte sur "comment dire X en néerlandais", donne la traduction néerlandaise exacte en gras avec ** autour, plus un exemple de phrase courte. Si la question sort complètement du sujet de la notion, réponds quand même utilement mais reste bref.`
                ),
                // Traduction ponctuelle d'un mot/une phrase néerlandaise non traduit(e) dans les
                // données du curriculum (exemples, vocabulaire, réponse correcte d'un exercice).
                // Volontairement minimaliste : une seule traduction concise, pas d'explication —
                // c'est un bouton "traduire à la demande", pas un cours.
                translateToFrench: (text) => generate(
                    `Traduis ce mot ou cette phrase néerlandaise en français, de façon naturelle et concise, dans le contexte de l'apprentissage du néerlandais. Réponds UNIQUEMENT avec la traduction française, sans guillemets, sans explication, sans commentaire.\n\nNéerlandais : "${text}"`
                ),
                generateConversation: (scenario, history) => generate(
                    `Continue cette conversation en néerlandais dans le contexte suivant : ${scenario}. Historique : ${JSON.stringify(history)}. Réponds uniquement en néerlandais, une ou deux phrases.`
                ),
                evaluateProduction: (prompt_, userText) => generate(
                    `Un apprenant francophone de néerlandais devait : "${prompt_}". Il a écrit : "${userText}". Évalue en français (2-3 phrases) : grammaire correcte ou non, et une suggestion d'amélioration.`
                ),
                // Feedback structuré, avec le contexte pédagogique complet de la notion travaillée.
                // Utilisé par le cycle NOTION → ENTRAÎNEMENT → PRODUCTION → FEEDBACK → RÉVISION.
                // Gemini ne fait ici QUE du feedback linguistique : il ne redéfinit jamais le
                // curriculum, les niveaux, les prérequis ou la maîtrise (ceux-ci restent gérés
                // par MasteryEngine/WeaknessEngine/RecommendationEngine, inchangés).
                evaluateProductionWithContext: (notion, mode, userText) => {
                    const c = notion.content || {};
                    const modeLabel = mode === 'oral'
                        ? "à l'oral (la production a été transcrite automatiquement : ignore les petites imperfections de transcription qui ne changent pas le sens)"
                        : "à l'écrit";
                    const context = [
                        `Niveau CECR travaillé : ${notion.level || ''}`,
                        c.titre ? `Notion : ${c.titre}` : '',
                        c.objectif ? `Objectif : ${c.objectif}` : '',
                        c.comprendre ? `Point clé : ${c.comprendre}` : '',
                        c.regle ? `Règle : ${c.regle}` : '',
                        c.contrastes ? `Point de friction pour francophones : ${c.contrastes}` : '',
                        (c.erreursFrequentes && c.erreursFrequentes.length) ? `Erreurs fréquentes connues sur cette notion : ${c.erreursFrequentes.join(' / ')}` : '',
                        c.criteresMaitrise ? `Critère de maîtrise visé : ${c.criteresMaitrise}` : '',
                        c.tacheProduction ? `Tâche demandée à l'apprenant : ${c.tacheProduction}` : ''
                    ].filter(Boolean).join('\n');
                    return generate(
`Tu es un professeur de néerlandais pour francophones. Un apprenant a produit une réponse ${modeLabel} pour la notion suivante :
${context}

Voici ce que l'apprenant a produit en néerlandais :
"${userText}"

Analyse sa production en tenant compte spécifiquement de : la grammaire, l'ordre des mots, le vocabulaire, la structure, l'adéquation à la tâche demandée, et si pertinent la nuance/le niveau de langue. Signale les erreurs importantes s'il y en a.

Réponds UNIQUEMENT en français, en respectant EXACTEMENT ce format à 4 sections (garde les émojis et les titres tels quels, mets "Rien à signaler" si une section n'a vraiment rien à dire, ne la saute pas) :
✅ RÉUSSI: <1-2 phrases sur ce qui fonctionne bien dans sa production>
⚠️ À AMÉLIORER: <1-2 phrases sur les points à travailler, sans lister toutes les fautes mineures>
✏️ CORRECTION: <une reformulation naturelle et correcte de sa production en néerlandais>
🎯 CONSEIL: <un seul conseil ciblé et actionnable, pas une liste>

Puis, sur une dernière ligne séparée, ajoute exactement : MOTS_CLES: <0 à 3 mots-clés séparés par des virgules, choisis UNIQUEMENT parmi cette liste : ordre des mots, verbe séparable, connecteurs, registre professionnel, temps du passé, subordonnée, passif, omdat/doordat, daarom/daardoor, aucun>

Reste bref et concret, évite les corrections interminables. Ne remets jamais en cause le niveau CECR de l'apprenant, le curriculum, les prérequis ou sa maîtrise globale : contente-toi d'un retour linguistique sur CETTE production.`
                    );
                }
            };
        })();

        function escapeHtml(s) {
            return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        // ===== Parsing du feedback structuré de Gemini (Production) =====
        function parseProductionFeedback(raw) {
            const result = { reussi: '', ameliorer: '', correction: '', conseil: '', motsCles: [], raw: raw || '' };
            const sections = [
                ['reussi', /✅\s*RÉUSSI\s*:?/i],
                ['ameliorer', /⚠️\s*À AMÉLIORER\s*:?/i],
                ['correction', /✏️\s*CORRECTION\s*:?/i],
                ['conseil', /🎯\s*CONSEIL\s*:?/i]
            ];
            const markers = [];
            sections.forEach(([key, re]) => {
                const m = raw.match(re);
                if (m) markers.push({ key, index: m.index, len: m[0].length });
            });
            const motsMatch = raw.match(/MOTS_CLES\s*:?\s*(.+)/i);
            const motsIndex = motsMatch ? motsMatch.index : raw.length;
            markers.sort((a, b) => a.index - b.index);
            markers.forEach((m, i) => {
                const end = i + 1 < markers.length ? markers[i + 1].index : motsIndex;
                result[m.key] = raw.slice(m.index + m.len, end).trim();
            });
            if (motsMatch) {
                result.motsCles = motsMatch[1].split(',').map(s => s.trim().toLowerCase()).filter(s => s && s !== 'aucun');
            }
            return result;
        }

        function renderProductionFeedbackHTML(parsed) {
            if (!parsed.reussi && !parsed.ameliorer && !parsed.correction && !parsed.conseil) {
                return `<div class="feedback-section">${escapeHtml(parsed.raw)}</div>`;
            }
            let html = '';
            if (parsed.reussi) html += `<div class="feedback-section"><b>✅ Ce qui est réussi</b>${escapeHtml(parsed.reussi)}</div>`;
            if (parsed.ameliorer) html += `<div class="feedback-section"><b>⚠️ Ce qui doit être amélioré</b>${escapeHtml(parsed.ameliorer)}</div>`;
            if (parsed.correction) html += `<div class="feedback-section"><b>✏️ Correction / reformulation</b>${escapeHtml(parsed.correction)}</div>`;
            if (parsed.conseil) html += `<div class="feedback-section"><b>🎯 Conseil ciblé</b>${escapeHtml(parsed.conseil)}</div>`;
            return html;
        }

        // ===== Lien feedback → faiblesses curriculum (sans nouvelle taxonomie) =====
        // Mappe des mots-clés de feedback Gemini vers des notions EXISTANTES du curriculum.
        // Best-effort : n'affecte jamais agressivement MasteryEngine, se contente d'enregistrer
        // le signal (voir recordProductionWeaknessSignals) pour une exploitation future.
        const PRODUCTION_WEAKNESS_KEYWORDS = {
            'ordre des mots': 'ordre_des_mots_base',
            'verbe séparable': 'verbes_separables_avances',
            'connecteurs': 'connecteurs_complexes',
            'registre professionnel': 'registre_formel_informel',
            'temps du passé': 'perfectum_tous_verbes',
            'subordonnée': 'ordre_mots_subordonnee',
            'passif': 'passif_worden_zijn',
            'omdat/doordat': 'omdat_vs_doordat',
            'daarom/daardoor': 'dus_daarom_daardoor'
        };

        function recordProductionWeaknessSignals(sourceNotionId, mode, motsCles) {
            const mapped = (motsCles || []).map(k => PRODUCTION_WEAKNESS_KEYWORDS[k]).filter(Boolean);
            if (mapped.length) {
                if (!state.productionWeaknessSignals) state.productionWeaknessSignals = [];
                mapped.forEach(targetNotionId => {
                    state.productionWeaknessSignals.push({ notionId: targetNotionId, sourceNotionId, mode, timestamp: Date.now() });
                });
                save();
            }
            return mapped;
        }

        async function askGeminiExplainOtherwise(notionId) {
            const notion = curriculumNotions[notionId];
            const box = document.getElementById('gemini-explain-box');
            if (!GeminiService.isAvailable()) {
                box.style.display = '';
                box.innerText = "Pas de clé API Gemini enregistrée. Ajoute-en une gratuitement depuis Profil → 🤖 Intelligence IA pour activer cette fonctionnalité.";
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

        // Question libre posée en français pendant une leçon (ex: "comment dit-on X ?"). Dépend
        // entièrement de Gemini — pas de secours pré-écrit possible ici (contrairement au mode script
        // du Jeu de rôle) puisque les questions sont par nature imprévisibles à l'avance ; si Gemini
        // est indisponible, message d'erreur clair, même pattern que askGeminiExplainOtherwise.
        async function askGeminiFreeQuestion(notionId) {
            const notion = curriculumNotions[notionId];
            const input = document.getElementById('lesson-question-input');
            const question = (input.value || '').trim();
            const box = document.getElementById('gemini-question-box');
            if (!question) return;
            if (!GeminiService.isAvailable()) {
                box.style.display = '';
                box.innerText = "Pas de clé API Gemini enregistrée. Ajoute-en une gratuitement depuis Profil → 🤖 Intelligence IA pour activer cette fonctionnalité.";
                return;
            }
            box.style.display = '';
            box.innerText = "L'IA réfléchit...";
            try {
                const c = notion.content || {};
                const contentStr = `${c.objectif || ''}\n${c.comprendre || ''}\n${c.regle || ''}`;
                const text = await GeminiService.answerFreeQuestion(contentStr, question);
                // Convertit **mot néerlandais** (voir consigne du prompt dans GeminiService) en gras +
                // bouton d'écoute — jamais un mot néerlandais affiché sans pouvoir l'entendre.
                box.innerHTML = text.replace(/\*\*(.+?)\*\*/g, (_, word) => `<strong>${word}</strong> ${speakBtnHtml(word)}`);
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
            { file: 'EXPRESSIONS_NL', label: 'Expressions' },
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
        // Accessible depuis Profil ET depuis Apprendre (voir cahier des charges "Apprendre →
        // Vocabulaire") : on retient d'où on vient pour que "← Retour" ramène au bon endroit,
        // plutôt que de renvoyer systématiquement vers Profil.
        let wordListReturnTo = 'profil';
        function showWordList(returnTo) {
            wordListReturnTo = returnTo || 'profil';
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('wordlist-view').classList.add('active');
            setActiveNav(wordListReturnTo === 'apprendre' ? 'nav-apprendre' : 'nav-profil');
            const filter = document.getElementById('wl-filter');
            const categories = [...new Set(fullDb.map(i => i.file))];
            filter.innerHTML = '<option value="">Toutes catégories</option>' +
                categories.map(c => `<option value="${c}">${c}</option>`).join('');
            renderWordList();
        }

        function wordListBack() {
            if (wordListReturnTo === 'apprendre') showApprendre(); else showProfil();
        }

        // Palette de couleurs par niveau CECR, réutilisée partout où on affiche ce badge
        // (liste de mots, conjugaison) pour une lecture visuelle cohérente A1 → C1.
        const CECR_BADGE_COLOR = { A1: '#16a34a', A2: '#65a30d', B1: '#ca8a04', B2: '#ea580c', C1: '#dc2626' };
        function niveauCECRBadgeHtml(niveau) {
            if (!niveau) return '';
            const color = CECR_BADGE_COLOR[niveau] || '#888';
            return `<span class="wl-niveau-badge" style="background:${color}">${niveau}</span>`;
        }

        function updateWlSubcatOptions() {
            const cat = document.getElementById('wl-filter').value;
            const subcatSel = document.getElementById('wl-subcat-filter');
            if (!subcatSel) return;
            const pool = cat ? fullDb.filter(i => i.file === cat) : fullDb;
            const subcats = [...new Set(pool.map(i => i.sousCategorie).filter(Boolean))].sort();
            const prevValue = subcatSel.value;
            if (!subcats.length) {
                subcatSel.innerHTML = '<option value="">Toutes sous-catégories</option>';
                subcatSel.style.display = 'none';
                return;
            }
            subcatSel.style.display = '';
            subcatSel.innerHTML = '<option value="">Toutes sous-catégories</option>' +
                subcats.map(s => `<option value="${s}">${s}</option>`).join('');
            if (subcats.includes(prevValue)) subcatSel.value = prevValue;
        }

        function renderWordList() {
            updateWlSubcatOptions();
            const search = normalize(document.getElementById('wl-search').value);
            const cat = document.getElementById('wl-filter').value;
            const subcat = document.getElementById('wl-subcat-filter') ? document.getElementById('wl-subcat-filter').value : '';
            const statusFilter = document.getElementById('wl-status-filter').value;
            const sortMode = document.getElementById('wl-sort').value;
            let items = fullDb;
            if (cat) items = items.filter(i => i.file === cat);
            if (subcat) items = items.filter(i => i.sousCategorie === subcat);
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
                    ${speakBtnHtml(i.nl)}
                    ${niveauCECRBadgeHtml(i.niveauCECR)}
                    <span class="wl-badge ${st}">${badgeLabel[st]}</span>
                    <span class="wl-file">${i.file}${i.sousCategorie ? ' · ' + i.sousCategorie : ''}${freqTxt ? ' · ' + freqTxt : ''}</span>
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
            setActiveNav('nav-reviser');
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
            // Sécurité anti-friction : si l'utilisateur quitte l'écran d'exercice via un onglet
            // principal (la barre du bas reste visible partout) pendant que l'auto-avance est en
            // attente, on annule ce minuteur plutôt que de le laisser rappeler nextExercise() sur un
            // tout autre écran quelques instants plus tard.
            clearTimeout(exerciseAutoAdvanceTimer);
            document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.remove('active'));
            const btn = document.getElementById(id);
            if (btn) btn.classList.add('active');
            // showLesson()/showExercise() n'appellent jamais setActiveNav (ce sont des sous-vues
            // atteintes depuis Apprendre) : ce point ne se déclenche donc que lorsque l'utilisateur
            // rejoint un onglet principal (Accueil, Apprendre, Révision, Jeux, Roleplay, etc.), ce
            // qui correspond exactement à "choisir autre chose" librement — on sort alors du flux
            // guidé sans jamais bloquer ni demander de confirmation.
            endGuidedFlow();
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
            setActiveNav('nav-home');
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
            setActiveNav('nav-home');
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
            // Écoute de la bonne réponse : seulement quand elle est en néerlandais (l'autre sens de
            // traduction — nl2fr — donnerait la réponse en français, que la voix NL prononcerait mal).
            const speakSuffix = answerField === 'nl' ? ' ' + speakBtnHtml(accepted[0]) + translateBtnHtml(accepted[0]) : '';

            if (result.status === 'correct') {
                fb.innerHTML = "✅ BRAVO ! → " + correctAnswer + speakSuffix + (multi ? "  (plusieurs réponses acceptées)" : "")
                    + (articleMistake ? "  (⚠️ attention à de/het — envoyé en révision déterminants)" : "");
                fb.style.color = "var(--success)";
                state.xp += 10;
                markMastered(currentItem);
                registerResult(currentItem.id, true);
                save();
                setTimeout(goToNext, 1400);
            } else if (result.status === 'close') {
                const note = result.particleOrder ? " (⚠️ attention à l'ordre/la place de la particule)" : " (petite faute)";
                fb.innerHTML = "🟡 PRESQUE !" + note + " → " + correctAnswer + speakSuffix;
                fb.style.color = "var(--gold)";
                state.xp += 5;
                markMastered(currentItem);
                registerResult(currentItem.id, true);
                save();
                setTimeout(goToNext, 1600);
            } else {
                fb.innerHTML = "❌ RÉPONSE" + (multi ? "S POSSIBLES : " : " : ") + correctAnswer + speakSuffix;
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
            setActiveNav('nav-reviser');
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
            setActiveNav('nav-reviser');
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
            const speakSuffix = answerField === 'nl' ? ' ' + speakBtnHtml(correctAnswer) + translateBtnHtml(correctAnswer) : '';
            if (result.status === 'correct') {
                taScore++;
                state.xp += 3;
                markMastered(taCurrent);
                registerResult(taCurrent.id, true);
                save();
                document.getElementById('ta-score').innerText = 'Score : ' + taScore;
                fb.innerHTML = '✅ ' + correctAnswer + speakSuffix;
                fb.style.color = 'var(--success)';
            } else if (result.status === 'close') {
                taScore += 0.5;
                state.xp += 1;
                markMastered(taCurrent);
                registerResult(taCurrent.id, true);
                save();
                document.getElementById('ta-score').innerText = 'Score : ' + taScore;
                fb.innerHTML = '🟡 presque : ' + correctAnswer + speakSuffix;
                fb.style.color = 'var(--gold)';
            } else {
                registerResult(taCurrent.id, false);
                save();
                fb.innerHTML = '❌ ' + correctAnswer + speakSuffix;
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
            setActiveNav('nav-reviser');
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
            setActiveNav('nav-profil');
        }

        // ===== Configuration Gemini centralisée (Profil → 🤖 Intelligence IA) =====
        // SOURCE UNIQUE de configuration Gemini dans toute l'application : localStorage
        // 'gemini_api_key', lu exclusivement via GeminiService.getKey()/isAvailable(). Le Roleplay
        // (renderRpGeminiStatus) et la Production (submitProduction) ne font que LIRE cet état, ils
        // ne le gèrent plus chacun de leur côté.
        function renderGeminiConfigBlock() {
            const configured = GeminiService.isAvailable();
            return `
                <div class="study-box" style="margin-top:15px;">
                    <h3>🤖 Intelligence IA</h3>
                    <p style="font-size:0.85rem;">Utilisée pour les corrections, le jeu de rôle vocal et la production écrite/orale. Ta clé reste uniquement sur cet appareil — elle n'est jamais envoyée dans ta sauvegarde cloud avec ta progression.</p>
                    <p style="font-weight:bold; color:${configured ? 'var(--success)' : 'var(--wrong)'};">${configured ? '✅ Clé configurée' : '❌ Aucune clé configurée'}</p>
                    <input type="password" id="gemini-key-input" placeholder="Colle ta clé API Gemini ici...">
                    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                        <button class="btn btn-green" onclick="geminiSaveKeyFromProfil()">💾 Enregistrer</button>
                        <button class="btn btn-gray" onclick="geminiTestConnection()">🔌 Tester la connexion</button>
                        ${configured ? `<button class="btn btn-red" onclick="geminiRemoveKey()">🗑️ Supprimer</button>` : ''}
                    </div>
                    <p id="gemini-test-result" style="font-size:0.85rem; margin-top:8px;"></p>
                    <small style="color: var(--text); opacity:0.7;">Pas encore de clé ? <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color: var(--primary); font-weight: 600;">Obtiens-en une gratuitement sur Google AI Studio →</a></small>
                </div>`;
        }

        function geminiSaveKeyFromProfil() {
            const input = document.getElementById('gemini-key-input');
            const val = input ? input.value.trim() : '';
            if (!val) { alert("Colle une clé avant d'enregistrer."); return; }
            localStorage.setItem('gemini_api_key', val);
            renderProfil();
        }

        function geminiRemoveKey() {
            const ok = confirm('Supprimer la clé API Gemini enregistrée sur cet appareil ?');
            if (!ok) return;
            localStorage.removeItem('gemini_api_key');
            renderProfil();
        }

        async function geminiTestConnection() {
            const result = document.getElementById('gemini-test-result');
            if (!result) return;
            if (!GeminiService.isAvailable()) {
                result.style.color = 'var(--wrong)';
                result.innerText = 'Aucune clé enregistrée.';
                return;
            }
            result.style.color = 'var(--text-secondary)';
            result.innerText = 'Test en cours...';
            try {
                await GeminiService.generate('Réponds uniquement par le mot "ok".');
                result.style.color = 'var(--success)';
                result.innerText = '✅ Connexion réussie.';
            } catch (e) {
                result.style.color = 'var(--wrong)';
                result.innerText = '❌ Échec : ' + e.message;
            }
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
            const masteredNotions = curriculumLoaded
                ? Object.keys(curriculumNotions).filter(id => curriculumNotions[id].status === 'pret' && getNotionStatus(id) === 'maitrisee').length
                : 0;

            // Profil = centre personnel : compte, niveau CECR réel (curriculum), maîtrise, XP,
            // streak, couverture lexicale par catégorie, points faibles, historique de placement,
            // et configuration Gemini centralisée — tout relit des moteurs déjà existants.
            const compteSnapshotHtml = currentUser && currentUserDoc
                ? `<div class="dash-card dash-secondary-card" style="cursor:pointer;" onclick="showCompte()">
                       <div class="dash-secondary-label">👤 ${currentUserDoc.pseudo}</div>
                       <div class="dash-secondary-sub">Compte connecté · progression synchronisée</div>
                   </div>`
                : `<div class="dash-card dash-secondary-card" style="cursor:pointer;" onclick="showCompte()">
                       <div class="dash-secondary-label">🔓 Non connecté</div>
                       <div class="dash-secondary-sub">Crée un compte pour synchroniser ta progression entre appareils</div>
                   </div>`;

            const cecrInfo = curriculumLoaded ? getCurriculumLevel() : { level: (curriculumLevels[0] && curriculumLevels[0].id) || 'A1', stats: [] };
            const cecrBarsHtml = (cecrInfo.stats || []).map(s => `
                <div class="placement-level-row">
                    <span class="placement-level-name">${s.level}</span>
                    <div class="module-progress-bar"><div class="module-progress-fill" style="width:${s.pct}%"></div></div>
                    <span class="module-progress-pct">${s.pct}%</span>
                </div>
                <div style="font-size:0.72rem; color:var(--text-secondary); margin:-6px 0 10px 80px;">${s.statusLabel} · ${s.mastered}/${s.total} notions</div>`).join('');

            const vocabCategories = getVocabCoverageByCategory();
            const vocabBarsHtml = vocabCategories.map(c => `
                <div class="placement-level-row">
                    <span class="placement-level-name" style="width:170px;">${c.label}</span>
                    <div class="module-progress-bar"><div class="module-progress-fill" style="width:${c.pct}%"></div></div>
                    <span class="module-progress-pct">${c.pct}%</span>
                </div>`).join('');

            const weaknesses = curriculumLoaded ? getWeaknesses().slice(0, 5) : [];
            const weaknessesHtml = weaknesses.length ? weaknesses.map(w => `
                <div class="hub-card" onclick="showLesson('${w.id}')">
                    <div class="hub-card-title">${getNotionStatusLabel(w.status)} — ${(w.notion.content.titre || w.id.replace(/_/g, ' '))}</div>
                    <div class="dash-mini-bar"><div class="dash-mini-fill" style="width:${w.mastery * 20}%"></div></div>
                    ${NOTION_TARGETED_PRACTICE[w.id] ? `<button class="gemini-explain-btn" onclick="event.stopPropagation(); rpStartTargetedPractice('${w.id}')">🎯 Pratiquer à l'oral cette notion</button>` : ''}
                </div>`).join('') : `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucun point faible identifié pour l'instant 🎉</p>`;

            const placementHistory = (state.placement.history || []).slice().reverse().slice(0, 5);
            const placementHistoryHtml = placementHistory.length ? placementHistory.map(h => {
                const dateStr = new Date(h.timestamp).toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const sourceLabel = h.mode === 'test' ? 'Test adaptatif'
                    : h.mode === 'declare' ? `Niveau déclaré : ${h.anchorLevel}`
                    : h.mode === 'external' ? `${h.externalSource} → ${h.anchorLevel}`
                    : 'Départ normal';
                return `<div class="hub-card" style="cursor:default;">
                    <div class="hub-card-title">${dateStr} — ${sourceLabel}</div>
                    <div class="hub-card-desc">Niveau estimé : ${h.estimatedLevel} · confiance ${h.confidence} · ${h.testedCount} notion${h.testedCount > 1 ? 's' : ''} testée${h.testedCount > 1 ? 's' : ''}</div>
                </div>`;
            }).join('') : `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucune évaluation de niveau effectuée pour l'instant.</p>`;

            document.getElementById('profil-content').innerHTML = `
                ${compteSnapshotHtml}
                <div class="profil-stat-grid">
                    <div class="profil-stat-tile"><div class="ps-num">${cecrInfo.level}</div><div class="ps-label">Niveau CECR</div></div>
                    <div class="profil-stat-tile"><div class="ps-num">⭐ ${state.xp || 0}</div><div class="ps-label">XP</div></div>
                    <div class="profil-stat-tile"><div class="ps-num">🔥 ${state.stats.dailyStreak || 0}</div><div class="ps-label">Jours de suite</div></div>
                    <div class="profil-stat-tile"><div class="ps-num">${masteredNotions}</div><div class="ps-label">Notions maîtrisées</div></div>
                </div>
                <div class="profil-menu">
                    <div class="profil-menu-row" onclick="showPlacementIntro()"><span class="pm-icon">🚀</span><span>Évaluer mon niveau</span><span class="pm-chevron">›</span></div>
                    <div class="profil-menu-row" style="cursor:pointer;" onclick="toggleFreeAccess(${!state.freeAccess})">
                        <span class="pm-icon">${state.freeAccess ? '🔓' : '🔒'}</span>
                        <span>Mode libre (accès à toutes les leçons)</span>
                        <span class="pm-chevron">${state.freeAccess ? 'Activé' : 'Désactivé'}</span>
                    </div>
                    ${state.freeAccess ? `<p style="font-size:0.72rem; color:var(--text-secondary); margin:-8px 0 var(--space-2) 14px;">Tu peux sauter le déverrouillage progressif et aller direct où tu veux (ex. B2). Ce n'est pas l'ordre recommandé — les notions plus avancées supposent souvent des prérequis non travaillés — mais rien ne t'en empêche.</p>` : ''}
                    <div class="profil-menu-row" onclick="showTestSelect()"><span class="pm-icon">🎯</span><span>Test de vocabulaire</span><span class="pm-chevron">›</span></div>
                    <div class="profil-menu-row" onclick="showSocial()"><span class="pm-icon">👥</span><span>Amis, défis & sessions</span><span class="pm-chevron">›</span></div>
                    <div class="profil-menu-row" onclick="showInfo()"><span class="pm-icon">ℹ️</span><span>Infos</span><span class="pm-chevron">›</span></div>
                    <div class="profil-menu-row" onclick="showCompte()"><span class="pm-icon">🔐</span><span>Compte</span><span class="pm-chevron">›</span></div>
                </div>

                <div class="study-box" style="text-align:left;">
                    <h3>📚 Progression du curriculum (par niveau CECR)</h3>
                    ${curriculumLoaded ? cecrBarsHtml : `<p style="font-size:0.85rem; color:var(--text-secondary);">Chargement du programme...</p>`}
                </div>

                <div class="study-box" style="text-align:left;">
                    <h3>🧠 Couverture du vocabulaire</h3>
                    <p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:10px;">Proportion approximative du vocabulaire de référence que tu maîtrises déjà — une statistique indépendante de ton niveau CECR, pas un second calcul de niveau.</p>
                    <div class="placement-level-row"><span class="placement-level-name" style="width:170px;">Ensemble du vocabulaire</span><div class="module-progress-bar"><div class="module-progress-fill" style="width:${vp.pct}%"></div></div><span class="module-progress-pct">${vp.pct}%</span></div>
                    ${vocabBarsHtml}
                </div>

                <div class="study-box" style="text-align:left;">
                    <h3>🎯 Points faibles</h3>
                    ${weaknessesHtml}
                </div>

                <div class="study-box" style="text-align:left;">
                    <h3>🕓 Historique de placement</h3>
                    ${placementHistoryHtml}
                </div>

                ${renderGeminiConfigBlock()}

                <div class="study-box" style="text-align:left;">
                    <h3>📊 Mes statistiques</h3>
                    <p>Mots vus au moins une fois : ${totalDistinctSeen}<br>
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
            reader.onload = async (e) => {
                try {
                    const imported = JSON.parse(e.target.result);
                    if (!imported || typeof imported !== 'object' || !imported.stats) {
                        alert("Fichier invalide : ce n'est pas une sauvegarde reconnaissable.");
                        return;
                    }
                    const ok = confirm("Ceci va REMPLACER entièrement ta progression actuelle par celle du fichier importé. Continuer ?");
                    if (!ok) return;
                    if (currentUser) {
                        // Connecté : l'import doit aussi remplacer la progression du compte, sinon
                        // la prochaine synchro la fusionnerait avec l'ancienne.
                        if (!(await cloudOverwrite(imported))) {
                            alert("Impossible de joindre le cloud : l'import n'a pas été appliqué. Vérifie ta connexion et réessaie.");
                            return;
                        }
                    } else {
                        localStorage.setItem('nl_platform_v1', JSON.stringify(imported));
                    }
                    alert("Import réussi ! La page va se recharger.");
                    location.reload();
                } catch (err) {
                    alert("Erreur : le fichier n'a pas pu être lu (" + err.message + ").");
                }
            };
            reader.readAsText(file);
        }

        async function resetProgress() {
            const confirm1 = confirm("Es-tu sûr ? Toute ta progression (XP, mots maîtrisés, listes perso, stats, high scores) sera effacée définitivement.");
            if (!confirm1) return;
            const confirm2 = prompt('Pour confirmer, tape "RESET" en majuscules :');
            if (confirm2 !== 'RESET') { alert("Réinitialisation annulée."); return; }
            if (currentUser) {
                // Connecté : la remise à zéro doit aussi s'appliquer au compte, sinon la
                // progression reviendrait du cloud à la prochaine synchro.
                if (!(await cloudOverwrite({ xp: 0, mastered: [] }))) {
                    alert("Impossible de joindre le cloud : la réinitialisation n'a pas été appliquée. Vérifie ta connexion et réessaie.");
                    return;
                }
            } else {
                localStorage.removeItem('nl_platform_v1');
            }
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
            setActiveNav('nav-profil');
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
            const speakSuffix = answerField === 'nl' ? ' ' + speakBtnHtml(correctAnswer) + translateBtnHtml(correctAnswer) : '';
            fb.innerHTML = (isCorrect ? '✅ ' + correctAnswer : '❌ ' + correctAnswer) + speakSuffix;
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
            syncMarkDirty();
            updateStats();
            scheduleCloudSync();
            scheduleFriendStatsSync();
        }

        // Niveau CECR basé sur le % de vocabulaire distinct maîtrisé.
        // PHRASES_LABO est exclu du total : ce sont des phrases qui réutilisent des mots
        // déjà comptés ailleurs (verbes/noms/adjectifs/thèmes), donc les compter en plus fausserait le %.
        // ===== Couverture lexicale (statistique de vocabulaire, INDÉPENDANTE du niveau CECR) =====
        // Répond uniquement à « quelle proportion du vocabulaire de référence est-ce que je
        // connais ? ». Ne détermine plus aucun niveau CECR (voir getCurriculumLevel plus haut, qui
        // seul fait autorité pour le niveau global) — `tier`/`nextTier` ne sont que des paliers de
        // couverture lexicale internes, gardés uniquement pour la mécanique "mots avant le palier
        // suivant", jamais affichés comme un niveau CECR.
        function getVocabProgress() {
            const vocabItems = fullDb.filter(i => i.file !== 'PHRASES_LABO');
            const totalVocab = vocabItems.length;
            const masteredVocab = vocabItems.filter(i => isMasteredAnyDirection(i.id)).length;
            const pct = totalVocab > 0 ? Math.round((masteredVocab / totalVocab) * 100) : 0;
            const thresholds = [
                { tier: 1, min: 0 }, { tier: 2, min: 15 },
                { tier: 3, min: 35 }, { tier: 4, min: 65 }
            ];
            let tier = 1, nextTier = 2, nextThresholdPct = 15;
            for (let i = 0; i < thresholds.length; i++) {
                if (pct >= thresholds[i].min) {
                    tier = thresholds[i].tier;
                    nextTier = thresholds[i + 1] ? thresholds[i + 1].tier : null;
                    nextThresholdPct = thresholds[i + 1] ? thresholds[i + 1].min : null;
                }
            }
            const wordsToNext = nextThresholdPct !== null
                ? Math.max(0, Math.ceil((nextThresholdPct / 100) * totalVocab) - masteredVocab)
                : 0;
            return { pct, tier, nextTier, wordsToNext, totalVocab, masteredVocab };
        }

        // Regroupe le vocabulaire déjà chargé (voir init/loadFile, propriété `file` de chaque item
        // de fullDb) en catégories lisibles, en réutilisant exclusivement les fichiers CSV déjà
        // existants — aucun nouveau dataset. Une catégorie dont aucun fichier n'est chargé est
        // simplement omise plutôt qu'affichée à 0%.
        const VOCAB_CATEGORY_FILES = {
            'Vocabulaire courant': ['NOMS_NL', 'ADJECTIFS_NL', 'ADVERBES_NL', 'MOTS_OUTILS_NL'],
            'Verbes fréquents': ['VERBES_NL'],
            'Expressions courantes': ['THEME_BASE', 'PHRASES_LABO', 'EXPRESSIONS_NL'],
            'Vocabulaire professionnel': ['MOTS_LABO', 'THEME_MARKETING', 'THEME_FINANCE', 'THEME_COMPTABILITE', 'THEME_LOGISTIQUE', 'THEME_SUPPLYCHAIN', 'THEME_MANAGEMENT', 'THEME_RH', 'THEME_ENTRETIEN']
        };

        function getVocabCoverageByCategory() {
            return Object.keys(VOCAB_CATEGORY_FILES).map(label => {
                const items = fullDb.filter(i => VOCAB_CATEGORY_FILES[label].includes(i.file));
                const mastered = items.filter(i => isMasteredAnyDirection(i.id)).length;
                const pct = items.length ? Math.round((mastered / items.length) * 100) : 0;
                return { label, pct, total: items.length, mastered };
            }).filter(c => c.total > 0);
        }

        function updateStats() {
            const level = curriculumLoaded ? getCurriculumLevel().level : ((curriculumLevels[0] && curriculumLevels[0].id) || 'A1');
            document.getElementById('cecr-badge').innerText = level;
            const xpBadge = document.getElementById('xp-mini-badge');
            if (xpBadge) xpBadge.innerText = `⭐ ${state.xp || 0} XP`;
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
        // Généralisation de la reconnaissance vocale : par défaut elle pilote les ids du jeu de
        // rôle (rp-mic-btn/rp-status) et le flux existant (rpAppendMessage + rpSendToGemini).
        // Le module Production (voir plus haut) la réutilise à l'identique en repointant ces
        // variables temporairement, via productionToggleVoiceCapture — aucun deuxième moteur de
        // reconnaissance vocale n'est créé.
        let activeVoiceBtnId = 'rp-mic-btn';
        let activeVoiceStatusId = 'rp-status';
        let voiceTranscriptCallback = null;

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

        // ===== Secours "mode script" (hors-ligne) =====
        // Activé automatiquement quand Gemini est indisponible (pas de clé, ou une erreur réseau/
        // quota en cours de conversation) : un mini-dialogue linéaire à choix (2 options par étape,
        // 3 étapes) pour ne jamais laisser l'apprenant bloqué sans pratique. Ne remplace pas Gemini
        // : c'est un filet de secours au contenu volontairement plus simple, pour les 18 scénarios
        // de RP_SCENARIOS. Les 6 scénarios de Pratique ciblée (NOTION_TARGETED_PRACTICE) n'ont pas
        // de version scriptée dans cette première passe (portée volontairement limitée).
        const RP_SCRIPTED_FALLBACK = {
            interview_transportplanner_kennismaking: [
                { choices: ["Ik ben gemotiveerd en leergierig, met ervaring in logistiek.", "Ik zoek vooral een stabiele baan dicht bij huis."],
                  ai: "Goed om te horen. Waarom spreekt de functie van transportplanner jou precies aan?" },
                { choices: ["Ik hou van plannen en het oplossen van problemen onder tijdsdruk.", "Ik wil vooral met mensen samenwerken, chauffeurs en klanten."],
                  ai: "Dat past goed bij de functie. En hoe voel jij je om dagelijks in het Nederlands te werken?" },
                { choices: ["Ik voel me steeds zekerder, ik oefen elke dag.", "Het is nog een uitdaging, maar ik leer snel bij."],
                  ai: "Bedankt voor je eerlijke antwoord. We nemen contact op voor de volgende stap. Fijne dag nog!" }
            ],
            interview_sc_phone: [
                { choices: ["Ik ben beschikbaar vanaf volgende maand.", "Ik kan onmiddellijk beginnen."],
                  ai: "Prima. Kan je kort vertellen waarom je solliciteert voor deze functie?" },
                { choices: ["Ik heb ervaring met voorraadbeheer in een magazijn.", "Ik heb geen directe ervaring, maar ik leer snel."],
                  ai: "Dat is nuttig om te weten. Ken je Excel of SAP een beetje?" },
                { choices: ["Ja, ik gebruik Excel regelmatig.", "Een beetje, maar ik wil me verder verdiepen."],
                  ai: "Goed, we nemen dit mee en contacteren je snel voor een volgend gesprek." }
            ],
            interview_sc_technical: [
                { choices: ["Ik zou eerst de oorzaak van het tekort analyseren.", "Ik zou meteen extra voorraad bijbestellen."],
                  ai: "Interessant. En hoe zou je de levering aan de klant intussen beheren?" },
                { choices: ["Ik zou de klant proactief informeren over de vertraging.", "Ik zou prioriteit geven aan de belangrijkste klanten."],
                  ai: "Goede reflex. Gebruik je weleens Excel of Power BI om zulke situaties op te volgen?" },
                { choices: ["Ja, ik maak overzichten om de voorraad op te volgen.", "Nog niet veel, maar ik wil dat graag leren."],
                  ai: "Bedankt, dat geeft me een goed beeld van je aanpak." }
            ],
            interview_sc_final: [
                { choices: ["Ik werk graag in teamverband en deel graag kennis.", "Ik werk het liefst zelfstandig aan mijn taken."],
                  ai: "Goed om te weten. Wat verwacht je van deze functie op lange termijn?" },
                { choices: ["Ik wil groeien naar meer verantwoordelijkheid.", "Ik wil vooral stabiliteit en een goede werksfeer."],
                  ai: "Dat is duidelijk. Heb je nog vragen over het team of de volgende stappen?" },
                { choices: ["Ja, wanneer zou ik kunnen starten?", "Nee, alles is duidelijk voor mij."],
                  ai: "Perfect, we laten snel iets van ons horen. Bedankt voor het gesprek!" }
            ],
            interview_consult_phone: [
                { choices: ["Ik ben net afgestudeerd en wil graag in consultancy starten.", "Ik heb al wat ervaring en zoek een nieuwe uitdaging."],
                  ai: "Mooi. Ben je bereid om regelmatig bij klanten ter plaatse te werken?" },
                { choices: ["Ja, dat vind ik zelfs een pluspunt.", "Ja, al geef ik de voorkeur aan een beperkte reisafstand."],
                  ai: "Begrepen. Heb je al ervaring met Excel of Power BI?" },
                { choices: ["Ja, ik gebruik die tools regelmatig.", "Beperkt, maar ik leer graag snel bij."],
                  ai: "Dank je, we nemen snel contact op voor de volgende stap." }
            ],
            interview_consult_technical: [
                { choices: ["Ik zou eerst de oorzaak van het probleem in kaart brengen.", "Ik zou meteen een oplossing voorstellen aan de klant."],
                  ai: "Goede aanpak. Hoe zou je dit vervolgens aan de klant communiceren?" },
                { choices: ["Ik zou het duidelijk en stap voor stap uitleggen.", "Ik zou een kort rapport met cijfers voorbereiden."],
                  ai: "Dat klinkt professioneel. Hoe ga je om met een klant die niet tevreden is?" },
                { choices: ["Ik luister eerst goed naar de klacht voor ik reageer.", "Ik probeer meteen een concrete oplossing aan te bieden."],
                  ai: "Bedankt, dat is een goede reflex in consultancy." }
            ],
            interview_consult_final: [
                { choices: ["Ik zie mezelf hier op lange termijn groeien.", "Ik wil eerst ervaring opdoen en dan verder zien."],
                  ai: "Dat is een eerlijk antwoord. Hoe ga je om met de drukte van klantenopdrachten?" },
                { choices: ["Ik plan mijn taken goed en vraag hulp indien nodig.", "Ik werk het liefst onder een beetje druk, dat motiveert me."],
                  ai: "Goed om te horen. Heb je nog vragen voor mij?" },
                { choices: ["Ja, hoe ziet de eerste maand er ongeveer uit?", "Nee, ik denk dat alles duidelijk is."],
                  ai: "Prima, we nemen snel contact op. Bedankt voor je tijd!" }
            ],
            interview_hr_phone: [
                { choices: ["Ik hou van contact met mensen en overtuigen.", "Ik wil graag in een dynamische sector werken."],
                  ai: "Mooi. Heb je al ervaring met klantcontact of verkoop?" },
                { choices: ["Ja, ik heb ervaring met klantcontact.", "Niet direct, maar ik leer graag snel bij."],
                  ai: "Goed om te weten. Ben je beschikbaar voor een volgend gesprek deze week?" },
                { choices: ["Ja, ik ben flexibel deze week.", "Ik moet even mijn agenda checken, maar het lukt zeker."],
                  ai: "Perfect, we nemen snel contact met je op." }
            ],
            interview_hr_technical: [
                { choices: ["Ik zou geduldig zijn en de voordelen van de functie benadrukken.", "Ik zou vragen wat hem precies tegenhoudt."],
                  ai: "Goede reflex. En hoe ga je om met een kandidaat die je moet afwijzen?" },
                { choices: ["Ik geef eerlijke en constructieve feedback.", "Ik hou het kort maar vriendelijk."],
                  ai: "Dat is belangrijk in recruitment. Hoe overtuig je een klant om een profiel te overwegen?" },
                { choices: ["Ik leg duidelijk de sterktes van het profiel uit.", "Ik toon concrete voorbeelden van vergelijkbare profielen."],
                  ai: "Bedankt, dat geeft een goed beeld van je aanpak." }
            ],
            interview_hr_final: [
                { choices: ["Ik zie mezelf als een ervaren consultant met eigen klanten.", "Ik wil vooral goed worden in wat ik nu doe."],
                  ai: "Mooi vooruitzicht. Wat motiveert jou het meest in recruitment?" },
                { choices: ["Het gevoel dat ik iemand aan een baan help.", "De uitdaging om het juiste profiel te vinden."],
                  ai: "Mooi antwoord. Heb je nog vragen over het team?" },
                { choices: ["Ja, hoe is de sfeer binnen het team?", "Nee, ik denk dat ik voldoende weet."],
                  ai: "Bedankt voor het gesprek, we laten snel iets weten!" }
            ],
            admin_cpas: [
                { choices: ["Ik kom informatie vragen over een aanvraag.", "Ik heb een afspraak met een maatschappelijk werker."],
                  ai: "Goed, heeft u de nodige documenten bij, zoals uw identiteitskaart?" },
                { choices: ["Ja, ik heb alles bij me.", "Nee, welke documenten heb ik precies nodig?"],
                  ai: "Geen probleem, ik leg u zo uit welke documenten nodig zijn. Is er nog iets anders?" },
                { choices: ["Nee, dat was alles, bedankt.", "Ja, ik heb nog een korte vraag."],
                  ai: "Prima, u kan hier terecht aan het loket. Nog een fijne dag verder!" }
            ],
            admin_medecin: [
                { choices: ["Ik heb al een paar dagen keelpijn.", "Ik voel me moe en heb een beetje hoofdpijn."],
                  ai: "Sinds wanneer heeft u last van deze klachten precies?" },
                { choices: ["Sinds ongeveer drie dagen.", "Sinds het begin van deze week."],
                  ai: "Begrepen. Heeft u nog andere klachten, zoals koorts?" },
                { choices: ["Nee, verder niets bijzonders.", "Een klein beetje, maar niet erg hoog."],
                  ai: "Goed, ik schrijf u iets voor. Rust goed uit en drink voldoende water." }
            ],
            admin_mutuelle: [
                { choices: ["Ik heb een vraag over de terugbetaling van een doktersbezoek.", "Ik wil mijn Europese ziekteverzekeringskaart aanvragen."],
                  ai: "Prima, heeft u het betreffende document of getuigschrift bij de hand?" },
                { choices: ["Ja, ik heb het hier bij me.", "Nee, moet ik dat nog opsturen?"],
                  ai: "Dat kan, u kan het gewoon nog binnenbrengen of opsturen. Nog een andere vraag?" },
                { choices: ["Nee, dat was alles.", "Ja, hoelang duurt de terugbetaling ongeveer?"],
                  ai: "Meestal enkele weken. Bedankt voor uw geduld en nog een fijne dag!" }
            ],
            admin_commune: [
                { choices: ["Ik kom mijn adres wijzigen.", "Ik heb een nieuwe identiteitskaart nodig."],
                  ai: "Goed, heeft u de nodige documenten bij zich voor deze aanvraag?" },
                { choices: ["Ja, ik heb alles bij.", "Welke documenten heb ik precies nodig?"],
                  ai: "Ik leg u dat graag uit. Is dit voor uzelf alleen, of voor het hele gezin?" },
                { choices: ["Enkel voor mezelf.", "Voor mezelf en mijn partner."],
                  ai: "Begrepen, we regelen dat meteen voor u. Nog een fijne dag!" }
            ],
            call_standard: [
                { choices: ["Ik zou graag met de personeelsdienst spreken.", "Ik heb een algemene vraag over uw diensten."],
                  ai: "Een ogenblikje, mag ik weten waarover het precies gaat?" },
                { choices: ["Het gaat over een sollicitatie.", "Het gaat over een lopende bestelling."],
                  ai: "Dank u, ik verbind u door. Wenst u nog iets anders te vermelden?" },
                { choices: ["Nee, dat was alles, bedankt.", "Ja, kan u mij ook een e-mailadres geven?"],
                  ai: "Natuurlijk, dat regel ik voor u. Nog een prettige dag!" }
            ],
            call_rdv: [
                { choices: ["Ik zou graag een afspraak willen maken.", "Ik bel om een bestaande afspraak te verzetten."],
                  ai: "Prima, wat is de reden van de afspraak?" },
                { choices: ["Het gaat om een administratieve zaak.", "Het gaat om een eerste kennismaking."],
                  ai: "Begrepen. Wanneer past het u het beste, deze of volgende week?" },
                { choices: ["Deze week zou perfect zijn.", "Volgende week komt mij beter uit."],
                  ai: "Genoteerd, ik bevestig de afspraak per e-mail. Bedankt voor uw telefoontje!" }
            ],
            call_suivi_candidature: [
                { choices: ["Ik bel over mijn sollicitatie van vorige week.", "Ik wil graag weten of mijn dossier al bekeken is."],
                  ai: "Voor welke functie precies, en wanneer heeft u gesolliciteerd?" },
                { choices: ["Het gaat om de functie van transportplanner.", "Het gaat om een functie in de logistiek."],
                  ai: "Dank u, uw dossier wordt momenteel nog bekeken door het team." },
                { choices: ["Oké, weet u ongeveer wanneer ik iets hoor?", "Prima, ik wacht rustig af, bedankt."],
                  ai: "We nemen binnen de twee weken contact met u op. Bedankt voor uw geduld!" }
            ],
            cafe: [
                { choices: ["Mag ik een koffie en een croissant, alstublieft?", "Ik zou graag het menu even willen bekijken."],
                  ai: "Natuurlijk, hier is het menu. Wenst u er ook iets bij te drinken?" },
                { choices: ["Ja, graag een water erbij.", "Nee, dat is voldoende voor mij, dank u."],
                  ai: "Prima, dat is dan geregeld. Wenst u binnen of op het terras te zitten?" },
                { choices: ["Op het terras, als het kan.", "Binnen is prima, dank u."],
                  ai: "Perfect, ik breng het zo naar u toe. Smakelijk alvast!" }
            ]
        };

        let rpScriptedActive = false;
        let rpScriptedStepIndex = 0;

        // Bascule vers le mode script pour le scénario en cours (appelée automatiquement si Gemini
        // n'est pas configuré au démarrage, ou manuellement après une erreur Gemini en cours de
        // conversation). Ne touche jamais RP_SCENARIOS : lit uniquement RP_SCRIPTED_FALLBACK via
        // l'id du scénario courant.
        function rpEnterScriptedMode() {
            if (!rpCurrentScenario || !RP_SCRIPTED_FALLBACK[rpCurrentScenario.id]) {
                alert("Le mode script n'est pas encore disponible pour ce scénario précis. Essaie un autre scénario, ou configure Gemini dans Profil → 🤖 Intelligence IA.");
                return;
            }
            rpScriptedActive = true;
            rpScriptedStepIndex = 0;
            if (rpIsRecording && rpRecognition) rpRecognition.stop();

            const micBtn = document.getElementById('rp-mic-btn');
            if (micBtn) micBtn.style.display = 'none';
            const textRow = document.getElementById('rp-text-row');
            if (textRow) textRow.style.display = 'none';

            const banner = document.getElementById('rp-mode-banner');
            if (banner) {
                banner.style.display = '';
                banner.innerHTML = `<p style="font-size:0.78rem; background:var(--bg-tertiary); border-radius:8px; padding:8px 10px; color:var(--text-secondary);">📜 Mode script (sans IA) — choisis une réplique à chaque étape. Conversation plus courte et prévisible qu'avec Gemini.</p>`;
            }

            rpRenderScriptedStep();
        }

        function rpRenderScriptedStep() {
            const steps = RP_SCRIPTED_FALLBACK[rpCurrentScenario.id];
            const choicesDiv = document.getElementById('rp-scripted-choices');
            const statusDiv = document.getElementById('rp-status');

            if (rpScriptedStepIndex >= steps.length) {
                if (choicesDiv) { choicesDiv.style.display = 'none'; choicesDiv.innerHTML = ''; }
                if (statusDiv) statusDiv.innerText = "Fin de la pratique (mode script) — change de scénario pour continuer.";
                return;
            }

            const step = steps[rpScriptedStepIndex];
            if (choicesDiv) {
                choicesDiv.style.display = 'flex';
                choicesDiv.innerHTML = step.choices.map((c, i) =>
                    `<button class="rp-scenario-btn" onclick="rpChooseScriptedReply(${i})">${c}</button>`
                ).join('');
            }
            if (statusDiv) statusDiv.innerText = "Choisis une réplique";
        }

        function rpChooseScriptedReply(choiceIndex) {
            const steps = RP_SCRIPTED_FALLBACK[rpCurrentScenario.id];
            const step = steps[rpScriptedStepIndex];
            if (!step) return;

            rpAppendMessage(step.choices[choiceIndex], 'user');
            rpAppendMessage(step.ai, 'assistant');
            rpSpeakText(step.ai);

            rpScriptedStepIndex++;
            rpRenderScriptedStep();
        }

        function rpFindScenario(catKey, itemId) {
            const cat = RP_SCENARIOS[catKey];
            if (!cat) return null;
            const list = cat.groups ? cat.groups.flatMap(g => g.items) : cat.items;
            return list.find(i => i.id === itemId) || null;
        }

        // ===== Statut Gemini affiché dans le Roleplay — SOURCE UNIQUE : GeminiService/localStorage,
        // configuré depuis Profil → 🤖 Intelligence IA (voir renderGeminiConfigBlock). Le Roleplay
        // ne gère plus sa propre clé : il ne fait que lire l'état centralisé et rediriger vers
        // Profil si rien n'est configuré.
        function renderRpGeminiStatus() {
            const box = document.getElementById('rp-gemini-status');
            if (!box) return;
            const configured = GeminiService.isAvailable();
            box.innerHTML = configured
                ? `<p style="font-size:0.85rem; color:var(--success);">✅ Gemini configuré (clé gérée dans Profil → 🤖 Intelligence IA)</p><div id="rp-voice-warning"></div>`
                : `<p style="font-size:0.85rem; color:var(--wrong);">❌ Aucune clé Gemini configurée.</p>
                   <button class="btn btn-gray" onclick="showProfil()">Configurer dans Profil</button>
                   <div id="rp-voice-warning"></div>`;
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

            // Le navigateur arrête l'écoute de lui-même après un court silence (surtout sur
            // téléphone, où `continuous` est ignoré) : la réponse partait alors avant la fin de la
            // phrase, dès qu'on marquait une pause pour réfléchir. On distingue donc un arrêt
            // DEMANDÉ (clic sur le bouton, changement d'écran : tout appel à stop()) d'un arrêt
            // spontané : dans le second cas on garde ce qui a déjà été dit et on relance l'écoute.
            // Rien n'est envoyé tant que l'arrêt n'a pas été demandé.
            const nativeStart = rpRecognition.start.bind(rpRecognition);
            const nativeStop = rpRecognition.stop.bind(rpRecognition);
            let stopRequested = false;
            let carriedTranscript = '';   // ce qui a été reconnu avant la ou les relances
            let lastStartAt = 0;
            let quickEnds = 0;            // arrêts spontanés quasi immédiats à la suite (micro indisponible...)
            rpRecognition.start = function() {
                stopRequested = false;
                carriedTranscript = '';
                quickEnds = 0;
                lastStartAt = Date.now();
                nativeStart();
            };
            rpRecognition.stop = function() {
                stopRequested = true;
                nativeStop();
            };

            rpRecognition.onresult = function(event) {
                // On reconstruit le texte à partir de TOUS les résultats à chaque évènement, au lieu
                // d'ajouter au fur et à mesure. Sur Chrome Android en mode continu, chaque résultat
                // "final" reprend toute la phrase depuis le début ("ik", "ik ben", "ik ben hier") :
                // les additionner répétait la phrase plusieurs fois. Un segment qui prolonge le
                // texte déjà reconnu le remplace donc ; un segment déjà contenu est ignoré ; seul
                // un segment réellement nouveau (cas du desktop) est ajouté à la suite.
                let finalText = '';
                let interim = '';
                for (let i = 0; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript.trim();
                    if (!transcript) continue;
                    if (!event.results[i].isFinal) { interim += ' ' + transcript; continue; }
                    const acc = finalText.toLowerCase(), seg = transcript.toLowerCase();
                    if (!acc || seg.startsWith(acc)) finalText = transcript;
                    else if (!acc.endsWith(seg)) finalText += ' ' + transcript;
                }
                // Même garde pour le texte provisoire affiché pendant qu'on parle.
                interim = interim.trim();
                if (interim && finalText.toLowerCase().endsWith(interim.toLowerCase())) interim = '';
                rpFinalTranscript = finalText + ' ';
                const statusEl = document.getElementById(activeVoiceStatusId);
                if (statusEl) statusEl.innerText = "🎤 " + ((carriedTranscript + ' ' + rpFinalTranscript + interim).trim() || '...');
            };

            rpRecognition.onerror = function(event) {
                // "no-speech" = simple silence : pas une vraie erreur, l'écoute sera relancée par onend.
                if (event.error === 'no-speech') return;
                stopRequested = true; // micro refusé, réseau... : inutile de relancer en boucle
                const statusEl = document.getElementById(activeVoiceStatusId);
                if (statusEl) statusEl.innerText = "Erreur de reconnaissance vocale : " + event.error;
                rpStopRecordingUI();
            };

            rpRecognition.onend = function() {
                if (!stopRequested) {
                    // Arrêt spontané du navigateur : on met de côté ce qui a été dit et on relance.
                    carriedTranscript = (carriedTranscript + ' ' + rpFinalTranscript).trim();
                    rpFinalTranscript = '';
                    const now = Date.now();
                    quickEnds = (now - lastStartAt < 1000) ? quickEnds + 1 : 0;
                    lastStartAt = now;
                    if (quickEnds < 4) {
                        try { nativeStart(); return; } catch (e) { console.warn('Relance de l\'écoute impossible :', e); }
                    }
                }
                rpStopRecordingUI();
                const text = (carriedTranscript + ' ' + rpFinalTranscript).trim();
                carriedTranscript = '';
                rpFinalTranscript = '';
                if (voiceTranscriptCallback) {
                    const cb = voiceTranscriptCallback;
                    voiceTranscriptCallback = null;
                    if (text) cb(text);
                    return;
                }
                if (text) {
                    rpAppendUserTurn(text);
                    rpSendToGemini(text);
                }
            };
        }

        function rpToggleSpeechRecognition() {
            if (!window.SpeechRecognition) {
                alert("Ton navigateur ne supporte pas la reconnaissance vocale. Utilise Google Chrome.");
                return;
            }
            if (!GeminiService.getKey()) {
                alert("Renseigne d'abord ta clé API Gemini dans Profil → 🤖 Intelligence IA.");
                return;
            }
            // Remet la reconnaissance vocale sur le flux par défaut du jeu de rôle (au cas où
            // le module Production l'aurait temporairement repointée ailleurs).
            activeVoiceBtnId = 'rp-mic-btn';
            activeVoiceStatusId = 'rp-status';
            voiceTranscriptCallback = null;
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

        // Réutilisation générique de la reconnaissance vocale existante (rpRecognition) en dehors
        // du jeu de rôle, par exemple pour la Production orale. Ne crée pas un second moteur de
        // reconnaissance vocale : repointe seulement les ids d'affichage et le callback de fin.
        function productionToggleVoiceCapture(btnId, statusId, onFinalTranscript) {
            if (!window.SpeechRecognition) {
                alert("Ton navigateur ne supporte pas la reconnaissance vocale. Utilise Google Chrome.");
                return;
            }
            if (!GeminiService.getKey()) {
                alert("Renseigne d'abord ta clé API Gemini dans Profil → 🤖 Intelligence IA pour utiliser la reconnaissance vocale.");
                return;
            }
            if (rpIsRecording) {
                rpRecognition.stop();
                return;
            }
            activeVoiceBtnId = btnId;
            activeVoiceStatusId = statusId;
            voiceTranscriptCallback = onFinalTranscript;
            try {
                rpFinalTranscript = '';
                rpRecognition.start();
                rpStartRecordingUI();
            } catch (e) {
                console.error(e);
            }
        }

        function rpStartRecordingUI() {
            rpIsRecording = true;
            const btn = document.getElementById(activeVoiceBtnId);
            if (btn) { btn.classList.add('recording'); btn.innerText = "🛑 J'ai fini de parler"; }
            const st = document.getElementById(activeVoiceStatusId);
            if (st) st.innerText = "Parle en néerlandais...";
        }

        function rpStopRecordingUI() {
            rpIsRecording = false;
            const btn = document.getElementById(activeVoiceBtnId);
            if (btn) { btn.classList.remove('recording'); btn.innerText = "🎤 Cliquer pour parler"; }
            const st = document.getElementById(activeVoiceStatusId);
            if (st) st.innerText = "Prêt";
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
            const apiKey = GeminiService.getKey();
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
                    // Un interlocuteur à l'oral ne parle pas en gras ni en listes à puces.
                    const aiResponse = stripMarkdown(data.candidates[0].content.parts[0].text);
                    rpConversationHistory.push({ role: "model", parts: [{ text: aiResponse }] });
                    rpAppendMessage(aiResponse, 'assistant');
                    rpSpeakText(aiResponse);
                    document.getElementById('rp-status').innerText = "Prêt";
                } else {
                    throw new Error("Réponse invalide de l'API (pas de contenu retourné, peut-être bloqué par un filtre de sécurité)");
                }
            } catch (error) {
                console.error(error);
                // On retire le message de l'utilisateur qui vient d'échouer, pour ne pas fausser
                // l'historique si la conversation reprend ensuite en mode script.
                rpConversationHistory.pop();
                const statusDiv = document.getElementById('rp-status');
                if (RP_SCRIPTED_FALLBACK[rpCurrentScenario.id]) {
                    if (statusDiv) statusDiv.innerText = `Erreur Gemini : ${error.message}`;
                    const choicesDiv = document.getElementById('rp-scripted-choices');
                    if (choicesDiv) {
                        choicesDiv.style.display = 'flex';
                        choicesDiv.innerHTML = `<button class="rp-scenario-btn" onclick="rpEnterScriptedMode()">📜 Continuer en mode script (sans IA)</button>`;
                    }
                } else if (statusDiv) {
                    statusDiv.innerText = `Erreur : ${error.message}`;
                }
            }
        }

        function rpSpeakText(text) {
            // Délègue à speakNL (définie en haut du fichier) — même comportement qu'avant, mais
            // partagé avec le reste de l'app (Mots, Leçons, Conjugaison, feedback d'exercice) au
            // lieu d'être dupliqué.
            // Scénario réel mené en anglais : pas de lecture, la voix configurée est néerlandaise.
            if (rpCurrentScenario && rpCurrentScenario.lang === 'en') return;
            speakNL(text);
        }

        function showRoleplay() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('roleplay-view').classList.add('active');
            setActiveNav('nav-pratiquer');

            renderRpGeminiStatus();
            rpCheckDutchVoice();

            rpShowCategoryPicker();
        }

        function rpShowCategoryPicker() {
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            rpIvState = null;
            rpDayState = null;
            rpCaseState = null;
            rpHideInterviewer();
            rpJobHideDebrief();
            document.getElementById('rp-step-category').style.display = '';
            document.getElementById('rp-step-scenario').style.display = 'none';
            document.getElementById('rp-step-chat').style.display = 'none';
        }

        function rpShowCategory(catKey) {
            rpCurrentCategory = catKey;
            rpHideInterviewer();
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
            if (rpCurrentCategory === '__reel_candidat') {
                rpShowRealCandidateList();
            } else if (rpCurrentCategory === '__reel_intervieweur') {
                rpIvState = null;
                rpShowInterviewerList();
            } else if (rpCurrentCategory === '__job') {
                rpShowJobHome();
            } else if (rpCurrentCategory === '__case') {
                rpShowCaseHome();
            } else if (rpCurrentCategory) {
                rpShowCategory(rpCurrentCategory);
            } else {
                rpShowCategoryPicker();
            }
        }

        function rpStartScenario(catKey, itemId) {
            const scenario = rpFindScenario(catKey, itemId);
            if (!scenario) return;
            rpBeginScenario(scenario);
        }

        // Extrait du corps historique de rpStartScenario, pour pouvoir démarrer une conversation
        // à partir d'un scénario construit dynamiquement (Pratique ciblée) sans dupliquer la
        // logique de démarrage ni créer un second moteur de conversation.
        function rpBeginScenario(scenario) {
            rpCurrentScenario = scenario;
            rpConversationHistory = [{ role: "model", parts: [{ text: scenario.prompt }] }];

            // Réinitialise le mode script à chaque nouveau scénario (jamais hérité de la
            // conversation précédente) — bannière, choix et micro repartent de l'état par défaut.
            rpScriptedActive = false;
            rpScriptedStepIndex = 0;
            const micBtn = document.getElementById('rp-mic-btn');
            if (micBtn) micBtn.style.display = '';
            const textRow = document.getElementById('rp-text-row');
            if (textRow) textRow.style.display = 'flex';
            rpCoachClear();
            rpHideInterviewer();
            rpJobHideNav();
            rpJobHideDebrief();
            // La dictée suit la langue du scénario (anglais pour un scénario réel en anglais).
            if (rpRecognition) rpRecognition.lang = scenario.lang === 'en' ? 'en-US' : 'nl-NL';
            const choicesDiv = document.getElementById('rp-scripted-choices');
            if (choicesDiv) { choicesDiv.style.display = 'none'; choicesDiv.innerHTML = ''; }
            const banner = document.getElementById('rp-mode-banner');
            if (banner) { banner.style.display = 'none'; banner.innerHTML = ''; }

            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = 'none';
            document.getElementById('rp-step-chat').style.display = 'flex';

            document.getElementById('rp-chat-history').innerHTML = '';
            rpAppendMessage(scenario.welcome, 'assistant');
            rpSpeakText(scenario.welcome);
            document.getElementById('rp-status').innerText = "Prêt";

            // Gemini non configuré du tout : bascule directe en mode script si ce scénario en a un,
            // plutôt que de laisser l'apprenant taper/parler dans le vide sans réponse possible.
            if (!GeminiService.isAvailable() && RP_SCRIPTED_FALLBACK[scenario.id]) {
                rpEnterScriptedMode();
            }
        }

        // =====================================================================================
        // Extension du jeu de rôle : scénarios réels (tirés de vraies transcriptions d'entretien)
        // =====================================================================================
        // Trois usages de Gemini, avec trois prompts STRICTEMENT séparés — jamais mélangés dans un
        // même appel :
        //   1. le recruteur qui improvise (rpBuildRecruiterPrompt → conversation rpSendToGemini)
        //   2. le correcteur "prof de néerlandais" (rpCoachCorrect) — ne voit QUE la phrase de
        //      l'apprenant, jamais le contexte recruteur, pour rester fiable
        //   3. le juge de traduction du mode intervieweur (rpIvJudge) — ne voit QUE la phrase de
        //      référence et la tentative
        // Le contenu (questions, dialogues) vit dans data/roleplay/*.json et est fourni par Joas :
        // rien n'est inventé ici.

        // ----- Tour de l'utilisateur + bouton "Corrige-moi" -----
        // Remplace rpAppendMessage(text, 'user') pour les réponses libres (dictées ou tapées).
        // Les répliques pré-écrites du mode script n'y passent pas : rien à corriger.
        const rpCoachSettings = { auto: false }; // true = correction après chaque tour sans clic (option B, pas encore exposée dans l'interface)

        function rpAppendUserTurn(text) {
            rpAppendMessage(text, 'user');
            const historyDiv = document.getElementById('rp-chat-history');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rp-coach-btn';
            btn.innerText = '✍️ Corrige-moi';
            btn.onclick = () => rpCoachCorrect(text);
            historyDiv.appendChild(btn);
            historyDiv.scrollTop = historyDiv.scrollHeight;
            if (rpCoachSettings.auto) rpCoachCorrect(text);
        }

        function rpSendTypedMessage() {
            const input = document.getElementById('rp-text-input');
            const text = (input.value || '').trim();
            if (!text || rpScriptedActive) return;
            if (!GeminiService.getKey()) {
                alert("Renseigne d'abord ta clé API Gemini dans Profil → 🤖 Intelligence IA.");
                return;
            }
            input.value = '';
            rpAppendUserTurn(text);
            rpSendToGemini(text);
        }

        function rpCoachClear() {
            const panel = document.getElementById('rp-coach-panel');
            if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
        }

        // Correcteur : appel Gemini séparé, prompt minimal, aucune trace de la conversation.
        // Le résultat s'affiche dans un encart sous la conversation, pas dans le fil de dialogue,
        // pour ne pas casser l'immersion.
        async function rpCoachCorrect(userText) {
            const panel = document.getElementById('rp-coach-panel');
            if (!panel) return;
            panel.style.display = 'block';
            panel.innerHTML = '';
            const title = document.createElement('div');
            title.className = 'rp-coach-title';
            title.innerText = '✍️ Correction — prof de néerlandais';
            const quote = document.createElement('div');
            quote.className = 'rp-coach-quote';
            quote.innerText = '« ' + userText + ' »';
            const body = document.createElement('div');
            body.className = 'rp-coach-body';
            body.innerText = 'Correction en cours...';
            panel.append(title, quote, body);
            // Seule information tirée du scénario : la langue pratiquée (néerlandais, sauf scénario
            // réel mené en anglais). Rien du dialogue ni du rôle du recruteur n'est transmis.
            const langName = RP_LANG_NAMES[(rpCurrentScenario && rpCurrentScenario.lang) || 'nl'];
            try {
                body.innerText = await GeminiService.generate(
                    'Tu es un professeur de ' + langName + ' pour francophones. Corrige la grammaire, le vocabulaire et la formulation de ce texte produit par un apprenant (il peut avoir été dicté : ignore la ponctuation et les majuscules). ' +
                    'Réponds en français, de façon brève : 2 à 3 points maximum, puis une version corrigée en ' + langName + '. Si le texte est déjà correct, dis-le en une phrase.\n\n' +
                    'Texte de l\'apprenant : """' + userText + '"""'
                );
            } catch (e) {
                body.innerText = 'Correction impossible : ' + e.message;
            }
            panel.scrollIntoView({ block: 'nearest' });
        }

        // ----- Chargement des données -----
        let rpRealData = null; // { banks: [...], dialogues: [...] }

        async function rpLoadRealData() {
            if (rpRealData) return rpRealData;
            const load = url => fetch(url).then(r => r.ok ? r.json() : { scenarios: [] }).catch(() => ({ scenarios: [] }));
            const [banks, dialogues] = await Promise.all([
                load('data/roleplay/question_banks.json'),
                load('data/roleplay/scripted_dialogues.json')
            ]);
            rpRealData = { banks: banks.scenarios || [], dialogues: dialogues.scenarios || [] };
            return rpRealData;
        }

        function rpHideInterviewer() {
            const el = document.getElementById('rp-step-interviewer');
            if (el) el.style.display = 'none';
        }

        const rpEscapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const rpExampleTag = sc => sc.exemple ? ' <span class="wl-badge review">exemple à remplacer</span>' : '';

        // ----- Mode Candidat : recruteur piloté par une banque de questions réelles -----
        const RP_QUESTION_TYPES = [
            ['accroche', 'Accroche / entrée en matière'],
            ['verif_cv', 'Vérification du CV'],
            ['clarification_poste', 'Clarification du poste'],
            ['technique', 'Questions techniques'],
            ['motivation', 'Motivation'],
            ['vision_carriere', 'Vision de carrière'],
            ['objections', 'Objections'],
            ['perso', 'Questions personnelles'],
            ['dispo', 'Disponibilité / aspects pratiques'],
            ['cloture', 'Clôture']
        ];

        // Le prompt ne contient QUE des questions à poser — aucune réponse attendue. Le modèle
        // réagit librement à ce que l'apprenant répond réellement.
        function rpBuildRecruiterPrompt(bank) {
            const q = bank.questions || {};
            const known = RP_QUESTION_TYPES.map(t => t[0]);
            const sections = RP_QUESTION_TYPES
                .concat(Object.keys(q).filter(k => !known.includes(k)).map(k => [k, k]))
                .filter(([key]) => Array.isArray(q[key]) && q[key].length)
                .map(([key, label]) => label + ' :\n' + q[key].map(x => '- ' + x).join('\n'))
                .join('\n\n');
            const lang = rpBankLang(bank);
            const langName = RP_LANG_NAMES[lang];
            // "niveau" sert parfois à indiquer la langue de la transcription (NL / EN) plutôt
            // qu'un niveau CECR : dans ce cas on ne l'annonce pas comme un niveau.
            const niveau = /^(nl|en)$/i.test(bank.niveau || '') ? '' : (bank.niveau || '');
            return 'Tu es un recruteur ' + (lang === 'nl' ? 'belge néerlandophone' : 'anglophone') + ' qui mène un entretien d\'embauche' + (bank.poste ? ' pour le poste suivant : ' + bank.poste : '') + '. ' +
                (bank.contexte ? 'Contexte : ' + bank.contexte + ' ' : '') +
                'Parle exclusivement en ' + langName + (niveau ? ' (niveau ' + niveau + ')' : '') + ', comme à l\'oral : une ou deux phrases, UNE seule question à la fois.\n\n' +
                'Voici les questions réellement posées dans ce type d\'entretien, classées par moment de l\'entretien. Suis cet ordre approximativement, sans le réciter : reformule librement, saute ce qui a déjà été abordé, et rebondis sur ce que le candidat vient de dire avec des relances improvisées avant de passer à la question suivante. ' +
                'Ces questions viennent d\'une transcription orale : certaines sont coupées en fin de phrase (complète-les naturellement) et les passages entre crochets comme [plaats] sont des blancs à remplacer par un détail plausible.\n\n' +
                sections + '\n\n' +
                'Tu ne connais pas les réponses du candidat à l\'avance : réagis à ce qu\'il dit réellement, comme un vrai recruteur. Ne corrige jamais sa langue et ne sors jamais de ton rôle. Quand les thèmes principaux ont été couverts, conclus l\'entretien naturellement.';
        }

        // Langue d'un scénario réel : champ "langue" s'il existe, sinon "niveau" quand il vaut
        // NL / EN (c'est ainsi que les premières banques l'indiquent), sinon néerlandais.
        const RP_LANG_NAMES = { nl: 'néerlandais', en: 'anglais' };
        function rpBankLang(bank) {
            const raw = String(bank.langue || (/^(nl|en)$/i.test(bank.niveau || '') ? bank.niveau : 'nl')).toLowerCase();
            return RP_LANG_NAMES[raw] ? raw : 'nl';
        }

        async function rpShowRealCandidateList() {
            rpCurrentCategory = '__reel_candidat';
            rpHideInterviewer();
            const listDiv = document.getElementById('rp-scenario-list');
            listDiv.innerHTML = '<p style="color:#888;">Chargement...</p>';
            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = '';
            document.getElementById('rp-step-chat').style.display = 'none';
            const { banks } = await rpLoadRealData();
            listDiv.innerHTML = '<div class="rp-group-title">🎯 Je suis candidat — entretiens réels</div>' +
                '<p class="rp-real-hint">Le recruteur pose les questions de vrais entretiens et improvise ses relances selon tes réponses.</p>' +
                (banks.length
                    ? banks.map((b, i) => `<button class="rp-scenario-btn" onclick="rpStartRealCandidate(${i})">${rpEscapeHtml(b.label)}${rpBankLang(b) === 'en' ? ' <span class="wl-badge unseen">🇬🇧 en anglais</span>' : ''}${rpExampleTag(b)}</button>`).join('')
                    : '<p style="color:#888;">Aucun scénario réel pour l\'instant.</p>');
        }

        function rpStartRealCandidate(index) {
            const bank = rpRealData && rpRealData.banks[index];
            if (!bank) return;
            const firstQuestion = ((bank.questions || {}).accroche || [])[0];
            const welcome = bank.welcome || firstQuestion || 'Goedendag, fijn dat u er bent. Kunt u zich eerst even kort voorstellen?';
            rpDayState = null;
            rpBeginScenario({
                id: 'reel_' + bank.id,
                lang: rpBankLang(bank),
                label: bank.label,
                welcome,
                // La phrase d'accueil est affichée par l'app, pas générée : on la signale au
                // recruteur pour qu'il enchaîne au lieu de se présenter une deuxième fois.
                prompt: rpBuildRecruiterPrompt(bank) + '\n\nTu as déjà ouvert l\'entretien en disant : """' + welcome + '""" — enchaîne à partir de la réponse du candidat, sans te présenter à nouveau.'
            });
        }

        // ----- Mode Intervieweur : exercice de traduction guidé sur un dialogue scripté -----
        // Joas joue le recruteur. Chaque tour : consigne en français (fr_cue) → sa tentative en
        // néerlandais → jugement SÉMANTIQUE par Gemini contre la phrase réellement dite
        // (nl_original), jamais une comparaison de texte → réplique du candidat pour le contexte.
        let rpIvState = null; // { scenario, index, counts: {correct, proche, a_revoir} }
        const RP_IV_VERDICTS = {
            correct: { label: '✅ Correct', cls: 'true-mastered' },
            proche: { label: '🟡 Proche', cls: 'review' },
            a_revoir: { label: '❌ À revoir', cls: 'iv-wrong' }
        };

        async function rpShowInterviewerList() {
            rpCurrentCategory = '__reel_intervieweur';
            rpHideInterviewer();
            const listDiv = document.getElementById('rp-scenario-list');
            listDiv.innerHTML = '<p style="color:#888;">Chargement...</p>';
            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = '';
            document.getElementById('rp-step-chat').style.display = 'none';
            const { dialogues } = await rpLoadRealData();
            listDiv.innerHTML = '<div class="rp-group-title">🎙️ Je suis recruteur — traduction guidée</div>' +
                '<p class="rp-real-hint">Tu joues le recruteur d\'un vrai entretien : on te donne la phrase en français, tu la dis en néerlandais.</p>' +
                (dialogues.length
                    ? dialogues.map((d, i) => `<button class="rp-scenario-btn" onclick="rpIvStart(${i})">${rpEscapeHtml(d.label)} <span style="color:var(--text-secondary); font-weight:normal;">· ${(d.turns || []).length} tours</span>${rpExampleTag(d)}</button>`).join('')
                    : '<p style="color:#888;">Aucun dialogue pour l\'instant.</p>');
        }

        function rpIvStart(index) {
            const scenario = rpRealData && rpRealData.dialogues[index];
            if (!scenario || !(scenario.turns || []).length) return;
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            rpIvState = { scenario, scenarioIndex: index, index: 0, counts: { correct: 0, proche: 0, a_revoir: 0 } };
            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = 'none';
            document.getElementById('rp-step-chat').style.display = 'none';
            document.getElementById('rp-step-interviewer').style.display = 'flex';
            rpIvRenderTurn();
        }

        function rpIvRenderTurn() {
            const st = rpIvState;
            const box = document.getElementById('rp-iv-content');
            if (!st || !box) return;
            const turns = st.scenario.turns;
            if (st.index >= turns.length) { rpIvRenderSummary(); return; }
            const turn = turns[st.index];
            const prev = st.index > 0 ? turns[st.index - 1] : null;
            box.innerHTML = `
                <div class="conj-card">
                    <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:6px;">${rpEscapeHtml(st.scenario.label)} · Tour ${st.index + 1}/${turns.length}</div>
                    ${st.index === 0 && st.scenario.contexte ? `<div class="rp-real-hint" style="margin-bottom:10px;">${rpEscapeHtml(st.scenario.contexte)}</div>` : ''}
                    ${prev && prev.candidate_reply ? `<div class="rp-iv-candidate"><div class="rp-iv-label">Le candidat vient de répondre</div>${rpEscapeHtml(prev.candidate_reply)} ${speakBtnHtml(prev.candidate_reply)}</div>` : ''}
                    <div class="rp-iv-label">Dis en néerlandais</div>
                    <div class="rp-iv-cue">${rpEscapeHtml(turn.fr_cue)}</div>
                    <textarea id="rp-iv-input" rows="3" placeholder="Ta phrase en néerlandais..." autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
                    <button class="btn btn-gray" id="rp-iv-mic-btn" style="margin-top:8px;" onclick="rpIvToggleMic()">🎤 Cliquer pour parler</button>
                    <div id="rp-iv-status" style="font-size:0.8rem; color:var(--text-secondary); min-height:1.2em; margin:6px 0;"></div>
                    <button class="btn btn-green" id="rp-iv-check-btn" onclick="rpIvCheck()">Vérifier</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="rpIvReveal()">Voir la phrase de référence</button>
                    <div id="rp-iv-feedback"></div>
                </div>`;
            const input = document.getElementById('rp-iv-input');
            if (input) input.focus();
        }

        function rpIvToggleMic() {
            productionToggleVoiceCapture('rp-iv-mic-btn', 'rp-iv-status', (text) => {
                const input = document.getElementById('rp-iv-input');
                if (input) input.value = (input.value ? input.value + ' ' : '') + text;
            });
        }

        // Juge de traduction : appel séparé, ne reçoit que la référence et la tentative.
        async function rpIvJudge(nlOriginal, attempt) {
            const raw = await GeminiService.generate(
                'Tu évalues une phrase en néerlandais dite par un apprenant francophone qui joue le rôle d\'un recruteur dans un entretien d\'embauche professionnel.\n\n' +
                'Phrase de référence (réellement dite par un recruteur néerlandophone) : """' + nlOriginal + '"""\n' +
                'Tentative de l\'apprenant : """' + attempt + '"""\n\n' +
                'Ne compare PAS mot à mot : plusieurs formulations néerlandaises sont valides pour une même idée. Ignore la ponctuation et les majuscules (la phrase peut avoir été dictée). ' +
                'Juge si la tentative transmet la même idée que la référence, avec un niveau correct de néerlandais professionnel.\n' +
                '- "correct" : même idée, néerlandais correct (même formulé autrement).\n' +
                '- "proche" : idée transmise mais avec une ou des erreurs, ou un détail important manquant.\n' +
                '- "a_revoir" : idée différente, incompréhensible, ou trop d\'erreurs.\n\n' +
                'Réponds UNIQUEMENT avec un objet JSON, sans texte autour : {"verdict": "correct" | "proche" | "a_revoir", "commentaire": "en français, 1 à 3 phrases ; si ce n\'est pas parfait, signale précisément ce qui cloche (mot, ordre des mots, grammaire, registre) et comment le corriger"}'
            );
            // Réponse attendue en JSON, mais le modèle l'entoure parfois de texte ou de ```json.
            try {
                const match = raw.match(/\{[\s\S]*\}/);
                const parsed = JSON.parse(match ? match[0] : raw);
                if (RP_IV_VERDICTS[parsed.verdict]) return { verdict: parsed.verdict, commentaire: String(parsed.commentaire || '') };
            } catch (e) { /* on retombe sur l'affichage brut ci-dessous */ }
            return { verdict: null, commentaire: raw };
        }

        function rpIvFeedbackHtml(turn, attempt, verdictHtml, commentaire) {
            return `
                <div class="rp-iv-feedback-box">
                    ${verdictHtml}
                    ${attempt ? `<div class="rp-iv-label">Ta phrase</div><div>${rpEscapeHtml(attempt)}</div>` : ''}
                    <div class="rp-iv-label">Phrase de référence (dite par le vrai recruteur)</div>
                    <div class="rp-iv-reference">${rpEscapeHtml(turn.nl_original)} ${speakBtnHtml(turn.nl_original)}</div>
                    ${commentaire ? `<div class="rp-iv-label">Commentaire</div><div class="rp-iv-comment">${rpEscapeHtml(commentaire)}</div>` : ''}
                    ${turn.candidate_reply ? `<div class="rp-iv-candidate" style="margin-top:12px;"><div class="rp-iv-label">Le candidat répond</div>${rpEscapeHtml(turn.candidate_reply)} ${speakBtnHtml(turn.candidate_reply)}</div>` : ''}
                    <button class="btn btn-green" style="margin-top:12px;" onclick="rpIvNext()">${rpIvState.index + 1 >= rpIvState.scenario.turns.length ? 'Voir le bilan' : 'Tour suivant →'}</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="rpIvRenderTurn()">🔁 Réessayer ce tour</button>
                </div>`;
        }

        async function rpIvCheck() {
            const st = rpIvState;
            if (!st || st.checking) return;
            const attempt = (document.getElementById('rp-iv-input').value || '').trim();
            const fb = document.getElementById('rp-iv-feedback');
            if (!attempt) { fb.innerHTML = '<p style="color:var(--wrong); font-size:0.85rem;">Écris ou dis d\'abord ta phrase.</p>'; return; }
            if (!GeminiService.isAvailable()) {
                fb.innerHTML = '<p style="color:var(--wrong); font-size:0.85rem;">La vérification a besoin de Gemini (Profil → 🤖 Intelligence IA). Sans clé, utilise « Voir la phrase de référence » pour te comparer toi-même.</p>';
                return;
            }
            const turn = st.scenario.turns[st.index];
            st.checking = true;
            fb.innerHTML = '<p style="font-size:0.85rem; color:var(--text-secondary);">Vérification en cours...</p>';
            try {
                const res = await rpIvJudge(turn.nl_original, attempt);
                if (rpIvState !== st) return; // l'utilisateur a quitté l'exercice entre-temps
                const v = RP_IV_VERDICTS[res.verdict];
                if (v) st.counts[res.verdict]++;
                const verdictHtml = v
                    ? `<span class="wl-badge ${v.cls}" style="font-size:0.9rem; padding:5px 12px;">${v.label}</span>`
                    : '<span class="wl-badge unseen">Verdict non lisible</span>';
                document.getElementById('rp-iv-check-btn').style.display = 'none';
                fb.innerHTML = rpIvFeedbackHtml(turn, attempt, verdictHtml, res.commentaire);
            } catch (e) {
                fb.innerHTML = `<p style="color:var(--wrong); font-size:0.85rem;">Vérification impossible : ${rpEscapeHtml(e.message)}</p>`;
            } finally {
                st.checking = false;
            }
        }

        // Sans jugement (pas de clé Gemini, ou simple envie de voir la réponse) : auto-comparaison.
        function rpIvReveal() {
            const st = rpIvState;
            if (!st) return;
            const turn = st.scenario.turns[st.index];
            const attempt = (document.getElementById('rp-iv-input').value || '').trim();
            document.getElementById('rp-iv-feedback').innerHTML =
                rpIvFeedbackHtml(turn, attempt, '<span class="wl-badge unseen">Non évalué</span>', '');
        }

        function rpIvNext() {
            if (!rpIvState) return;
            rpIvState.index++;
            rpIvRenderTurn();
        }

        function rpIvRenderSummary() {
            const st = rpIvState;
            const c = st.counts;
            const evaluated = c.correct + c.proche + c.a_revoir;
            document.getElementById('rp-iv-content').innerHTML = `
                <div class="conj-card">
                    <div class="conj-verb-title">Entretien terminé 🎉</div>
                    <p style="font-size:0.9rem;">${st.scenario.turns.length} tours · ${evaluated} évalué(s) : ✅ ${c.correct} correct(s) · 🟡 ${c.proche} proche(s) · ❌ ${c.a_revoir} à revoir</p>
                    <button class="btn btn-green" onclick="rpIvStart(${st.scenarioIndex})">🔁 Recommencer ce dialogue</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="rpShowInterviewerList()">Choisir un autre dialogue</button>
                </div>`;
        }

        // =====================================================================================
        // Mises en situation métier (data/roleplay/job_simulations.json)
        // =====================================================================================
        // Distinct des modes Candidat et Intervieweur : ici l'apprenant est EN POSTE et fait face
        // à des situations de travail (chauffeur au guichet, client au téléphone, collègue...).
        // Générique tous métiers via le champ `metier` — seul "logistique" a du contenu pour
        // l'instant. Deux prompts Gemini, séparés entre eux et de tous les autres :
        //   - rpBuildSituationPrompt : le personnage d'UNE situation (improvise à partir de
        //     l'amorce, jamais de réponse attendue)
        //   - rpDayDebrief : bilan de fin de journée, appel séparé qui reçoit l'historique de la
        //     session — les corrections sont données APRÈS, jamais pendant
        const RP_JOB_METIERS = { logistique: '🚚 Logistique' }; // libellés ; un métier absent d'ici s'affiche avec son nom brut
        const RP_JOB_CANAUX = {
            guichet_chauffeur: { label: '🚛 Guichet chauffeurs', prompt: 'face à face, au guichet ou sur le quai' },
            telephone_client: { label: '📞 Téléphone', prompt: 'au téléphone' },
            collegue_interne: { label: '🧑‍🤝‍🧑 Collègues', prompt: 'entre collègues, sur le lieu de travail' },
            email: { label: '✉️ E-mail', prompt: 'par e-mail : tes messages sont des e-mails courts, et l\'apprenant répond par écrit' }
        };
        // Intensité par type de situation, pour ordonner une journée tirée au sort (calme → pic → calme).
        const RP_JOB_INTENSITY = { administratif: 1, probleme_document: 2, proposition_solution: 2, negociation: 3, urgence: 3, reclamation: 3 };
        const RP_JOB_DURATIONS = { courte: 6, longue: 10 };
        // Blancs entre crochets dans les amorces ([klant]...) : l'amorce est affichée et lue telle
        // quelle, on les remplace donc par une valeur neutre.
        const RP_JOB_BLANKS = { klant: 'bedrijf X', bedrijf: 'bedrijf X', plaats: 'Mechelen' };

        let rpJobData = null;      // { situations: [...], journees: [...] }
        let rpJobMetier = null;
        let rpJobDuration = 'courte';
        let rpDayState = null;     // { label, situations, index, log: [{ situation, turns }] } — null hors journée
        const rpJobSeen = new Set(); // situations déjà jouées depuis l'ouverture de la page (pour varier les tirages)

        async function rpLoadJobData() {
            if (rpJobData) return rpJobData;
            const data = await fetch('data/roleplay/job_simulations.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
            rpJobData = { situations: data.situations || [], journees: data.journees || [] };
            return rpJobData;
        }

        const rpSitLang = s => /^en$/i.test(s.niveau || '') ? 'en' : 'nl';
        const rpSitAmorce = s => String(s.amorce || '').replace(/\[([^\]]+)\]/g, (m, k) => RP_JOB_BLANKS[k.toLowerCase()] || k);
        const rpSitCanal = s => RP_JOB_CANAUX[s.canal] || { label: s.canal || 'Situation', prompt: '' };
        const rpSitTitle = s => { const c = String(s.contexte || s.id); return (c.match(/^.*?[.!?](?=\s|$)/) || [c])[0]; };

        // Prompt du personnage pour UNE situation. Ne contient que le cadre et la première
        // réplique : la suite est improvisée selon ce que l'apprenant répond réellement.
        function rpBuildSituationPrompt(s) {
            const langName = RP_LANG_NAMES[rpSitLang(s)];
            const canal = rpSitCanal(s);
            return 'Tu joues un personnage dans une mise en situation professionnelle (métier : ' + (s.metier || 'non précisé') + '). ' +
                'L\'apprenant occupe le poste de ' + (s.poste || 'employé') + ' ; toi, tu es son interlocuteur dans cette situation (chauffeur, client, collègue ou responsable selon le contexte) — jamais l\'apprenant lui-même.\n\n' +
                'Situation : ' + s.contexte + '\n' +
                (canal.prompt ? 'L\'échange a lieu ' + canal.prompt + '.\n' : '') +
                'Tu as ouvert l\'échange en disant : """' + rpSitAmorce(s) + '"""\n\n' +
                'Continue à partir de là, exclusivement en ' + langName + ', avec des répliques courtes (une ou deux phrases) et naturelles. ' +
                'Réagis à ce que l\'apprenant dit réellement et invente les détails plausibles dont tu as besoin (numéro de quai, heure, référence, nom de client générique). ' +
                'Reste dans l\'état d\'esprit de ton personnage (pressé, mécontent, détendu... selon la situation) et ne facilite pas artificiellement la tâche de l\'apprenant. ' +
                'Ne corrige jamais sa langue et ne sors jamais de ton rôle. Quand le problème est réglé, conclus brièvement et n\'ouvre pas de nouveau sujet.';
        }

        // Compose une journée : soit la séquence figée d'une `journee` (par ids, sans dupliquer le
        // contenu), soit un tirage dans la banque du métier — pondéré pour favoriser les
        // situations pas encore jouées, puis ordonné calme → pic → calme.
        function rpComposeDay(metier, journee, size) {
            const bank = rpJobData.situations.filter(s => s.metier === metier);
            if (journee && Array.isArray(journee.sequence)) {
                return journee.sequence.map(id => bank.find(s => s.id === id)).filter(Boolean);
            }
            const keyed = bank.map(s => ({ s, key: Math.pow(Math.random(), 1 / (rpJobSeen.has(s.id) ? 1 : 3)) }));
            keyed.sort((a, b) => b.key - a.key);
            const picked = keyed.slice(0, size).map(k => k.s);
            picked.sort((a, b) => (RP_JOB_INTENSITY[a.type] || 2) - (RP_JOB_INTENSITY[b.type] || 2));
            // Du plus calme au plus intense, en alternant début / fin : les plus intenses finissent au milieu.
            const head = [], tail = [];
            picked.forEach((s, i) => (i % 2 === 0 ? head.push(s) : tail.unshift(s)));
            return head.concat(tail);
        }

        // ----- Écran d'accueil du mode : métier, journée complète, situation isolée -----
        async function rpShowJobHome() {
            rpCurrentCategory = '__job';
            rpDayState = null;
            rpHideInterviewer();
            rpJobHideDebrief();
            const listDiv = document.getElementById('rp-scenario-list');
            listDiv.innerHTML = '<p style="color:#888;">Chargement...</p>';
            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = '';
            document.getElementById('rp-step-chat').style.display = 'none';
            const data = await rpLoadJobData();
            const metiers = [...new Set(data.situations.map(s => s.metier).filter(Boolean))];
            if (!metiers.length) { listDiv.innerHTML = '<p style="color:#888;">Aucune situation pour l\'instant.</p>'; return; }
            if (!metiers.includes(rpJobMetier)) rpJobMetier = metiers[0];
            const bank = data.situations.filter(s => s.metier === rpJobMetier);
            const size = RP_JOB_DURATIONS[rpJobDuration];
            const isShort = j => (j.duree_situations || (j.sequence || []).length) <= 7;
            const journees = data.journees
                .map((j, i) => ({ j, i }))
                .filter(x => x.j.metier === rpJobMetier && isShort(x.j) === (rpJobDuration === 'courte'));
            const chip = (active, onclick, label, disabled) =>
                `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" ${disabled ? 'disabled style="opacity:0.45; cursor:default;"' : `onclick="${onclick}"`}>${label}</button>`;

            const canaux = [...new Set(bank.map(s => s.canal))];
            const isolated = canaux.map(c =>
                `<div class="rp-job-canal">${rpEscapeHtml((RP_JOB_CANAUX[c] || { label: c }).label)}</div>` +
                bank.filter(s => s.canal === c).map(s =>
                    `<button class="rp-scenario-btn" onclick="rpStartSituation('${s.id}')">${rpEscapeHtml(rpSitTitle(s))}${rpSitLang(s) === 'en' ? ' <span class="wl-badge unseen">🇬🇧 en anglais</span>' : ''}</button>`
                ).join('')
            ).join('');

            listDiv.innerHTML = `
                <div class="rp-group-title">🏭 Mise en situation métier</div>
                <p class="rp-real-hint">Tu es en poste : chauffeurs, clients et collègues viennent vers toi, à toi de gérer.</p>
                <div class="conj-filter-chips-row" style="width:100%; max-width:520px;">
                    ${metiers.map(m => chip(m === rpJobMetier, `rpJobSetMetier('${m}')`, RP_JOB_METIERS[m] || rpEscapeHtml(m))).join('')}
                    ${chip(false, '', 'Autres métiers : bientôt', true)}
                </div>
                <div class="rp-group-title">📅 Journée complète</div>
                <p class="rp-real-hint">Plusieurs situations à la suite, puis un bilan : vocabulaire à retenir et formulations corrigées.</p>
                <div class="conj-filter-chips-row" style="width:100%; max-width:520px;">
                    ${chip(rpJobDuration === 'courte', "rpJobSetDuration('courte')", `Courte · ${RP_JOB_DURATIONS.courte} situations`)}
                    ${chip(rpJobDuration === 'longue', "rpJobSetDuration('longue')", `Longue · ${RP_JOB_DURATIONS.longue} situations`)}
                </div>
                ${journees.map(x => `<button class="rp-scenario-btn" onclick="rpStartDay(${x.i})">${rpEscapeHtml(x.j.label)}</button>`).join('')}
                <button class="rp-scenario-btn" onclick="rpStartDay(-1)">🎲 Journée tirée au sort · ${Math.min(size, bank.length)} situations</button>
                <div class="rp-group-title">🎯 Situation isolée</div>
                ${isolated}`;
        }

        function rpJobSetMetier(m) { rpJobMetier = m; rpShowJobHome(); }
        function rpJobSetDuration(d) { rpJobDuration = d; rpShowJobHome(); }

        function rpJobRequireGemini() {
            if (GeminiService.isAvailable()) return true;
            alert("Les mises en situation ont besoin de Gemini : renseigne ta clé API dans Profil → 🤖 Intelligence IA.");
            return false;
        }

        // Démarre la conversation d'une situation dans l'écran de dialogue existant.
        function rpJobBeginSituation(s) {
            rpJobSeen.add(s.id);
            rpBeginScenario({
                id: 'job_' + s.id,
                lang: rpSitLang(s),
                label: rpSitTitle(s),
                welcome: rpSitAmorce(s),
                prompt: rpBuildSituationPrompt(s)
            });
            const banner = document.getElementById('rp-mode-banner');
            const day = rpDayState;
            banner.style.display = '';
            banner.innerHTML = `
                <div class="rp-job-banner">
                    <div class="rp-iv-label" style="margin-top:0;">${day ? `${rpEscapeHtml(day.label)} · Situation ${day.index + 1}/${day.situations.length} · ` : ''}${rpEscapeHtml(rpSitCanal(s).label)}</div>
                    <div>${rpEscapeHtml(s.contexte)}</div>
                    ${(s.vocabulaire_cible || []).length ? `<details><summary>Vocabulaire utile</summary>${s.vocabulaire_cible.map(rpEscapeHtml).join(' · ')}</details>` : ''}
                </div>`;
            const nav = document.getElementById('rp-day-nav');
            if (day) {
                const last = day.index + 1 >= day.situations.length;
                nav.style.display = 'block';
                nav.innerHTML = `<button class="btn btn-gray" style="margin:0;" onclick="rpDayNext()">${last ? '🏁 Terminer la journée et voir le bilan' : 'Situation suivante →'}</button>`;
            }
        }

        function rpJobHideNav() {
            const nav = document.getElementById('rp-day-nav');
            if (nav) { nav.style.display = 'none'; nav.innerHTML = ''; }
        }

        function rpStartSituation(id) {
            const s = rpJobData && rpJobData.situations.find(x => x.id === id);
            if (!s || !rpJobRequireGemini()) return;
            rpDayState = null;
            rpJobBeginSituation(s);
        }

        function rpStartDay(journeeIndex) {
            if (!rpJobData || !rpJobRequireGemini()) return;
            const journee = journeeIndex >= 0 ? rpJobData.journees[journeeIndex] : null;
            const situations = rpComposeDay(rpJobMetier, journee, RP_JOB_DURATIONS[rpJobDuration]);
            if (!situations.length) return;
            rpDayState = { label: journee ? journee.label : 'Journée tirée au sort', situations, index: 0, log: [] };
            rpJobBeginSituation(situations[0]);
        }

        // Archive la conversation de la situation en cours (amorce + échanges) dans le journal de
        // la journée. rpConversationHistory[0] est le prompt du personnage : il n'est pas archivé.
        function rpDayArchiveCurrent() {
            const day = rpDayState;
            if (!day) return;
            const s = day.situations[day.index];
            const turns = [{ qui: 'interlocuteur', texte: rpSitAmorce(s) }].concat(
                rpConversationHistory.slice(1).map(m => ({ qui: m.role === 'user' ? 'apprenant' : 'interlocuteur', texte: m.parts[0].text }))
            );
            day.log.push({ situation: s, turns });
        }

        function rpDayNext() {
            const day = rpDayState;
            if (!day) return;
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            rpDayArchiveCurrent();
            day.index++;
            if (day.index < day.situations.length) rpJobBeginSituation(day.situations[day.index]);
            else rpDayDebrief();
        }

        function rpJobHideDebrief() {
            const el = document.getElementById('rp-step-debrief');
            if (el) el.style.display = 'none';
        }

        // Bilan de fin de journée : appel Gemini séparé (aucun lien avec les prompts des
        // personnages) qui reçoit tout l'historique de la session et renvoie une restitution
        // structurée. Affiché sur un écran distinct de la conversation.
        async function rpDayDebrief() {
            const day = rpDayState;
            if (!day) return;
            rpJobHideNav();
            document.getElementById('rp-step-chat').style.display = 'none';
            document.getElementById('rp-step-debrief').style.display = 'flex';
            const box = document.getElementById('rp-debrief-content');
            const header = `<div class="conj-verb-title">🏁 Bilan — ${rpEscapeHtml(day.label)}</div>`;
            const footer = `
                <button class="btn btn-green" style="margin-top:14px;" onclick="rpShowJobHome()">Nouvelle journée</button>
                <button class="btn btn-gray" style="margin-top:8px;" onclick="rpShowCategoryPicker()">Retour au jeu de rôle</button>`;
            const spoken = day.log.reduce((n, e) => n + e.turns.filter(t => t.qui === 'apprenant').length, 0);
            if (!spoken) {
                box.innerHTML = `<div class="conj-card">${header}<p>Tu n'as répondu à aucune situation : rien à analyser.</p>${footer}</div>`;
                return;
            }
            box.innerHTML = `<div class="conj-card">${header}<p style="color:var(--text-secondary);">Analyse de ta journée en cours...</p></div>`;
            const transcript = day.log.map((e, i) =>
                `### Situation ${i + 1} — ${e.situation.contexte}\n` +
                e.turns.map(t => `${t.qui === 'apprenant' ? 'APPRENANT' : 'INTERLOCUTEUR'} : ${t.texte}`).join('\n')
            ).join('\n\n');
            let raw;
            try {
                raw = await GeminiService.generate(
                    'Tu es un professeur de néerlandais professionnel pour francophones. Voici la transcription d\'une journée de mises en situation au travail : un apprenant (APPRENANT) a répondu à plusieurs interlocuteurs. ' +
                    'Analyse UNIQUEMENT les répliques de l\'APPRENANT (elles peuvent avoir été dictées : ignore ponctuation et majuscules).\n\n' +
                    transcript + '\n\n' +
                    'Réponds UNIQUEMENT avec un objet JSON, sans texte autour, de cette forme :\n' +
                    '{"situations": [{"numero": 1, "resume": "en français, une phrase : ce qui s\'est passé et si l\'apprenant a géré la situation"}],\n' +
                    ' "vocabulaire": [{"nl": "mot ou expression utile qui revient dans cette journée", "fr": "traduction"}],\n' +
                    ' "blocages": [{"numero": 1, "phrase_apprenant": "ce qu\'il a dit", "probleme": "en français, ce qui cloche ou bloque", "formulation_correcte": "la bonne formulation dans la langue de la situation"}],\n' +
                    ' "conseil": "en français, un conseil prioritaire pour la prochaine fois"}\n' +
                    '8 mots de vocabulaire maximum, 6 blocages maximum (les plus importants). Si une situation est restée sans réponse de l\'apprenant, dis-le dans son résumé.'
                );
            } catch (e) {
                box.innerHTML = `<div class="conj-card">${header}<p style="color:var(--wrong);">Bilan impossible : ${rpEscapeHtml(e.message)}</p>
                    <button class="btn btn-gray" onclick="rpDayDebrief()">Réessayer</button>${footer}</div>`;
                return;
            }
            if (rpDayState !== day) return; // l'utilisateur a quitté entre-temps
            let d = null;
            try { const m = raw.match(/\{[\s\S]*\}/); d = JSON.parse(m ? m[0] : raw); } catch (e) { d = null; }
            if (!d || typeof d !== 'object') {
                // Réponse non structurée : on l'affiche telle quelle plutôt que de la perdre.
                box.innerHTML = `<div class="conj-card">${header}<div class="rp-iv-comment">${rpEscapeHtml(raw)}</div>${footer}</div>`;
                return;
            }
            const arr = x => Array.isArray(x) ? x : [];
            const sitTitle = n => { const e = day.log[(n | 0) - 1]; return e ? rpSitTitle(e.situation) : ''; };
            box.innerHTML = `
                <div class="conj-card">
                    ${header}
                    <div class="rp-iv-label">Situations traversées</div>
                    ${day.log.map((e, i) => {
                        const r = arr(d.situations).find(x => (x.numero | 0) === i + 1);
                        return `<div class="rp-debrief-item"><b>${i + 1}. ${rpEscapeHtml(rpSitCanal(e.situation).label)}</b> — ${rpEscapeHtml(rpSitTitle(e.situation))}${r && r.resume ? `<div class="rp-debrief-sub">${rpEscapeHtml(r.resume)}</div>` : ''}</div>`;
                    }).join('')}
                    <div class="rp-iv-label">Vocabulaire à retenir</div>
                    ${arr(d.vocabulaire).length ? arr(d.vocabulaire).map(v => `<div class="conj-tense-row"><span class="conj-form">${rpEscapeHtml(v.nl || '')}</span> ${speakBtnHtml(v.nl || '')}<span class="rp-debrief-sub" style="flex:1;">${rpEscapeHtml(v.fr || '')}</span></div>`).join('') : '<div class="rp-debrief-sub">Rien de particulier.</div>'}
                    <div class="rp-iv-label">Moments de blocage — la bonne formulation</div>
                    ${arr(d.blocages).length ? arr(d.blocages).map(b => `
                        <div class="rp-debrief-item">
                            <div class="rp-debrief-sub">${rpEscapeHtml(sitTitle(b.numero))}</div>
                            <div>« ${rpEscapeHtml(b.phrase_apprenant || '')} »</div>
                            <div class="rp-debrief-sub">${rpEscapeHtml(b.probleme || '')}</div>
                            <div class="rp-iv-reference">→ ${rpEscapeHtml(b.formulation_correcte || '')} ${speakBtnHtml(b.formulation_correcte || '')}</div>
                        </div>`).join('') : '<div class="rp-debrief-sub">Aucun blocage relevé, bravo.</div>'}
                    ${d.conseil ? `<div class="rp-iv-label">Conseil pour la prochaine fois</div><div>${rpEscapeHtml(d.conseil)}</div>` : ''}
                    ${footer}
                </div>`;
        }

        // =====================================================================================
        // Étude de cas (business case court) — version simple
        // =====================================================================================
        // Aucun fichier de contenu : le cas est inventé par Gemini au lancement, à partir d'un
        // thème et d'une difficulté, et n'est pas stocké. Trois prompts séparés, jamais mélangés :
        //   - rpCaseGenerate : invente le cas (énoncé, chiffres, question, infos à donner sur demande)
        //   - rpBuildCasePrompt : le recruteur qui fait passer le cas et challenge la réponse
        //   - rpCaseDebrief : bilan après coup (clarté, justification, formulations corrigées)
        const RP_CASE_THEMES = [
            { key: 'transporteur', label: '🚚 Choisir un transporteur', sujet: 'choisir entre deux transporteurs (prix, délai, fiabilité)' },
            { key: 'retard', label: '⏰ Retards de livraison', sujet: 'des livraisons en retard chez un client important : que proposer ?' },
            { key: 'stock', label: '📦 Niveau de stock', sujet: 'un stock trop élevé ou des ruptures fréquentes : comment ajuster ?' },
            { key: 'tournee', label: '🗺️ Organiser une tournée', sujet: 'organiser ou réorganiser une tournée de livraison avec des contraintes' },
            { key: 'entrepot', label: '🏭 Coût d\'entrepôt', sujet: 'réduire le coût ou améliorer l\'organisation d\'un entrepôt' },
            { key: 'fournisseur', label: '🤝 Problème fournisseur', sujet: 'un fournisseur qui livre mal ou en retard : garder, renégocier ou changer ?' }
        ];
        const RP_CASE_LEVELS = {
            simple: { label: 'Simple', consigne: 'Niveau SIMPLE : énoncé de 3 à 4 phrases courtes en néerlandais B1, 2 ou 3 chiffres seulement, une décision à prendre entre deux options claires, aucun calcul compliqué.' },
            avance: { label: 'Avancé', consigne: 'Niveau AVANCÉ : énoncé de 5 à 6 phrases en néerlandais B2, 4 ou 5 chiffres, un calcul simple nécessaire pour comparer les options, et un compromis à arbitrer (coût contre délai ou qualité).' }
        };
        let rpCaseTheme = 'hasard';
        let rpCaseLevel = 'simple';
        let rpCaseState = null; // { cas, welcome } pendant une étude de cas, null sinon

        function rpShowCaseHome() {
            rpCurrentCategory = '__case';
            rpCaseState = null;
            rpHideInterviewer();
            rpJobHideDebrief();
            const chip = (active, onclick, label) =>
                `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
            document.getElementById('rp-scenario-list').innerHTML = `
                <div class="rp-group-title">💼 Étude de cas</div>
                <p class="rp-real-hint">Un recruteur te présente un petit problème d'entreprise. Pose-lui des questions, puis explique ce que tu ferais et pourquoi. Un cas différent à chaque fois.</p>
                <div class="rp-job-canal">Thème</div>
                <div class="conj-filter-chips-row" style="width:100%; max-width:520px;">
                    ${chip(rpCaseTheme === 'hasard', "rpCaseSet('theme','hasard')", '🎲 Au hasard')}
                    ${RP_CASE_THEMES.map(t => chip(rpCaseTheme === t.key, `rpCaseSet('theme','${t.key}')`, t.label)).join('')}
                </div>
                <div class="rp-job-canal">Difficulté</div>
                <div class="conj-filter-chips-row" style="width:100%; max-width:520px;">
                    ${Object.keys(RP_CASE_LEVELS).map(k => chip(rpCaseLevel === k, `rpCaseSet('level','${k}')`, RP_CASE_LEVELS[k].label)).join('')}
                </div>
                <button class="btn btn-green" id="rp-case-start-btn" style="max-width:520px;" onclick="rpCaseStart()">▶️ Lancer une étude de cas</button>
                <div id="rp-case-status" class="rp-real-hint" style="margin-top:8px;"></div>`;
            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = '';
            document.getElementById('rp-step-chat').style.display = 'none';
        }

        function rpCaseSet(what, value) {
            if (what === 'theme') rpCaseTheme = value; else rpCaseLevel = value;
            rpShowCaseHome();
        }

        // Invente le cas. Entreprises et personnes toujours fictives et génériques.
        async function rpCaseGenerate(theme, levelKey) {
            const raw = await GeminiService.generate(
                'Invente une courte étude de cas pour un entretien d\'embauche en logistique / supply chain en Belgique. Thème : ' + theme.sujet + '.\n' +
                RP_CASE_LEVELS[levelKey].consigne + '\n' +
                'Utilise uniquement des noms génériques (bedrijf X, transporteur A et B, leverancier Y) et des chiffres ronds et cohérents entre eux. Prévois 2 ou 3 informations supplémentaires que le recruteur ne donnera que si le candidat les demande.\n\n' +
                'Réponds UNIQUEMENT avec un objet JSON, sans texte autour :\n' +
                '{"titre_fr": "titre court en français", "enonce_nl": "l\'énoncé en néerlandais", "enonce_fr": "sa traduction française", ' +
                '"chiffres": [{"nl": "donnée chiffrée en néerlandais", "fr": "traduction"}], ' +
                '"question_nl": "la question posée au candidat, en néerlandais", "question_fr": "sa traduction", ' +
                '"infos_si_demande_nl": ["information supplémentaire en néerlandais"]}'
            );
            const m = raw.match(/\{[\s\S]*\}/);
            const cas = JSON.parse(m ? m[0] : raw);
            if (!cas.enonce_nl || !cas.question_nl) throw new Error('cas incomplet');
            cas.chiffres = Array.isArray(cas.chiffres) ? cas.chiffres : [];
            cas.infos_si_demande_nl = Array.isArray(cas.infos_si_demande_nl) ? cas.infos_si_demande_nl : [];
            return cas;
        }

        // Prompt du recruteur pour ce cas : il connaît tout le cas, mais pas de "bonne réponse".
        function rpBuildCasePrompt(cas, welcome) {
            return 'Tu es un recruteur belge néerlandophone qui fait passer une courte étude de cas à un candidat pour un poste en logistique.\n\n' +
                'Le cas : ' + cas.enonce_nl + '\n' +
                (cas.chiffres.length ? 'Chiffres connus du candidat :\n' + cas.chiffres.map(c => '- ' + c.nl).join('\n') + '\n' : '') +
                'Question posée : ' + cas.question_nl + '\n' +
                (cas.infos_si_demande_nl.length ? 'Informations supplémentaires, à ne donner QUE si le candidat pose la question correspondante :\n' + cas.infos_si_demande_nl.map(x => '- ' + x).join('\n') + '\n' : '') +
                '\nTu as déjà présenté le cas en disant : """' + welcome + '"""\n\n' +
                'Parle exclusivement en néerlandais, comme à l\'oral : une ou deux phrases. Réponds aux questions de clarification du candidat (invente un détail plausible et cohérent si besoin). ' +
                'Quand il propose une solution, demande-lui pourquoi, puis challenge-la une fois avec une objection réaliste. Il n\'y a pas une seule bonne réponse : tu évalues son raisonnement, tu ne donnes jamais la solution toi-même. ' +
                'Ne corrige jamais son néerlandais et ne sors jamais de ton rôle. Quand il a donné et défendu sa recommandation, remercie-le et conclus brièvement.';
        }

        async function rpCaseStart() {
            if (!GeminiService.isAvailable()) {
                alert("Les études de cas ont besoin de Gemini : renseigne ta clé API dans Profil → 🤖 Intelligence IA.");
                return;
            }
            const btn = document.getElementById('rp-case-start-btn');
            const status = document.getElementById('rp-case-status');
            const theme = rpCaseTheme === 'hasard'
                ? RP_CASE_THEMES[Math.floor(Math.random() * RP_CASE_THEMES.length)]
                : RP_CASE_THEMES.find(t => t.key === rpCaseTheme);
            if (btn) btn.disabled = true;
            if (status) status.innerText = 'Préparation du cas...';
            let cas;
            try {
                cas = await rpCaseGenerate(theme, rpCaseLevel);
            } catch (e) {
                if (btn) btn.disabled = false;
                if (status) status.innerText = 'Impossible de préparer le cas (' + e.message + '). Réessaie.';
                return;
            }
            if (rpCurrentCategory !== '__case') return; // l'utilisateur est parti pendant la préparation
            const welcome = stripMarkdown(cas.enonce_nl + ' ' + cas.question_nl);
            rpDayState = null;
            rpBeginScenario({ id: 'case_' + Date.now(), lang: 'nl', label: cas.titre_fr || 'Étude de cas', welcome, prompt: rpBuildCasePrompt(cas, welcome) });
            rpCaseState = { cas, welcome };
            const banner = document.getElementById('rp-mode-banner');
            banner.style.display = '';
            banner.innerHTML = `
                <div class="rp-job-banner">
                    <div class="rp-iv-label" style="margin-top:0;">💼 Étude de cas · ${rpEscapeHtml(RP_CASE_LEVELS[rpCaseLevel].label)}</div>
                    <div><b>${rpEscapeHtml(cas.titre_fr || theme.label)}</b></div>
                    ${cas.chiffres.length ? `<ul class="rp-case-figures">${cas.chiffres.map(c => `<li>${rpEscapeHtml(c.nl || '')}</li>`).join('')}</ul>` : ''}
                    <details><summary>Voir la traduction</summary>
                        <div>${rpEscapeHtml(cas.enonce_fr || '')} ${rpEscapeHtml(cas.question_fr || '')}</div>
                        ${cas.chiffres.length ? `<ul class="rp-case-figures">${cas.chiffres.map(c => `<li>${rpEscapeHtml(c.fr || '')}</li>`).join('')}</ul>` : ''}
                    </details>
                </div>`;
            const nav = document.getElementById('rp-day-nav');
            nav.style.display = 'block';
            nav.innerHTML = `<button class="btn btn-gray" style="margin:0;" onclick="rpCaseDebrief()">🏁 J'ai donné ma recommandation — voir le bilan</button>`;
        }

        // Bilan de l'étude de cas : appel Gemini séparé, sur le même écran de bilan que la journée.
        async function rpCaseDebrief() {
            const st = rpCaseState;
            if (!st) return;
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            if (!st.turns) {
                st.turns = [{ qui: 'RECRUTEUR', texte: st.welcome }].concat(
                    rpConversationHistory.slice(1).map(m => ({ qui: m.role === 'user' ? 'CANDIDAT' : 'RECRUTEUR', texte: m.parts[0].text })));
            }
            rpJobHideNav();
            document.getElementById('rp-step-chat').style.display = 'none';
            document.getElementById('rp-step-debrief').style.display = 'flex';
            const box = document.getElementById('rp-debrief-content');
            const header = `<div class="conj-verb-title">🏁 Bilan — ${rpEscapeHtml(st.cas.titre_fr || 'Étude de cas')}</div>`;
            const footer = `
                <button class="btn btn-green" style="margin-top:14px;" onclick="rpShowCaseHome()">Nouvelle étude de cas</button>
                <button class="btn btn-gray" style="margin-top:8px;" onclick="rpShowCategoryPicker()">Retour au jeu de rôle</button>`;
            if (!st.turns.some(t => t.qui === 'CANDIDAT')) {
                box.innerHTML = `<div class="conj-card">${header}<p>Tu n'as pas encore répondu : rien à analyser.</p>${footer}</div>`;
                return;
            }
            box.innerHTML = `<div class="conj-card">${header}<p style="color:var(--text-secondary);">Analyse de ta réponse en cours...</p></div>`;
            let raw;
            try {
                raw = await GeminiService.generate(
                    'Tu es un coach d\'entretien et professeur de néerlandais pour francophones. Voici une courte étude de cas passée en néerlandais par un candidat (CANDIDAT). Ses répliques peuvent avoir été dictées : ignore ponctuation et majuscules.\n\n' +
                    'Cas : ' + st.cas.enonce_nl + ' ' + st.cas.question_nl + '\n\n' +
                    st.turns.map(t => t.qui + ' : ' + t.texte).join('\n') + '\n\n' +
                    'Évalue UNIQUEMENT les répliques du CANDIDAT, avec bienveillance : c\'est un exercice de langue, pas un concours de consultant. Réponds UNIQUEMENT avec un objet JSON, sans texte autour :\n' +
                    '{"resume": "en français, 1-2 phrases : ce que le candidat a recommandé",\n' +
                    ' "raisonnement": "en français, 1-2 phrases : sa recommandation était-elle claire et justifiée ? a-t-il posé des questions utiles ?",\n' +
                    ' "points_forts": ["en français"],\n' +
                    ' "a_corriger": [{"phrase_apprenant": "ce qu\'il a dit", "probleme": "en français", "formulation_correcte": "en néerlandais"}],\n' +
                    ' "vocabulaire": [{"nl": "mot ou expression utile pour ce cas", "fr": "traduction"}],\n' +
                    ' "conseil": "en français, un conseil prioritaire"}\n' +
                    '3 points forts maximum, 5 corrections maximum, 8 mots de vocabulaire maximum.'
                );
            } catch (e) {
                box.innerHTML = `<div class="conj-card">${header}<p style="color:var(--wrong);">Bilan impossible : ${rpEscapeHtml(e.message)}</p>
                    <button class="btn btn-gray" onclick="rpCaseDebrief()">Réessayer</button>${footer}</div>`;
                return;
            }
            if (rpCaseState !== st) return;
            let d = null;
            try { const m = raw.match(/\{[\s\S]*\}/); d = JSON.parse(m ? m[0] : raw); } catch (e) { d = null; }
            if (!d || typeof d !== 'object') {
                box.innerHTML = `<div class="conj-card">${header}<div class="rp-iv-comment">${rpEscapeHtml(stripMarkdown(raw))}</div>${footer}</div>`;
                return;
            }
            const arr = x => Array.isArray(x) ? x : [];
            box.innerHTML = `
                <div class="conj-card">
                    ${header}
                    ${d.resume ? `<div class="rp-iv-label">Ta recommandation</div><div>${rpEscapeHtml(d.resume)}</div>` : ''}
                    ${d.raisonnement ? `<div class="rp-iv-label">Ton raisonnement</div><div>${rpEscapeHtml(d.raisonnement)}</div>` : ''}
                    ${arr(d.points_forts).length ? `<div class="rp-iv-label">Points forts</div>${arr(d.points_forts).map(p => `<div class="rp-debrief-item">✅ ${rpEscapeHtml(p)}</div>`).join('')}` : ''}
                    <div class="rp-iv-label">Formulations à corriger</div>
                    ${arr(d.a_corriger).length ? arr(d.a_corriger).map(b => `
                        <div class="rp-debrief-item">
                            <div>« ${rpEscapeHtml(b.phrase_apprenant || '')} »</div>
                            <div class="rp-debrief-sub">${rpEscapeHtml(b.probleme || '')}</div>
                            <div class="rp-iv-reference">→ ${rpEscapeHtml(b.formulation_correcte || '')} ${speakBtnHtml(b.formulation_correcte || '')}</div>
                        </div>`).join('') : '<div class="rp-debrief-sub">Rien à signaler, bravo.</div>'}
                    <div class="rp-iv-label">Vocabulaire utile pour ce cas</div>
                    ${arr(d.vocabulaire).length ? arr(d.vocabulaire).map(v => `<div class="conj-tense-row"><span class="conj-form">${rpEscapeHtml(v.nl || '')}</span> ${speakBtnHtml(v.nl || '')}<span class="rp-debrief-sub" style="flex:1;">${rpEscapeHtml(v.fr || '')}</span></div>`).join('') : '<div class="rp-debrief-sub">—</div>'}
                    ${d.conseil ? `<div class="rp-iv-label">Conseil pour la prochaine fois</div><div>${rpEscapeHtml(d.conseil)}</div>` : ''}
                    ${footer}
                </div>`;
        }

        // ===== Pratique ciblée (jeu de rôle piloté par une notion du curriculum) =====
        // Point de départ volontairement limité à quelques notions représentatives (voir consigne
        // utilisateur) plutôt qu'aux 125+ notions d'un coup. Le mécanisme (rpBeginScenario +
        // construction dynamique du prompt à partir du contenu pédagogique de la notion) est
        // générique et réutilisable pour d'autres notions par simple ajout d'une entrée ici — pas
        // de nouvelle architecture nécessaire. Le curriculum reste la source de vérité : Gemini ne
        // fait que mener la conversation, il ne redéfinit ni le niveau ni le programme.
        const NOTION_TARGETED_PRACTICE = {
            argumenter_simple: {
                label: '🎯 Pratique ciblée : mini-argumentation',
                welcome: "Wat vind jij: is het beter om vanuit huis te werken of op kantoor? Ik ben benieuwd naar je mening.",
                instruction: "Mène une courte conversation en néerlandais simple (B1) où tu invites la personne à structurer une mini-argumentation : d'abord son opinion, puis une raison, puis un exemple concret, puis une conclusion. Pose une relance à la fois pour l'aider à compléter une étape si elle l'oublie (par exemple si elle ne donne pas d'exemple, demande-lui-en un). Reste bienveillant et naturel, ce n'est pas un examen formel."
            },
            demander_clarification_b1: {
                label: '🎯 Pratique ciblée : demander une clarification',
                welcome: "Ik ga je iets uitleggen, maar het is nogal ingewikkeld: je moet het formulier binnen tien werkdagen indienen bij de bevoegde dienst, samen met de nodige bewijsstukken, anders vervalt je aanvraag automatisch.",
                instruction: "Tu donnes volontairement une explication un peu complexe ou rapide en néerlandais (B1), pour donner à la personne l'occasion de te demander de préciser, répéter ou reformuler. Quand elle demande une clarification, réponds-y clairement puis introduis une nouvelle information un peu complexe pour lui donner une autre occasion de pratiquer. Fais cela environ 3 fois. Ton patient et naturel."
            },
            connecteurs_complexes: {
                label: '🎯 Pratique ciblée : connecteurs logiques avancés',
                welcome: "Vertel me over een beslissing die je onlangs op je werk hebt genomen, en probeer connectoren zoals daarentegen, desondanks of bijgevolg te gebruiken.",
                instruction: "Mène une conversation en néerlandais (B2) sur une décision professionnelle. Encourage explicitement l'utilisation de connecteurs de concession/opposition/conséquence avancés (hoewel, ondanks, daarentegen, desondanks, bijgevolg, niettemin). Si la personne n'en utilise aucun après 2 réponses, demande-lui explicitement de reformuler en utilisant un de ces connecteurs. Une relance à la fois."
            },
            argumenter: {
                label: '🎯 Pratique ciblée : débat argumenté',
                welcome: "Moeten mensen tegenwoordig meer op afstand werken? Ik hoor graag jouw standpunt, met een duidelijk argument en een voorbeeld.",
                instruction: "Mène un débat structuré en néerlandais (B2) sur le télétravail ou un sujet professionnel proche. Fais pratiquer dans l'ordre : opinion, argument développé, exemple concret, contre-argument que tu introduis toi-même, réponse de la personne au contre-argument, puis demande une conclusion. Une étape à la fois, relance si une étape est sautée."
            },
            email_professionnel_complexe: {
                label: "🎯 Pratique ciblée : e-mail professionnel (à l'oral)",
                welcome: "Stel je voor: je moet een deadline met een klant verzetten. Vertel me mondeling wat je zou schrijven: de context, je verzoek, je reden, en hoe je een mogelijk bezwaar voorkomt.",
                instruction: "Simule oralement en néerlandais (B2) la préparation d'un e-mail professionnel pour reporter une échéance. Demande à la personne d'exprimer oralement : le contexte, la demande avec sa justification, l'anticipation d'une objection, et une formule de clôture adaptée. Relance point par point si un élément manque."
            },
            entretien_embauche_avance: {
                label: "🎯 Pratique ciblée : entretien d'embauche avancé",
                welcome: "Vertel me eens: wat is een werkpunt van jou, en hoe pak je dat aan?",
                instruction: "Mène un entretien d'embauche avancé en néerlandais (B2) en posant successivement une question sur un point faible, une question de mise en situation (méthode STAR : situation, tâche, action, résultat), et une question sur la motivation profonde. Pousse la personne à nuancer et à donner des exemples concrets. Une question à la fois, relance si la réponse reste vague."
            }
        };

        function buildTargetedPracticePrompt(notionId) {
            const cfg = NOTION_TARGETED_PRACTICE[notionId];
            const notion = curriculumNotions[notionId];
            if (!cfg || !notion) return null;
            const c = notion.content || {};
            return `${cfg.instruction}

Contexte pédagogique (sert uniquement à orienter tes relances, ne le récite jamais tel quel à l'apprenant) : niveau ${notion.level}, notion "${c.titre || ''}". Règle travaillée : ${c.regle || ''}. Erreurs fréquentes à surveiller sans les corriger longuement à l'oral : ${(c.erreursFrequentes || []).join(' / ')}. Critère de maîtrise visé : ${c.criteresMaitrise || ''}.

Ne donne jamais de longue correction grammaticale pendant la conversation orale : reste dans le rôle et relance naturellement (la correction détaillée se fait ailleurs dans l'application, via le feedback écrit). Ne redéfinis jamais le niveau CECR de l'apprenant ni le curriculum : contente-toi de le faire pratiquer.`;
        }

        function rpStartTargetedPractice(notionId) {
            const cfg = NOTION_TARGETED_PRACTICE[notionId];
            if (!cfg) { alert("Pratique ciblée non disponible pour cette notion."); return; }
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('roleplay-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            renderRpGeminiStatus();
            rpCheckDutchVoice();
            const prompt = buildTargetedPracticePrompt(notionId);
            rpCurrentCategory = null;
            rpBeginScenario({ id: 'cible_' + notionId, label: cfg.label, welcome: cfg.welcome, prompt });
        }

        rpInitSpeechRecognition();
        rpCheckDutchVoice();
        init();
