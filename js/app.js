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

// ===== Accès réservé aux comptes + invitations bêta =====
// Sans compte, on ne voit que l'écran de connexion (body.gated). Tant que Firebase n'a pas dit si
// une session existe, un écran d'attente évite d'afficher l'app puis de la masquer
// (body.auth-pending). Si le SDK Firebase n'a pas pu se charger, l'app reste utilisable en local.
// Lien d'invitation : ?invite=CODE (invites/{code} actif dans Firestore) → le compte créé, ou le
// compte déjà connecté, devient bêta-testeur et reçoit la clé Gemini partagée.
const INVITE_KEY = 'nl_invite_code';
if (firebaseAvailable) document.body.classList.add('auth-pending');
(function inviteCapture() {
    try {
        const url = new URL(location.href);
        const code = (url.searchParams.get('invite') || '').trim();
        if (!code) return;
        localStorage.setItem(INVITE_KEY, code);
        url.searchParams.delete('invite');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* pas grave */ }
})();

function invitePending() {
    try { return localStorage.getItem(INVITE_KEY) || ''; } catch (e) { return ''; }
}

async function inviteIsValid(code) {
    if (!code) return false;
    try {
        const snap = await db.collection('invites').doc(code).get();
        return snap.exists && snap.data().active === true;
    } catch (e) { return false; }
}

// Compte déjà existant qui ouvre un lien d'invitation : il devient bêta-testeur.
async function inviteApplyToAccount(uid, userDoc) {
    const code = invitePending();
    if (!code) return;
    if (!userDoc.beta && await inviteIsValid(code)) {
        try {
            await db.collection('users').doc(uid).update({ beta: true, inviteCode: code });
            userDoc.beta = true;
            userDoc.inviteCode = code;
        } catch (e) { console.warn('Invitation non appliquée :', e); }
    }
    localStorage.removeItem(INVITE_KEY);
}

function gateShow() {
    document.body.classList.remove('auth-pending');
    document.body.classList.add('gated');
    if (invitePending()) accMode = 'signup';
    showCompte();
    const banner = document.getElementById('gate-invite');
    if (banner) banner.style.display = invitePending() ? '' : 'none';
}

function gateOpen() {
    document.body.classList.remove('auth-pending', 'gated');
}

function accEmailFromPseudo(pseudo) {
    return pseudo.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '') + '@nl-mastery.local';
}

function accSwitchTab(mode) {
    accMode = mode;
    document.getElementById('acc-tab-login').classList.toggle('active', mode === 'login');
    document.getElementById('acc-tab-signup').classList.toggle('active', mode === 'signup');
    document.getElementById('acc-pseudo-label').innerText = mode === 'signup' ? 'Pseudo' : 'Pseudo (ou e-mail de récupération)';
    document.getElementById('acc-forgot').style.display = mode === 'login' ? 'block' : 'none';
    document.getElementById('acc-hint').style.display = mode === 'signup' ? 'block' : 'none';
    document.getElementById('acc-submit-btn').innerText = mode === 'signup' ? 'Créer mon compte' : 'Se connecter';
    document.getElementById('acc-error').innerText = '';
}

function accSetError(msg) {
    document.getElementById('acc-error').innerText = msg;
}

function accSubmit() {
    const ident = document.getElementById('acc-pseudo').value.trim();
    const password = document.getElementById('acc-password').value;
    accSetError('');

    if (!firebaseAvailable) {
        accSetError("Service de comptes indisponible pour le moment (connexion impossible). Ta progression locale reste intacte, réessaie plus tard.");
        return;
    }
    // En connexion, on accepte aussi l'e-mail de récupération (il devient l'identifiant).
    const isEmail = accMode === 'login' && ident.includes('@');
    if (!isEmail && !/^[a-zA-Z0-9_]{3,20}$/.test(ident)) {
        accSetError('Pseudo : 3 à 20 caractères, lettres/chiffres/underscore uniquement.');
        return;
    }
    if (password.length < 6) {
        accSetError('Le mot de passe doit faire au moins 6 caractères.');
        return;
    }

    if (accMode === 'signup') accSignup(ident, password);
    else accLogin(ident, password);
}

// Crée le compte NL Mastery (pseudo + document users) pour un utilisateur Firebase déjà
// authentifié : inscription classique ou première connexion avec Google.
async function accCreateAccountDoc(user, pseudo) {
    const uid = user.uid;
    const pseudoLower = pseudo.toLowerCase();
    await db.collection('usernames').doc(pseudoLower).set({ uid });
    const rev = syncNewRev();
    const userDoc = {
        pseudo, pseudoLower,
        role: 'user',
        disabled: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
        progress: syncClone(state),
        progressRev: rev,
        progressEpoch: 0
    };
    const invite = invitePending();
    let inviteExpired = false;
    if (invite) {
        if (await inviteIsValid(invite)) { userDoc.beta = true; userDoc.inviteCode = invite; }
        else inviteExpired = true;
    }
    await db.collection('users').doc(uid).set(userDoc);
    localStorage.removeItem(INVITE_KEY);
    currentUser = user;
    currentUserDoc = userDoc;
    // La progression faite sans compte sur cet appareil devient celle du nouveau compte.
    syncMetaReplace({ uid, rev, epoch: 0, dirty: false });
    cloudSetStatus('ok');
    await socialEnsureProfileDocs();
    await betaKeyRefresh(userDoc);
    gateOpen();
    if (state.onboardingSeen) showHome(); else showOnboarding();
    if (inviteExpired) alert("Ton compte est créé, mais le lien d'invitation n'est plus actif : demande un nouveau lien pour l'accès bêta.");
}

async function accSignup(pseudo, password) {
    const pseudoLower = pseudo.toLowerCase();
    accExplicitAuthInProgress = true;
    try {
        const takenDoc = await db.collection('usernames').doc(pseudoLower).get();
        if (takenDoc.exists) {
            accSetError('Ce pseudo est déjà pris.');
            return;
        }
        const cred = await auth.createUserWithEmailAndPassword(accEmailFromPseudo(pseudo), password);
        await accCreateAccountDoc(cred.user, pseudo);
    } catch (e) {
        accSetError(accFriendlyError(e));
    } finally {
        accExplicitAuthInProgress = false;
    }
}

// Après une connexion réussie (mot de passe ou Google) d'un compte existant.
async function accAfterLogin(user, userDoc) {
    currentUser = user;
    currentUserDoc = userDoc;
    await inviteApplyToAccount(user.uid, userDoc);
    await betaKeyRefresh(userDoc);
    // Réconcilie la progression de l'appareil avec celle du compte (adoption, fusion ou
    // envoi selon le cas — voir cloudReconcile). Si la page se recharge, rien d'autre à faire.
    cloudLastCheckAt = Date.now();
    const reloading = await cloudReconcile(userDoc, true);
    if (reloading) return;
    gateOpen();
    showHome();
    socialEnsureProfileDocs();
    notificationsRefreshBadge();
}

async function accLogin(ident, password) {
    const byEmail = ident.includes('@');
    const authEmail = byEmail ? ident : accEmailFromPseudo(ident);
    accExplicitAuthInProgress = true;
    try {
        const cred = await auth.signInWithEmailAndPassword(authEmail, password);
        const snap = await db.collection('users').doc(cred.user.uid).get();
        if (!snap.exists) { accSetError("Compte introuvable."); await auth.signOut(); return; }
        const userDoc = snap.data();
        if (userDoc.disabled) {
            accSetError(userDoc.transferredTo ? "Ce compte a été transféré vers un nouveau compte : connecte-toi avec le nouveau." : "Ce compte a été désactivé. Contacte l'administrateur.");
            await auth.signOut();
            return;
        }
        await accAfterLogin(cred.user, userDoc);
    } catch (e) {
        let msg = accFriendlyError(e);
        if (!byEmail && /incorrect|introuvable|Aucun compte/.test(msg)) msg += " Si tu as ajouté un e-mail de récupération, connecte-toi avec cet e-mail.";
        accSetError(msg);
    } finally {
        accExplicitAuthInProgress = false;
    }
}

// ===== Récupération de compte : Google, e-mail, transfert par l'admin =====
// 1) Google : « Continuer avec Google » (connexion, ou création avec un pseudo choisi ensuite)
//    et « Lier mon compte Google » pour un compte existant (Firebase : linkWithPopup).
// 2) E-mail : l'e-mail confirmé (verifyBeforeUpdateEmail) remplace l'adresse fictive
//    pseudo@nl-mastery.local ; on se connecte alors avec lui, et « Mot de passe oublié ? »
//    marche (sendPasswordResetEmail). L'e-mail n'est jamais lisible à partir du pseudo.
// 3) Sinon, l'admin transfère la progression vers un nouveau compte (panneau admin).
function accGoogleProvider() {
    const p = new firebase.auth.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    return p;
}

async function accGoogle() {
    if (!firebaseAvailable) { accSetError('Service de comptes indisponible pour le moment.'); return; }
    accSetError('');
    accExplicitAuthInProgress = true;
    try {
        let cred;
        try { cred = await auth.signInWithPopup(accGoogleProvider()); }
        catch (e) {
            if (/popup-blocked|operation-not-supported/.test(e.code || '')) { await auth.signInWithRedirect(accGoogleProvider()); return; }
            throw e;
        }
        await accGoogleContinue(cred.user);
    } catch (e) {
        if (!/popup-closed|cancelled-popup/.test(e.code || '')) accSetError(accFriendlyError(e));
    } finally {
        accExplicitAuthInProgress = false;
    }
}

// Utilisateur Google authentifié : compte existant → connexion ; sinon → choix du pseudo.
async function accGoogleContinue(user) {
    const snap = await db.collection('users').doc(user.uid).get();
    if (snap.exists) {
        const userDoc = snap.data();
        if (userDoc.disabled) { accSetError("Ce compte a été désactivé. Contacte l'administrateur."); await auth.signOut(); return; }
        await accAfterLogin(user, userDoc);
        return;
    }
    currentUser = user;
    accShowPseudoStep();
}

function accShowPseudoStep() {
    document.getElementById('acc-logged-out').style.display = 'none';
    document.getElementById('acc-pseudo-step').style.display = 'block';
    const input = document.getElementById('acc-google-pseudo');
    if (input) input.focus();
}

async function accGoogleFinish() {
    const user = auth && auth.currentUser;
    const err = document.getElementById('acc-google-error');
    const pseudo = (document.getElementById('acc-google-pseudo').value || '').trim();
    err.innerText = '';
    if (!user) { err.innerText = 'Session Google expirée : recommence avec « Continuer avec Google ».'; return; }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(pseudo)) { err.innerText = 'Pseudo : 3 à 20 caractères, lettres/chiffres/underscore uniquement.'; return; }
    accExplicitAuthInProgress = true;
    try {
        const taken = await db.collection('usernames').doc(pseudo.toLowerCase()).get();
        if (taken.exists) { err.innerText = 'Ce pseudo est déjà pris.'; return; }
        await accCreateAccountDoc(user, pseudo);
        document.getElementById('acc-pseudo-step').style.display = 'none';
    } catch (e) {
        err.innerText = accFriendlyError(e);
    } finally {
        accExplicitAuthInProgress = false;
    }
}

async function accGoogleCancel() {
    document.getElementById('acc-pseudo-step').style.display = 'none';
    document.getElementById('acc-logged-out').style.display = 'block';
    try { await auth.signOut(); } catch (e) { /* pas grave */ }
    currentUser = null;
}

function accForgotPassword() {
    const typed = (document.getElementById('acc-pseudo').value || '').trim();
    const email = prompt("Ton e-mail de récupération (celui que tu as confirmé dans ton compte) :", typed.includes('@') ? typed : '');
    if (!email) return;
    if (!email.includes('@')) { alert("Il faut l'adresse e-mail. Sans e-mail de récupération ni compte Google lié, demande à l'administrateur de transférer ta progression vers un nouveau compte."); return; }
    auth.sendPasswordResetEmail(email.trim())
        .then(() => alert("Si un compte utilise cette adresse, un e-mail vient d'être envoyé pour choisir un nouveau mot de passe. Pense à regarder dans les spams."))
        .catch(e => alert('Envoi impossible : ' + accFriendlyError(e)));
}

// Bloc « Ne jamais perdre l'accès » dans le compte connecté.
function accRenderBackup() {
    const el = document.getElementById('acc-backup');
    const user = auth && auth.currentUser;
    if (!el || !user) return;
    const google = user.providerData.find(p => p.providerId === 'google.com');
    const realEmail = user.email && !/@nl-mastery\.local$/i.test(user.email) ? user.email : '';
    const pending = localStorage.getItem('nl_pending_email') || '';
    el.innerHTML = `
        <div class="study-box acc-backup" style="text-align:left;">
            <h3 style="margin-top:0;">🛟 Ne jamais perdre l'accès</h3>
            <p style="font-size:0.82rem;">Si tu oublies ton mot de passe, ces options te permettent de récupérer ton compte. Une seule suffit.</p>
            <div class="acc-backup-row">
                <b>Google</b>
                ${google ? `<span>✅ Lié (${rpEscapeHtml(google.email || '')}) : tu peux te connecter avec « Continuer avec Google ».</span>`
                    : `<button class="btn btn-gray" style="margin:4px 0 0;" onclick="accLinkGoogle()">🔗 Lier mon compte Google</button>`}
            </div>
            <div class="acc-backup-row">
                <b>E-mail de récupération</b>
                ${realEmail ? `<span>✅ ${rpEscapeHtml(realEmail)} : connecte-toi avec cette adresse ; « Mot de passe oublié ? » fonctionne.</span>`
                    : `${pending ? `<span>📨 Lien envoyé à ${rpEscapeHtml(pending)} : clique dessus pour confirmer (regarde aussi les spams). Ensuite, tu te connecteras avec cette adresse.</span>` : ''}
                       <input type="email" id="acc-backup-email" placeholder="ton@email.com" autocomplete="email" style="margin:6px 0 0;">
                       <button class="btn btn-gray" style="margin:6px 0 0;" onclick="accAddRecoveryEmail()">📧 Envoyer le lien de confirmation</button>`}
            </div>
            ${!google && !realEmail ? `<p class="report-meta">Sans Google ni e-mail, en cas d'oubli, seul l'administrateur peut transférer ta progression vers un nouveau compte.</p>` : ''}
            <p id="acc-backup-msg" class="report-meta"></p>
        </div>`;
}

async function accReauth() {
    const user = auth.currentUser;
    if (user.providerData.some(p => p.providerId === 'password')) {
        const pwd = prompt('Par sécurité, retape ton mot de passe :');
        if (!pwd) throw new Error('Opération annulée.');
        await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, pwd));
    } else {
        await user.reauthenticateWithPopup(accGoogleProvider());
    }
}

async function accLinkGoogle() {
    const msg = document.getElementById('acc-backup-msg');
    try {
        await auth.currentUser.linkWithPopup(accGoogleProvider());
        accRenderBackup();
    } catch (e) {
        const code = e.code || '';
        if (/credential-already-in-use|email-already-in-use/.test(code)) msg.innerText = 'Ce compte Google est déjà utilisé par un autre compte NL Mastery.';
        else if (/provider-already-linked/.test(code)) accRenderBackup();
        else if (!/popup-closed|cancelled-popup/.test(code)) msg.innerText = 'Liaison impossible : ' + accFriendlyError(e);
    }
}

async function accAddRecoveryEmail() {
    const msg = document.getElementById('acc-backup-msg');
    const email = (document.getElementById('acc-backup-email').value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.innerText = 'Adresse e-mail invalide.'; return; }
    const send = () => auth.currentUser.verifyBeforeUpdateEmail(email);
    try {
        try { await send(); }
        catch (e) {
            if (!/requires-recent-login/.test(e.code || '')) throw e;
            await accReauth();
            await send();
        }
        localStorage.setItem('nl_pending_email', email);
        accRenderBackup();
    } catch (e) {
        const code = e.code || '';
        msg.innerText = /email-already-in-use/.test(code) ? 'Cette adresse est déjà utilisée par un autre compte.' : 'Envoi impossible : ' + accFriendlyError(e);
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
    localStorage.removeItem(BETA_KEY_STORAGE);
    location.reload();
}

function accShowLoggedIn() {
    document.getElementById('acc-logged-out').style.display = 'none';
    document.getElementById('acc-logged-in').style.display = 'block';
    document.getElementById('acc-current-pseudo').innerText = '👤 ' + currentUserDoc.pseudo;
    document.getElementById('acc-admin-entry').style.display = currentUserDoc.role === 'admin' ? 'grid' : 'none';
    accRenderBackup();
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
            return Object.assign({}, pick, { opened: !!(a.opened || b.opened), validated: !!(a.validated || b.validated) });
        }
        // Une forme conjuguée : ok/ko/streak vont ensemble, on garde la réponse la plus récente.
        if (path.indexOf('conjStats.') === 0 || path.indexOf('chunkStats.') === 0) return (b.last || 0) > (a.last || 0) ? b : a;
        if (path.indexOf('profLessons.') === 0) return a;
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
        if (userDoc.disabled) { await auth.signOut(); currentUser = null; currentUserDoc = null; betaKeyRefresh(null); return false; }
        currentUserDoc = userDoc;
        betaKeyRefresh(userDoc);
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

// ===== Clé Gemini partagée (bêta-testeurs) =====
// L'admin range sa clé une fois dans Firestore (config/gemini) et coche les comptes bêta-testeurs
// (users/{uid}.beta). À la connexion, un compte coché reçoit la clé sur son appareil
// (localStorage, jamais dans la progression synchronisée) ; décoché ou déconnecté, elle est
// retirée. Voir firestore.rules (isBetaTester) : personne d'autre ne peut la lire.
const BETA_KEY_STORAGE = 'gemini_shared_key';
async function betaKeyRefresh(userDoc) {
    try {
        const u = auth && auth.currentUser;
        if (u && u.email && !/@nl-mastery\.local$/i.test(u.email)) localStorage.removeItem('nl_pending_email');
    } catch (e) { /* pas grave */ }
    if (!userDoc || !(userDoc.beta || userDoc.role === 'admin') || userDoc.disabled) {
        localStorage.removeItem(BETA_KEY_STORAGE);
        return;
    }
    try {
        const snap = await db.collection('config').doc('gemini').get();
        const key = snap.exists ? String(snap.data().key || '').trim() : '';
        if (key) localStorage.setItem(BETA_KEY_STORAGE, key); else localStorage.removeItem(BETA_KEY_STORAGE);
    } catch (e) {
        // Règles pas encore publiées, ou accès retiré : pas de clé partagée.
        localStorage.removeItem(BETA_KEY_STORAGE);
    }
}

async function adminRenderSharedKey() {
    const el = document.getElementById('admin-shared-key');
    if (!el) return;
    let key = '';
    try {
        const snap = await db.collection('config').doc('gemini').get();
        key = snap.exists ? String(snap.data().key || '') : '';
    } catch (e) {
        el.innerHTML = `<p class="report-meta">Lecture impossible (${e.message}). As-tu publié les nouvelles règles Firestore ?</p>`;
        return;
    }
    el.innerHTML = `
        <div class="study-box" style="text-align:left; margin-top:0;">
            <h3 style="margin-top:0;">🔑 Clé Gemini partagée (bêta)</h3>
            <p style="font-size:0.85rem;">${key ? `✅ Une clé est enregistrée (…${key.slice(-4)}). Les comptes cochés « 🧪 Bêta » la reçoivent à la connexion.` : 'Aucune clé partagée pour l\'instant.'}</p>
            <input type="password" id="admin-shared-key-input" placeholder="Colle ici la clé à partager">
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                <button class="btn btn-green" style="margin:0; width:auto;" onclick="adminSaveSharedKey()">💾 Enregistrer</button>
                ${key ? `<button class="btn btn-red" style="margin:0; width:auto;" onclick="adminRemoveSharedKey()">🗑️ Retirer la clé partagée</button>` : ''}
            </div>
            <p class="report-meta">Conseil : limite la clé à ton site dans la console Google Cloud (Identifiants → Référents HTTP : https://joasmk1-rgb.github.io/*).</p>
        </div>`;
}

async function adminSaveSharedKey() {
    const input = document.getElementById('admin-shared-key-input');
    const key = input ? input.value.trim() : '';
    if (!key) { alert("Colle une clé avant d'enregistrer."); return; }
    try {
        await db.collection('config').doc('gemini').set({ key, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        await betaKeyRefresh(currentUserDoc);
        adminRenderSharedKey();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function adminRemoveSharedKey() {
    if (!confirm('Retirer la clé partagée ? Les bêta-testeurs ne pourront plus utiliser Gemini (sauf avec leur propre clé).')) return;
    try {
        await db.collection('config').doc('gemini').delete();
        await betaKeyRefresh(currentUserDoc);
        adminRenderSharedKey();
    } catch (e) { alert('Erreur : ' + e.message); }
}

// Liens d'invitation : codes aléatoires, réutilisables, activables/désactivables.
let adminUsersCache = [];
async function adminRenderInvites() {
    const el = document.getElementById('admin-invites');
    if (!el) return;
    let invites = [];
    try {
        const snap = await db.collection('invites').get();
        snap.forEach(d => invites.push(Object.assign({ code: d.id }, d.data())));
    } catch (e) {
        el.innerHTML = `<p class="report-meta">Lecture des invitations impossible (${e.message}). As-tu publié les nouvelles règles Firestore ?</p>`;
        return;
    }
    const base = location.origin + location.pathname;
    el.innerHTML = `
        <div class="study-box" style="text-align:left; margin-top:0;">
            <h3 style="margin-top:0;">🎟️ Liens d'invitation bêta</h3>
            <p style="font-size:0.85rem;">Une personne qui ouvre le lien et crée son compte (ou se connecte) devient bêta-testeur et reçoit la clé Gemini partagée. Le lien est réutilisable ; désactive-le quand tu veux.</p>
            ${invites.map(inv => {
                const n = adminUsersCache.filter(u => u.inviteCode === inv.code).length;
                const link = base + '?invite=' + inv.code;
                return `<div class="admin-invite">
                    <div><b>${rpEscapeHtml(inv.label || 'Invitation')}</b> · ${inv.active ? '🟢 actif' : '⚪ désactivé'} · ${n} compte${n > 1 ? 's' : ''}</div>
                    <input type="text" readonly value="${rpEscapeHtml(link)}" onclick="this.select()">
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        <button class="btn btn-green" style="margin:0; width:auto;" onclick="adminCopyInvite('${inv.code}')">📋 Copier le lien</button>
                        <button class="btn btn-gray" style="margin:0; width:auto;" onclick="adminToggleInvite('${inv.code}', ${!inv.active})">${inv.active ? 'Désactiver' : 'Réactiver'}</button>
                    </div>
                </div>`;
            }).join('') || '<p class="report-meta">Aucun lien pour l\'instant.</p>'}
            <button class="btn btn-green" style="margin-top:8px;" onclick="adminCreateInvite()">➕ Créer un lien d'invitation</button>
        </div>`;
}

async function adminCreateInvite() {
    const label = prompt('Nom du lien (pour toi, ex. « Amis », « Collègues ») :', 'Bêta') || 'Bêta';
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    const code = [...bytes].map(b => alphabet[b % alphabet.length]).join('');
    try {
        await db.collection('invites').doc(code).set({ active: true, label, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        adminRenderInvites();
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function adminToggleInvite(code, active) {
    try {
        await db.collection('invites').doc(code).update({ active });
        adminRenderInvites();
    } catch (e) { alert('Erreur : ' + e.message); }
}

function adminCopyInvite(code) {
    const link = location.origin + location.pathname + '?invite=' + code;
    const done = () => alert('Lien copié :\n' + link);
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => prompt('Copie ce lien :', link));
    else prompt('Copie ce lien :', link);
}

// Transfert d'un compte (mot de passe perdu, sans Google ni e-mail) vers un nouveau compte :
// progression et statut bêta passent sur le nouveau ; l'ancien est désactivé. progressEpoch
// change : les appareils du nouveau compte adoptent la progression au lieu de la fusionner.
function adminRenderTransfer() {
    const el = document.getElementById('admin-transfer');
    if (!el) return;
    const opts = adminUsersCache.filter(u => !u.transferredTo).map(u => `<option value="${u.uid}">${rpEscapeHtml(u.pseudo || u.uid)}${u.disabled ? ' (désactivé)' : ''}</option>`).join('');
    el.innerHTML = `
        <div class="study-box" style="text-align:left; margin-top:0;">
            <h3 style="margin-top:0;">🔁 Transférer un compte</h3>
            <p style="font-size:0.85rem;">Pour quelqu'un qui a perdu son mot de passe sans Google ni e-mail : il crée un nouveau compte, puis tu y transfères sa progression (et son accès bêta). L'ancien compte est désactivé. Le nouveau garde son propre pseudo.</p>
            <label class="report-meta">Ancien compte (perdu)</label>
            <select id="admin-transfer-from" class="prof-select"><option value="">—</option>${opts}</select>
            <label class="report-meta" style="display:block; margin-top:6px;">Nouveau compte</label>
            <select id="admin-transfer-to" class="prof-select"><option value="">—</option>${opts}</select>
            <button class="btn btn-green" style="margin-top:8px;" onclick="adminTransfer()">🔁 Transférer</button>
        </div>`;
}

async function adminTransfer() {
    const from = document.getElementById('admin-transfer-from').value;
    const to = document.getElementById('admin-transfer-to').value;
    if (!from || !to || from === to) { alert('Choisis deux comptes différents.'); return; }
    const a = adminUsersCache.find(u => u.uid === from), b = adminUsersCache.find(u => u.uid === to);
    if (!confirm(`Transférer la progression de « ${a.pseudo} » vers « ${b.pseudo} » ? La progression actuelle de « ${b.pseudo} » sera remplacée, et « ${a.pseudo} » sera désactivé.`)) return;
    try {
        const snap = await db.collection('users').doc(from).get();
        const old = snap.data() || {};
        const patchTo = { progress: old.progress || {}, progressRev: syncNewRev(), progressEpoch: Date.now() };
        if (old.beta) { patchTo.beta = true; if (old.inviteCode) patchTo.inviteCode = old.inviteCode; }
        await db.collection('users').doc(to).update(patchTo);
        await db.collection('users').doc(from).update({ disabled: true, transferredTo: to });
        alert('Transfert effectué.');
        if (currentUser && currentUser.uid === to) { await cloudCheck(); }
        loadAdminUsers().then(adminRenderInvites);
    } catch (e) { alert('Erreur : ' + e.message); }
}

async function adminToggleBeta(uid, newVal) {
    try {
        await db.collection('users').doc(uid).update({ beta: newVal });
        loadAdminUsers();
    } catch (e) {
        alert('Erreur : ' + e.message);
    }
}

// ===== Panneau admin =====
function showAdmin() {
    if (!currentUserDoc || currentUserDoc.role !== 'admin') {
        alert("Accès réservé à l'administrateur.");
        return;
    }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('admin-view').classList.add('active');
    adminRenderSharedKey();
    loadAdminUsers().then(adminRenderInvites);
}

async function loadAdminUsers() {
    const listEl = document.getElementById('admin-user-list');
    listEl.innerHTML = 'Chargement...';
    try {
        const snap = await db.collection('users').orderBy('pseudo').get();
        if (snap.empty) { listEl.innerHTML = 'Aucun compte.'; return; }
        listEl.innerHTML = '';
        adminUsersCache = [];
        snap.forEach(doc => adminUsersCache.push(Object.assign({ uid: doc.id }, doc.data())));
        adminRenderTransfer();
        snap.forEach(doc => {
            const u = doc.data();
            const uid = doc.id;
            const row = document.createElement('div');
            row.className = 'admin-row';
            row.innerHTML = `
                <span class="admin-pseudo">${u.pseudo}${u.role === 'admin' ? ' 👑' : ''}</span>
                <span class="admin-status ${u.disabled ? 'disabled' : 'active'}">${u.disabled ? 'Désactivé' : 'Actif'}</span>
                <button style="background:${u.disabled ? 'var(--success)' : 'var(--wrong)'}" onclick="adminToggleDisabled('${uid}', ${!u.disabled})">${u.disabled ? 'Réactiver' : 'Désactiver'}</button>
                <button style="background:${u.beta ? 'var(--primary)' : '#888'}" onclick="adminToggleBeta('${uid}', ${!u.beta})" title="Reçoit la clé Gemini partagée">🧪 Bêta : ${u.beta ? 'oui' : 'non'}</button>
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
        if (accExplicitAuthInProgress) return;
        if (!user) { gateShow(); return; }
        try {
            const snap = await db.collection('users').doc(user.uid).get();
            if (!snap.exists) {
                gateShow();
                if (user.providerData.some(p => p.providerId === 'google.com')) { currentUser = user; accShowPseudoStep(); }
                return;
            }
            const userDoc = snap.data();
            if (userDoc.disabled) { await auth.signOut(); return; }
            currentUser = user;
            currentUserDoc = userDoc;
            await inviteApplyToAccount(user.uid, userDoc);
            await betaKeyRefresh(userDoc);
            gateOpen();
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
            // Session connue mais compte illisible (hors ligne...) : on ne bloque pas l'app.
            console.error('Reprise de session échouée', e);
            gateOpen();
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
            return items.filter(i => !isTrueMastered(i.id) && !isActiveWord(i.id) && (state.stats.wrongCount[dirKey(i.id)] || 0) === 0);
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
            return batchItems.length > 0 && batchItems.every(i => isTrueMastered(i.id) || isActiveWord(i.id));
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

        // Les trous des exercices (___, ----, ....) étaient lus « tiret tiret » ou « liggend
        // streepje » : on les remplace par une courte pause.
        function speechBlanks(text) {
            return String(text).replace(/_+|-{3,}|\.{4,}|…{2,}/g, ' … ').replace(/\s+/g, ' ').trim();
        }

        function speakNL(text) {
            if (!('speechSynthesis' in window) || !text) return;
            // Pour la voix, on retire aussi les emojis, que certaines voix décrivent à haute voix.
            text = speechBlanks(stripMarkdown(text)).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').trim();
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

        // ===== Signaler une erreur =====
        // Bouton ⚠️ à côté d'un mot, d'une forme conjuguée ou d'une question : l'apprenant signale
        // une traduction douteuse sans quitter sa session. Les signalements vivent dans
        // state.reports (objet id → signalement, donc synchronisé entre appareils comme le reste ;
        // « traité » = done:true, jamais supprimé, pour que la fusion ne le fasse pas revenir).
        // Profil → 🚩 Mes signalements : copier ou télécharger la liste pour la corriger.
        function reportBtnHtml(payload) {
            const data = encodeURIComponent(JSON.stringify(payload));
            return `<button type="button" class="report-btn" data-report="${data}" onclick="event.stopPropagation(); reportFromBtn(this)" title="Signaler une erreur" aria-label="Signaler une erreur">⚠️</button>`;
        }

        function reportFromBtn(btn) {
            let payload = {};
            try { payload = JSON.parse(decodeURIComponent(btn.dataset.report)); } catch (e) { return; }
            if (reportIssue(payload)) { btn.innerText = '✅'; btn.disabled = true; }
        }

        function reportIssue(payload) {
            const what = [payload.nl, payload.fr].filter(Boolean).join(' = ');
            const note = window.prompt('Signaler une erreur sur :\n' + what + '\n\nQu\'est-ce qui ne va pas ? (facultatif, ex. « la traduction devrait être… »)', '');
            if (note === null) return false; // annulé
            if (!state.reports) state.reports = {};
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            state.reports[id] = {
                kind: String(payload.kind || 'mot'), ref: String(payload.ref || ''), nl: String(payload.nl || ''),
                fr: String(payload.fr || ''), context: String(payload.context || ''), note: note.trim(),
                at: Date.now(), done: false
            };
            save();
            return true;
        }

        function reportCurrentItem() {
            if (!currentItem) return;
            if (reportIssue({ kind: 'mot', ref: currentItem.id, nl: currentItem.nl, fr: currentItem.fr, context: categoryLabel(currentItem.file) })) {
                const btn = document.getElementById('study-report-btn');
                if (btn) { btn.innerText = '✅ Signalé'; setTimeout(() => { btn.innerText = '⚠️ Signaler'; }, 1500); }
            }
        }

        function openReports() {
            return Object.entries(state.reports || {}).filter(([, r]) => !r.done).sort((a, b) => a[1].at - b[1].at);
        }

        function reportsAsText() {
            const list = openReports();
            if (!list.length) return 'Aucun signalement en attente.';
            return 'Signalements NL Mastery (' + list.length + ') :\n' + list.map(([, r]) =>
                `- [${r.kind}] ${r.nl}${r.fr ? ' = ' + r.fr : ''}${r.context ? ' (' + r.context + ')' : ''}${r.ref && r.ref !== r.nl ? ' · réf. ' + r.ref : ''}${r.note ? ' → ' + r.note : ''} · ${new Date(r.at).toLocaleDateString('fr-BE')}`
            ).join('\n');
        }

        async function reportsCopy() {
            const text = reportsAsText();
            try { await navigator.clipboard.writeText(text); alert('Liste copiée : colle-la dans ta conversation avec Claude.'); }
            catch (e) { window.prompt('Copie ce texte :', text); }
        }

        function reportsDownload() {
            const list = openReports().map(([id, r]) => Object.assign({ id }, r));
            const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'nl-mastery-signalements-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); a.remove();
        }

        function reportsMarkDone(id) {
            const list = id ? [[id, state.reports[id]]] : openReports();
            if (!id && !confirm('Marquer les ' + list.length + ' signalement(s) comme traités ?')) return;
            list.forEach(([, r]) => { if (r) r.done = true; });
            save();
            renderProfil();
        }

        function reportsSectionHtml(openSections) {
            const list = openReports();
            const rows = list.map(([id, r]) => `
                <div class="report-row">
                    <div><b>${rpEscapeHtml(r.nl)}</b>${r.fr ? ' = ' + rpEscapeHtml(r.fr) : ''}
                        <div class="report-meta">${rpEscapeHtml(r.kind)}${r.context ? ' · ' + rpEscapeHtml(r.context) : ''} · ${new Date(r.at).toLocaleDateString('fr-BE')}</div>
                        ${r.note ? `<div class="report-note">« ${rpEscapeHtml(r.note)} »</div>` : ''}</div>
                    <button type="button" class="conj-filter-chip" onclick="reportsMarkDone('${id}')">✓ Traité</button>
                </div>`).join('');
            return `
                <details class="profil-section" id="profil-sec-reports" ${openSections.includes('profil-sec-reports') ? 'open' : ''}>
                <summary>🚩 Mes signalements${list.length ? ' (' + list.length + ')' : ''}</summary>
                <div class="study-box" style="text-align:left;">
                    <p style="font-size:0.85rem;">Les erreurs signalées avec ⚠️ pendant tes sessions. Une fois par semaine : copie la liste et donne-la à Claude pour qu'il corrige, puis marque-les comme traitées.</p>
                    ${list.length ? rows : '<p style="color:var(--text-secondary);">Aucun signalement en attente.</p>'}
                    ${list.length ? `
                        <button class="btn btn-green" onclick="reportsCopy()">📋 Copier la liste</button>
                        <button class="btn btn-gray" onclick="reportsDownload()">📥 Télécharger (fichier)</button>
                        <button class="btn btn-gray" onclick="reportsMarkDone()">✓ Tout marquer comme traité</button>` : ''}
                </div>
                </details>`;
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
                'EXPRESSIONS_NL.csv', 'LOCUTIONS_NL.csv', 'PHRASES_LABO_avec_frequence.csv', 'MOTS_LABO_avec_frequence.csv'
            ];
            // Fichiers de thèmes métier : optionnels. Ajoute simplement un CSV avec un de ces noms
            // (ou un nouveau nom dans cette liste) pour qu'il apparaisse automatiquement dans "Thèmes".
            const themeCandidates = [
                'THEME_BASE_avec_frequence.csv', 'THEME_MARKETING.csv', 'THEME_FINANCE.csv',
                'THEME_COMPTABILITE.csv', 'THEME_LOGISTIQUE.csv', 'THEME_SUPPLYCHAIN.csv',
                'THEME_MANAGEMENT.csv', 'THEME_RH.csv', 'THEME_ENTRETIEN.csv',
                'THEME_BUSINESS_ANALYST.csv', 'THEME_CONSULTANT.csv', 'THEME_PROJET.csv',
                'THEME_BIBLIOTHEQUE.csv',
                'THEME_DATA.csv',
                'THEME_PMO.csv',
                'THEME_ERP.csv'
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
            // Kits de préparation des jeux de rôle : leurs mots absents du vocabulaire sont ajoutés
            // à fullDb (catégorie « Kits jeu de rôle ») pour avoir une progression comme les autres.
            await rpLoadPrepKits();
            rpWordsInject();

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
            // Traduction française de chaque forme, générée une fois pour toutes (voir
            // tools/noyau/build_conjugation_fr.py) : plus besoin de Gemini pour la conjugaison.
            try {
                conjFrStatic = await fetch('data/curriculum/conjugation_fr.json').then(r => r.ok ? r.json() : {});
            } catch (e) {
                conjFrStatic = {};
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
            if (!p || (!p.opened && !p.attempts && !p.validated)) return 0;
            if (!p.attempts) return p.validated ? 4 : 1;
            // Progression unifiée (octobre 2026) : toutes les activités (modules, cours particulier,
            // conjugaison, exercices de notion) alimentent les mêmes notions. On juge sur les 10
            // dernières réponses (p.recent) : avant, une seule erreur bloquait la notion à 3 pour
            // toujours. Un examen de module réussi (p.validated) garantit au moins « presque maîtrisée ».
            const recent = Array.isArray(p.recent) && p.recent.length ? p.recent : null;
            const ratio = recent ? recent.reduce((a, b) => a + b, 0) / recent.length : p.correct / p.attempts;
            let m = ratio < 0.5 ? 2 : (ratio < 0.8 ? 3 : 4);
            if (m === 4 && p.attempts < 3) m = 3; // une ou deux bonnes réponses ne suffisent pas
            if (m === 4 && p.attempts >= 6) m = 5;
            if (p.validated && ratio >= 0.5) m = Math.max(m, 4);
            return m;
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
                    }).join('') : `<div style="font-size:0.8rem; color:var(--text-secondary);">Débloque des notions dans Cours pour accéder à la production écrite.</div>`;
                }
            }
        }

        // ===== Onglet « Jouer » : les 4 jeux de vocabulaire =====
        function showReviser() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('reviser-view').classList.add('active');
            setActiveNav('nav-reviser');
        }

        // Ce qui est à revoir : les mots (en bas de Vocabulaire) et les notions fragiles (dans
        // Cours). Chacun est dessiné là où sa vue existe.
        function renderReviser() {
            const voc = document.getElementById('vocab-review');
            if (voc) {
                const wordCount = getReviewItems().length;
                const articleCount = getArticleReviewItems().length;
                voc.innerHTML = `
                    <div class="hub-card" onclick="studyReturnFn = showVocab; startRevision()">
                        <span class="hub-card-icon">🔁</span>
                        <div class="hub-card-title">Mots à revoir</div>
                        <div class="hub-card-desc">${wordCount} mot${wordCount > 1 ? 's' : ''} raté${wordCount > 1 ? 's' : ''}.</div>
                    </div>
                    <div class="hub-card" onclick="studyReturnFn = showVocab; startArticleRevision()">
                        <span class="hub-card-icon">🔤</span>
                        <div class="hub-card-title">De ou het ?</div>
                        <div class="hub-card-desc">${articleCount} mot${articleCount > 1 ? 's' : ''} à revoir.</div>
                    </div>
                    <div class="hub-card" onclick="showChunkTraining()">
                        <span class="hub-card-icon">🧩</span>
                        <div class="hub-card-title">Blocs de mots</div>
                        <div class="hub-card-desc">Les mots en contexte.</div>
                    </div>
                    <div class="hub-card" onclick="showTestSelect()">
                        <span class="hub-card-icon">🎯</span>
                        <div class="hub-card-title">Test de vocabulaire</div>
                        <div class="hub-card-desc">Combien de mots tu connais.</div>
                    </div>`;
            }
            const el = document.getElementById('cours-weak');
            if (!el) return;
            const weaknesses = curriculumLoaded ? getWeaknesses().slice(0, 8) : [];
            el.innerHTML = `
                ${weaknesses.length ? `
                <div class="section-title" style="margin:var(--space-4) 0 var(--space-2);">Notions à consolider</div>
                <div class="hub-grid single">
                    ${weaknesses.map(w => {
                        const titre = notionTitle(w.id);
                        // Phrase explicite plutôt qu'un simple badge de statut, pour répondre à
                        // "pourquoi on me propose ça" (réutilise le statut déjà calculé par
                        // WeaknessEngine, n'invente aucune nouvelle donnée).
                        const reason = w.status === 'faible'
                            ? `🔁 Tu as eu des difficultés récentes avec « ${titre} ».`
                            : `🎯 Il te reste à consolider « ${titre} ».`;
                        const where = notionWhere(w.id);
                        return `
                        <div class="hub-card" onclick="notionGo('${w.id}')">
                            <div class="hub-card-title">${reason}</div>
                            <div class="hub-card-desc">${where ? '📚 ' + rpEscapeHtml(where.m.titre) + ' · ' + rpEscapeHtml(where.e.titre) : '🎓 En cours particulier'}</div>
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


        // Vrai compte neuf : aucune notion jamais tentée, aucun historique de placement. Utilisé à
        // la fois par le nudge du dashboard et par l'onboarding — un seul et même critère.
        function isBrandNewUser() {
            return curriculumLoaded
                && Object.values(state.curriculum.notionProgress).every(p => !p.attempts)
                && !(state.placement.history || []).length;
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
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">📖</div><div class="qa-label">Vocabulaire</div></div>
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">📚</div><div class="qa-label">Cours</div></div>
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">🎭</div><div class="qa-label">Pratiquer</div></div>
                        <div class="quick-access-card" style="cursor:default;"><div class="qa-icon">🎮</div><div class="qa-label">Jouer</div></div>
                    </div>
                    <p style="font-size:0.78rem; color:var(--text-secondary); margin-top:var(--space-3);">📖 Les mots et la conjugaison · 📚 Des leçons en situation · 🎭 Parler et écrire en situation réelle · 🎮 Des jeux pour entretenir ton vocabulaire · 👤 en haut : ta progression et ton compte. L'accueil te propose toujours la prochaine chose à faire.</p>
                    <div class="section-title" style="margin-top:var(--space-5);">Par où commencer ?</div>
                    <button class="btn btn-green" style="margin-top:var(--space-2);" onclick="onboardingGoTo('debut')">🌱 Je débute : premier module</button>
                    <button class="btn btn-gray" style="margin-top:10px;" onclick="onboardingGoTo('bases')">💪 J'ai déjà des bases : on fait connaissance en conversation, et ce que je sais est validé</button>
                    <p style="font-size:0.78rem; margin-top:var(--space-4);">${currentUser ? '' : `<a href="#" onclick="onboardingGoTo('compte'); return false;">Créer un compte pour synchroniser ta progression (optionnel)</a>`}</p>
                </div>`;
        }

        function onboardingMarkSeen() {
            state.onboardingSeen = true;
            save();
        }

        function onboardingGoTo(dest) {
            onboardingMarkSeen();
            if (dest === 'compte') showCompte();
            else if (dest === 'debut') guideStart(MODRP_IDS[0]);
            else if (dest === 'bases') talkStartPoint(talkSettings().partner);
            else showHome();
        }

        function onboardingFinish() {
            onboardingMarkSeen();
            showHome();
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
                    ${curriculumLoaded ? `<div style="font-size:0.76rem; color:var(--text-secondary); margin-top:6px;">${masteredCount}/${totalReadyCount} notions maîtrisées · vocabulaire couvert ${vp.pct}%${usedWordsCount() ? ` · 🗣️ ${usedWordsCount()} mots dits à l'oral` : ''}</div>` : ''}
                </div>`;

            // ===== 2bis. Continuer : le prochain module en situation non réussi (le format
            // principal des cours) ; à défaut, la recommandation du programme ci-dessus.
            const isPassedMod = m => { const s = modRpState(m.id); return !!(s.finalResult && s.finalResult.passed); };
            const nextMod = MODRP_IDS.map(id => modRpData[id]).filter(Boolean).find(m => !isPassedMod(m));
            if (nextMod) {
                const doneEt = nextMod.etapes.filter(e => modRpEtapeDone(nextMod.id, e)).length;
                recoHtml = `
                    <div class="dash-card dash-continue-card dash-reco-card">
                        <div class="dash-continue-label">▶️ ${doneEt ? 'Continuer' : 'Commencer'}</div>
                        <div class="dash-reco-titre">${nextMod.niveau} · Cours</div>
                        <div class="dash-continue-title">${nextMod.icone || '🎭'} ${rpEscapeHtml(nextMod.titre)}</div>
                        <div class="dash-reco-reason">${doneEt}/${nextMod.etapes.length} étapes · ${rpEscapeHtml(nextMod.accroche || nextMod.objectif || '')}</div>
                        <div class="dash-reco-actions">
                            <button class="btn btn-green" onclick="guideStart('${nextMod.id}')">${doneEt ? 'Continuer' : 'Commencer'}</button>
                        </div>
                    </div>`;
            }


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
            // Les 5 intentions, une tuile chacune (mêmes entrées que la barre du bas, plus la
            // révision des erreurs) : on ouvre l'app et on sait quoi faire.
            const tilesHtml = `
                <div class="section-title" style="margin:var(--space-3) 0 var(--space-2);">Qu'est-ce que tu veux faire aujourd'hui ?</div>
                <div class="hub-grid">
                    <div class="hub-card" onclick="showVocab()"><span class="hub-card-icon">📖</span><div class="hub-card-title">Vocabulaire</div><div class="hub-card-desc">Verbes, noms, thèmes métier, conjugaison.</div></div>
                    <div class="hub-card" onclick="showApprendre()"><span class="hub-card-icon">📚</span><div class="hub-card-title">Cours</div><div class="hub-card-desc">Modules en situation, grammaire.</div></div>
                    <div class="hub-card" onclick="showPratiquer()"><span class="hub-card-icon">🎭</span><div class="hub-card-title">Pratiquer</div><div class="hub-card-desc">Jeux de rôle à l'oral, écrit.</div></div>
                    <div class="hub-card" onclick="showReviser()"><span class="hub-card-icon">🎮</span><div class="hub-card-title">Jouer</div><div class="hub-card-desc">Memory, contre-la-montre, mot mélangé, tri rapide.</div></div>
                    <div class="hub-card" style="grid-column:1 / -1;" onclick="studyReturnFn = showHome; startRevision()"><span class="hub-card-icon">🔁</span><div class="hub-card-title">Réviser mes erreurs</div><div class="hub-card-desc">${reviewCount ? reviewCount + ' mot' + (reviewCount > 1 ? 's' : '') + ' raté' + (reviewCount > 1 ? 's' : '') + ' à revoir.' : 'Rien à revoir pour l\'instant.'}</div></div>
                </div>`;
            block.innerHTML = `
                ${headerHtml}
                ${buddyHomeHtml()}
                ${placementNudgeHtml}
                ${recoHtml}
                ${tilesHtml}
                ${socialHtml}
                ${accountNudgeHtml}`;
        }

        // ===== Vue "Cours" (modules en situation, grammaire, notions à consolider) =====

        function showApprendre() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('apprendre-view').classList.add('active');
            setActiveNav('nav-apprendre');
            renderModRpEntries();
            if (curriculumLoaded) renderReviser();
        }

        // Modules en format jeu de rôle, affichés en tête d'Apprendre avec leur progression.
        function renderModRpEntries() {
            const el = document.getElementById('modrp-list');
            if (!el) return;
            const mods = MODRP_IDS.map(id => modRpData[id]).filter(Boolean);
            if (!mods.length) { el.innerHTML = ''; return; }
            // Regroupés par niveau, repliables ; le premier niveau non terminé est ouvert.
            const levels = [...new Set(mods.map(m => m.niveau))];
            const isPassed = m => { const s = modRpState(m.id); return !!(s.finalResult && s.finalResult.passed); };
            const openLevel = levels.find(l => mods.filter(m => m.niveau === l).some(m => !isPassed(m))) || levels[levels.length - 1];
            const hint = state.coursBasesHint ? `<div class="cours-hint">💪 Tu as des bases : pour chaque module que tu connais déjà, touche <b>🏆 Examen</b>. Réussi, le module et ses notions sont validés et tu passes au suivant. <button type="button" class="rp-coach-btn" onclick="state.coursBasesHint=false; save(); renderModRpEntries();">OK</button></div>` : '';
            el.innerHTML = talkPointCardHtml() + levels.map(level => {
                const list = mods.filter(m => m.niveau === level);
                const nPassed = list.filter(isPassed).length;
                return `<details class="modrp-level" ${level === openLevel ? 'open' : ''}>
                    <summary><span class="conj-niveau-badge">${level}</span> ${list.length} modules · ${nPassed} réussi${nPassed > 1 ? 's' : ''}</summary>
                    ${list.map((m, i) => {
                        const done = m.etapes.filter(e => modRpEtapeDone(m.id, e)).length;
                        const passed = isPassed(m);
                        return `<div class="modrp-entry${passed ? ' passed' : ''}" onclick="guideStart('${m.id}')">
                            <span class="modrp-entry-icon">${passed ? '🏆' : (m.icone || '🎭')}</span>
                            <span><b>${i + 1}. ${rpEscapeHtml(m.titre)}</b><br><small>${passed ? 'Réussi' : done + '/' + m.etapes.length + ' étapes'} · ${rpEscapeHtml(m.accroche || m.objectif)}</small></span>
                            ${passed ? '' : `<button type="button" class="modrp-exam-btn" title="Passer l'examen directement" onclick="event.stopPropagation(); guideExamDirect('${m.id}')">🏆 Examen</button>`}
                        </div>`;
                    }).join('')}
                </details>`;
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
            p.recent = (Array.isArray(p.recent) ? p.recent : []).concat(isCorrect ? 1 : 0).slice(-10);
            save();
            return p;
        }

        // Notions enseignées par une étape de module (champ "notions" des fichiers modules_rp).
        function modRpEtapeNotions(id, etapeId) {
            const m = modRpData[id];
            const e = m && m.etapes.find(x => x.id === etapeId);
            return (e && e.notions) || [];
        }
        function modRpModuleNotions(id) {
            const m = modRpData[id];
            return m ? [...new Set(m.etapes.flatMap(e => e.notions || []))] : [];
        }
        // Examen réussi : toutes les notions du module sont validées.
        function modRpValidateNotions(id) {
            modRpModuleNotions(id).forEach(n => {
                if (!curriculumNotions[n]) return;
                ntProgress(n).validated = true;
                recordNotionAttempt(n, true);
            });
        }
        // Examen raté : les notions des étapes dont les sujets manquaient sont signalées.
        function modRpFlagMissing(id, missingEtapes) {
            [...new Set(missingEtapes)].forEach(eid => modRpEtapeNotions(id, eid).forEach(n => { if (curriculumNotions[n]) recordNotionAttempt(n, false); }));
        }

        // Où travailler une notion : l'étape de module qui l'enseigne, sinon le cours particulier.
        function notionWhere(notionId) {
            for (const mid of MODRP_IDS) {
                const m = modRpData[mid];
                if (!m) continue;
                const idx = m.etapes.findIndex(e => (e.notions || []).includes(notionId));
                if (idx >= 0) return { mid, idx, m, e: m.etapes[idx] };
            }
            return null;
        }
        function notionTitle(notionId) {
            const n = curriculumNotions[notionId];
            if (n && n.content && n.content.titre) return n.content.titre;
            const s = String(notionId).replace(/_/g, ' ');
            return s.charAt(0).toUpperCase() + s.slice(1);
        }

        // Carte des compétences : toutes les notions prêtes, par niveau, colorées selon leur état.
        // Un clic mène là où la notion se travaille (notionGo).
        function competenceMapHtml() {
            if (!curriculumLoaded) return '<p class="report-meta">Chargement du programme...</p>';
            const cls = st => ({ maitrisee: 'ok', presque_maitrisee: 'ok', entrainee: 'mid', en_cours: 'mid', decouverte: 'mid', a_pratiquer: 'weak', faible: 'weak' }[st] || 'none');
            return curriculumLevels.map(l => {
                const ids = Object.keys(curriculumNotions).filter(id => curriculumNotions[id].level === l.id && curriculumNotions[id].status === 'pret');
                if (!ids.length) return '';
                const ok = ids.filter(id => computeNotionMastery(id) >= 4).length;
                return `<div class="carte-level">
                    <div class="carte-level-title"><span class="conj-niveau-badge">${l.id}</span> ${ok} / ${ids.length} acquises</div>
                    <div class="carte-chips">${ids.map(id => {
                        const st = getNotionStatus(id);
                        return `<button type="button" class="carte-chip ${cls(st)}" title="${rpEscapeHtml(getNotionStatusLabel(st))}" onclick="notionGo('${id}')">${rpEscapeHtml(notionTitle(id))}</button>`;
                    }).join('')}</div>
                </div>`;
            }).join('') + `<p class="report-meta">⬜ pas encore vue · 🟨 en cours · 🟥 à revoir · 🟩 acquise. Tout compte : modules, examens, cours particulier, conjugaison. Touche une notion pour la travailler.</p>`;
        }

        function notionGo(notionId) {
            const w = notionWhere(notionId);
            const n = curriculumNotions[notionId];
            const titre = notionTitle(notionId);
            if (w) {
                if (!confirm(`« ${titre} » se travaille dans le module « ${w.m.titre} », étape « ${w.e.titre} ». Y aller ?`)) return;
                modRpState(w.mid).guide = { e: w.idx, b: GUIDE_BEATS.indexOf('vocab') };
                save();
                guideStart(w.mid);
                return;
            }
            if (!n) return;
            if (!confirm(`« ${titre} » n'a pas encore de module : on la travaille en cours particulier. Y aller ?`)) return;
            const s = profSettings();
            s.level = n.level;
            s.notion = notionId;
            save();
            showProf();
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

        // ===== Blocs de mots (chunks) =====
        // Apprendre un mot dans ses combinaisons les plus fréquentes ("op tijd", "geen tijd", "de
        // laatste tijd") plutôt qu'isolé : le bloc a un sens, un contexte, et ressort tout fait
        // quand on parle. Données : data/chunks/chunks_nl.json, extraites des phrases Tatoeba par
        // tools/noyau/build_chunks.py — chaque bloc vient avec une vraie phrase d'exemple traduite.
        // Mémoire des réponses : state.chunkStats[bloc] = { ok, ko, streak, last } (synchronisée).
        let chunksData = null;      // { mot sans article: [{ c, n, ex, fr }] }
        let chunksLoading = null;
        function loadChunks() {
            if (chunksData) return Promise.resolve(chunksData);
            if (!chunksLoading) {
                chunksLoading = fetch('data/chunks/chunks_nl.json')
                    .then(r => r.ok ? r.json() : { chunks: {} })
                    .then(d => { chunksData = d.chunks || {}; return chunksData; })
                    .catch(() => { chunksData = {}; return chunksData; });
            }
            return chunksLoading;
        }

        // Clé de recherche d'un mot de l'app dans les blocs : première variante, sans article.
        function chunkKey(nl) {
            return String(nl || '').split('/')[0].replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/^(de|het|zich|een)\s+/, '');
        }
        function chunksForItem(item) {
            return (chunksData && chunksData[chunkKey(item.nl)]) || [];
        }

        const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

        // Liste de mots : panneau des blocs sous la ligne du mot.
        let wlOpenChunksId = null;
        function toggleWordChunks(id) {
            wlOpenChunksId = wlOpenChunksId === id ? null : id;
            renderWordList();
        }
        function wordChunksButtonHtml(item) {
            if (!chunksForItem(item).length) return '';
            return `<button type="button" class="star-btn" onclick="event.stopPropagation(); toggleWordChunks('${item.id}')" title="Voir ce mot dans ses blocs les plus fréquents" aria-label="Voir les blocs">🧩</button>`;
        }
        function wordChunksPanelHtml(item) {
            if (wlOpenChunksId !== item.id) return '';
            return `<div class="wl-chunks">${chunksForItem(item).map(k => `
                <div class="wl-chunk">
                    <div class="chunk-text">${escHtml(k.c)} ${speakBtnHtml(k.c)}</div>
                    <div class="chunk-ex">${escHtml(k.ex)} ${speakBtnHtml(k.ex)}</div>
                    <div class="chunk-fr">${escHtml(k.fr)}</div>
                </div>`).join('')}</div>`;
        }

        // ----- Entraînement par blocs : phrase à trou -----
        const CHUNK_SESSION_SIZE = 10;
        let chunkSession = null;

        function chunkBlank(k) {
            const idx = k.ex.toLowerCase().indexOf(k.c);
            if (idx < 0) return null;
            return { before: k.ex.slice(0, idx), after: k.ex.slice(idx + k.c.length), answer: k.ex.slice(idx, idx + k.c.length) };
        }

        async function showChunkTraining() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('chunk-view').classList.add('active');
            setActiveNav('nav-vocab');
            const box = document.getElementById('chunk-content');
            box.innerHTML = '<p style="color:#888;">Chargement des blocs...</p>';
            await loadChunks();
            const st = state.chunkStats || {};
            const all = [];
            fullDb.forEach(i => chunksForItem(i).forEach(k => { if (chunkBlank(k)) all.push(k.c); }));
            const distinct = [...new Set(all)];
            const seen = distinct.filter(c => st[c]).length;
            const due = distinct.filter(c => st[c] && st[c].streak === 0).length;
            const known = distinct.filter(c => st[c] && st[c].streak >= 2).length;
            chunkSession = null;
            box.innerHTML = `
                <div class="conj-card">
                    <p style="font-size:0.9rem; margin-top:0;">Plutôt qu'un mot isolé, tu apprends le <b>bloc</b> dans lequel il apparaît le plus souvent : <i>op tijd</i>, <i>geen tijd</i>, <i>de laatste tijd</i>… On te donne une phrase en français et la phrase néerlandaise avec un trou : à toi de retrouver le bloc.</p>
                    <div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:12px;">${distinct.length} blocs disponibles · ${seen} déjà vus · ${known} acquis${due ? ` · <b style="color:var(--wrong);">${due} à revoir</b>` : ''}</div>
                    <button class="btn btn-green" onclick="startChunkSession()">▶️ Lancer (${CHUNK_SESSION_SIZE} blocs)</button>
                </div>
                <p class="rp-real-hint" style="text-align:center;">Phrases d'exemple : Tatoeba (tatoeba.org), licence CC BY 2.0 FR.</p>`;
        }

        // Composition : d'abord les blocs ratés la dernière fois, puis un tirage pondéré par la
        // fréquence du mot (plus un mot est courant, plus ses blocs sortent tôt), en favorisant les
        // blocs jamais vus. Un seul bloc par mot dans une session.
        function pickChunkQuestions() {
            const st = state.chunkStats || {};
            const cands = [];
            fullDb.forEach(i => chunksForItem(i).forEach(k => {
                const blank = chunkBlank(k);
                if (blank) cands.push({ item: i, k, blank, stat: st[k.c] || null });
            }));
            const usedWords = new Set(), usedChunks = new Set(), picked = [];
            const take = c => {
                const w = chunkKey(c.item.nl);
                if (usedWords.has(w) || usedChunks.has(c.k.c)) return;
                usedWords.add(w); usedChunks.add(c.k.c); picked.push(c);
            };
            cands.filter(c => c.stat && c.stat.streak === 0).sort((a, b) => a.stat.last - b.stat.last)
                .forEach(c => { if (picked.length < CHUNK_SESSION_SIZE / 2) take(c); });
            const rest = cands.map(c => {
                const boost = !c.stat ? 1.5 : (c.stat.streak >= 2 ? 0.2 : 1);
                return { c, key: Math.pow(Math.random(), 1 / (Math.pow(10, (c.item.freq || 3) - 3) * boost)) };
            }).sort((a, b) => b.key - a.key);
            for (const r of rest) { if (picked.length >= CHUNK_SESSION_SIZE) break; take(r.c); }
            for (let i = picked.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [picked[i], picked[j]] = [picked[j], picked[i]]; }
            return picked;
        }

        function startChunkSession() {
            const questions = pickChunkQuestions();
            if (!questions.length) return;
            chunkSession = { questions, index: 0, score: 0, missed: [], answered: false };
            renderChunkQuestion();
        }

        function renderChunkQuestion() {
            const s = chunkSession, box = document.getElementById('chunk-content');
            if (!s || !box) return;
            if (s.index >= s.questions.length) { renderChunkSummary(); return; }
            const q = s.questions[s.index];
            const nWords = q.k.c.split(' ').length;
            s.answered = false;
            box.innerHTML = `
                <div class="conj-card">
                    <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:8px;">Bloc ${s.index + 1}/${s.questions.length} · Score : ${s.score}${q.stat && q.stat.streak === 0 ? ' · <span style="color:var(--wrong);">à revoir</span>' : ''}</div>
                    <div class="chunk-q-fr">${escHtml(q.k.fr)}</div>
                    <div class="chunk-q-nl">${escHtml(q.blank.before)}<span class="chunk-gap">${'_ '.repeat(nWords).trim()}</span>${escHtml(q.blank.after)}</div>
                    <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:10px;">${nWords} mots · autour de <b>${escHtml(chunkKey(q.item.nl))}</b> (${escHtml(q.item.fr)})</div>
                    <input type="text" id="chunk-input" style="width:100%; margin-bottom:8px;" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Le bloc qui manque..." onkeypress="if(event.key==='Enter') chunkEnter()">
                    <div id="chunk-feedback" style="min-height:1.4em; margin-bottom:8px;"></div>
                    <div id="chunk-actions">
                        <button class="btn btn-green" onclick="chunkCheck(false)">Vérifier</button>
                        <button class="btn btn-gray" style="margin-top:8px;" onclick="chunkCheck(true)">Je ne sais pas</button>
                    </div>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="showChunkTraining()">Arrêter</button>
                </div>`;
            const input = document.getElementById('chunk-input');
            if (input) input.focus();
        }

        function chunkEnter() {
            if (!chunkSession) return;
            if (chunkSession.answered) chunkNext(); else chunkCheck(false);
        }

        function chunkCheck(giveUp) {
            const s = chunkSession;
            if (!s || s.answered) return;
            const q = s.questions[s.index];
            const result = giveUp ? { status: 'wrong' } : evaluateAnswer(document.getElementById('chunk-input').value, q.k.c);
            const ok = result.status !== 'wrong';
            s.answered = true;
            if (ok) s.score++; else s.missed.push(q);
            if (!state.chunkStats) state.chunkStats = {};
            const stat = state.chunkStats[q.k.c] || { ok: 0, ko: 0, streak: 0, last: 0 };
            if (ok) { stat.ok++; stat.streak++; } else { stat.ko++; stat.streak = 0; }
            stat.last = Date.now();
            state.chunkStats[q.k.c] = stat;
            save();
            const fb = document.getElementById('chunk-feedback');
            fb.innerHTML = `<div style="color:${ok ? 'var(--success)' : 'var(--wrong)'}; font-weight:700;">${ok ? (result.status === 'close' ? '🟡 Presque, on valide !' : '✅ Bravo !') : '❌ Le bloc était :'} ${escHtml(q.k.c)} ${speakBtnHtml(q.k.c)}</div>
                <div class="chunk-ex">${escHtml(q.blank.before)}<b>${escHtml(q.blank.answer)}</b>${escHtml(q.blank.after)} ${speakBtnHtml(q.k.ex)}</div>`;
            document.getElementById('chunk-actions').innerHTML = `<button class="btn btn-green" onclick="chunkNext()">${s.index + 1 >= s.questions.length ? 'Voir le résultat' : 'Suivant →'}</button>`;
        }

        function chunkNext() {
            if (!chunkSession) return;
            chunkSession.index++;
            renderChunkQuestion();
        }

        function renderChunkSummary() {
            const s = chunkSession;
            document.getElementById('chunk-content').innerHTML = `
                <div class="conj-card">
                    <div class="conj-verb-title">Résultat : ${s.score}/${s.questions.length}</div>
                    ${s.missed.length ? `<div class="section-title" style="margin-top:var(--space-4);">📌 À retenir (reviendront en priorité)</div>
                        ${s.missed.map(q => `<div class="wl-chunk">
                            <div class="chunk-text">${escHtml(q.k.c)} ${speakBtnHtml(q.k.c)}</div>
                            <div class="chunk-ex">${escHtml(q.k.ex)}</div>
                            <div class="chunk-fr">${escHtml(q.k.fr)}</div>
                        </div>`).join('')}` : `<p style="color:var(--success); margin-top:var(--space-4);">Aucune erreur, bien joué ! 🎉</p>`}
                    <button class="btn btn-green" style="margin-top:14px;" onclick="startChunkSession()">🔁 Nouvelle session</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="showApprendre()">Retour</button>
                </div>`;
        }

        // ===== Vue Conjugaison =====
        let conjugaisonSelectedVerb = null;
        let conjFilterCategory = 'toutes';

        function showConjugaison() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('conjugaison-view').classList.add('active');
            setActiveNav('nav-vocab');
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
            const nid = conjTenseNotion(infinitief, tense);
            if (nid && curriculumNotions[nid]) recordNotionAttempt(nid, isCorrect);
        }

        // Notion du curriculum entraînée par une forme conjuguée.
        function conjTenseNotion(infinitief, tense) {
            if (tense === 'present') return infinitief === 'zijn' ? 'zijn' : (infinitief === 'hebben' ? 'hebben' : 'present_regulier');
            if (tense === 'perfectum') return 'perfectum_intro';
            if (tense === 'futur') return 'zullen_futur';
            if (tense === 'imperfectum') {
                const v = conjugationLoaded && conjugationData.find(x => x.infinitief === infinitief);
                return v && getVerbCategories(v).includes('irregulier') ? 'imperfectum_irreguliers' : 'imperfectum';
            }
            return null;
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
            zou:'zouden', zweeg:'zwegen', zwom:'zwommen',
            // Verbes forts ajoutés avec le noyau de vocabulaire courant (octobre 2026)
            stal:'stalen', klonk:'klonken', verdween:'verdwenen', ontsloeg:'ontsloegen',
            verstond:'verstonden', speet:'speten', verborg:'verborgen', verbood:'verboden',
            schoot:'schoten', besprak:'bespraken', verscheen:'verschenen', beviel:'bevielen',
            onderzocht:'onderzochten', vergaf:'vergaven', stonk:'stonken', bedacht:'bedachten',
            versloeg:'versloegen', loog:'logen', verbleef:'verbleven', smolt:'smolten',
            verdacht:'verdachten', begroef:'begroeven', schoor:'schoren', gedroeg:'gedroegen',
            overkwam:'overkwamen', zonk:'zonken', rook:'roken', woog:'wogen', verliep:'verliepen',
            genas:'genazen', beval:'bevalen', verdronk:'verdronken', voorzag:'voorzagen',
            verkoos:'verkozen', onderbrak:'onderbraken', verried:'verrieden', zwoer:'zwoeren',
            overdreef:'overdreven', beklom:'beklommen', ontwierp:'ontwierpen', overwoog:'overwogen',
            bedroog:'bedrogen', streek:'streken', onderging:'ondergingen', floot:'floten',
            groef:'groeven'
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
            conjAudioStop();
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
                    ${v.exempleNl ? `<div class="conj-sentence">${v.exempleNl} ${speakBtnHtml(v.exempleNl)}<br>${v.exempleFr}</div>` : ''}
                    <button class="btn btn-green" style="margin-top:12px;" onclick="conjExerciseStart('${esc(v.infinitief)}')">🎯 S'entraîner sur ce verbe</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="conjAudioOpen()">🎧 Écouter et répéter</button>
                    <button class="btn btn-gray" style="margin-top:8px;" onclick="conjHandsfreeVerb('${esc(v.infinitief)}')">🗣️ Mains libres : répondre ou écouter</button>
                    <button type="button" class="report-link" data-report="${encodeURIComponent(JSON.stringify({ kind: 'conjugaison', ref: v.infinitief, nl: v.infinitief, fr: v.fr, context: 'fiche du verbe (précise la forme dans le message)' }))}" onclick="reportFromBtn(this)">⚠️ Signaler une erreur sur ce verbe</button>
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

        // Les 6 personnes sont demandées (jullie = vous, zij = ils) : la fiche n'en affiche que 4,
        // mais le mode audio "écouter et répéter" récite le pluriel complet. Les entrées en cache
        // d'avant cet ajout (4 personnes) sont redemandées quand `full` est exigé.
        let conjFrStatic = {}; // data/curriculum/conjugation_fr.json, chargé au démarrage

        // Formes françaises déjà disponibles sans appel réseau : fichier généré, sinon cache Gemini.
        function conjFrFormsFor(v) {
            return conjFrStatic[v.infinitief] || conjFrCacheGet()[v.infinitief] || null;
        }

        async function conjFetchFrenchForms(v, full) {
            if (conjFrStatic[v.infinitief]) return conjFrStatic[v.infinitief];
            const cached = conjFrCacheGet()[v.infinitief];
            if (cached && (!full || CONJ_TENSES.every(t => cached[t] && cached[t].jullie && cached[t].zij))) return cached;
            if (!GeminiService.isAvailable()) throw new Error('Gemini non configuré');
            const rows = buildConjugationGrid(v);
            const forms = CONJ_TENSES.map(t => t + ' : ' + rows.map(r => r.pronomKey + ' = ' + r[t]).join(' ; ')).join('\n');
            const raw = await GeminiService.generate(
                'Traduis en français chaque forme conjuguée du verbe néerlandais "' + v.infinitief + '" (sens : ' + v.fr + ').\n\n' + forms + '\n\n' +
                '(la forme "wij" vaut aussi pour jullie et zij au pluriel). Correspondances : ik = je, jij = tu, hij = il, wij = nous, jullie = vous, zij = ils. Temps français à utiliser : present → présent, imperfectum → imparfait, perfectum → passé composé, futur → futur simple. ' +
                'Garde un seul sens du verbe, le même partout, et inclus le pronom (ex : "je suis", "nous avons été", "ils ont été").\n' +
                'Réponds UNIQUEMENT avec un objet JSON, sans texte autour : {"present": {"ik": "...", "jij": "...", "hij": "...", "wij": "...", "jullie": "...", "zij": "..."}, "imperfectum": {...}, "perfectum": {...}, "futur": {...}}'
            );
            const m = raw.match(/\{[\s\S]*\}/);
            const data = JSON.parse(m ? m[0] : raw);
            if (!CONJ_TENSES.every(t => data[t] && typeof data[t] === 'object')) throw new Error('réponse incomplète');
            try {
                const cache = conjFrCacheGet();
                cache[v.infinitief] = data;
                localStorage.setItem(CONJ_FR_CACHE_KEY, JSON.stringify(cache));
            } catch (e) { /* stockage plein : la traduction reste utilisable, simplement pas mémorisée */ }
            return data;
        }

        async function conjLoadFrenchForms(v) {
            const setNote = msg => { const n = document.getElementById('conj-fr-note'); if (n) n.innerText = msg; };
            let data = conjFrFormsFor(v);
            if (!data) {
                if (!GeminiService.isAvailable()) {
                    setNote('Traduction de chaque forme : nécessite Gemini (Profil → 🤖 Intelligence IA).');
                    return;
                }
                setNote('Traduction des formes en cours...');
                try {
                    data = await conjFetchFrenchForms(v, false);
                } catch (e) {
                    setNote('Traduction des formes impossible pour le moment (' + e.message + ').');
                    return;
                }
            }
            if (conjugaisonSelectedVerb !== v) return; // on a changé de verbe pendant l'appel
            CONJ_TENSES.forEach(t => ['ik', 'jij', 'hij', 'wij'].forEach(p => {
                const el = document.getElementById('conj-fr-' + t + '-' + p);
                if (el && data[t] && data[t][p]) el.innerText = String(data[t][p]);
            }));
            setNote('Traductions françaises générées automatiquement : une erreur ? Signale-la avec ⚠️ ci-dessous.');
        }

        // ===== Question en français dans les exercices de conjugaison =====
        // « tu as appris → jij hebt geleerd » au lieu de « jij — leren — au perfectum ». Le pronom
        // fait partie de la réponse attendue, mais une réponse sans pronom est aussi acceptée.
        // Pour les lignes regroupées de la grille (wij/jullie/zij, et ik/jij/hij au prétérit), la
        // personne est tirée au sort pour varier les questions.
        function conjExerciseRestart() {
            if (conjExerciseState) conjExerciseStart(conjExerciseState.verb.infinitief);
        }

        function conjExerciseRelang() {
            const st = conjExerciseState;
            if (!st) return;
            st.pool.forEach(q => { q.frq = conjFrQuestion(st.verb, q.tense, q.pronomKey, q.answer); });
            conjExerciseRenderQuestion();
        }

        function conjQuestionLang() {
            return (state.settings && state.settings.conjQuestionLang === 'nl') ? 'nl' : 'fr';
        }
        function conjSetQuestionLang(lang, rerender) {
            state.settings.conjQuestionLang = lang;
            save();
            if (rerender) rerender();
        }
        function conjQuestionLangChipsHtml(rerenderName) {
            const lang = conjQuestionLang();
            const chip = (active, val, label) => `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="conjSetQuestionLang('${val}', ${rerenderName})">${label}</button>`;
            return chip(lang === 'fr', 'fr', '🇫🇷 « tu as appris »') + chip(lang === 'nl', 'nl', '🇳🇱 verbe + temps');
        }

        function conjFrQuestion(v, tense, pronomKey, answer, force) {
            if (!force && conjQuestionLang() !== 'fr') return null;
            const forms = conjFrFormsFor(v);
            let person = pronomKey;
            if (pronomKey === 'wij') person = ['wij', 'jullie', 'zij'][Math.floor(Math.random() * 3)];
            else if (tense === 'imperfectum' && pronomKey === 'hij' && answer === v.preteritum) person = ['ik', 'jij', 'hij'][Math.floor(Math.random() * 3)];
            const fr = forms && forms[tense] && forms[tense][person];
            if (!fr) return null;
            return { fr: String(fr), fullAnswer: person + ' ' + answer };
        }

        // Accepte la réponse avec ou sans pronom ; renvoie le meilleur des deux jugements.
        function conjEvaluate(input, q) {
            const withPronoun = q.frq ? evaluateAnswer(input, q.frq.fullAnswer) : null;
            const bare = evaluateAnswer(input, q.answer);
            if (withPronoun && withPronoun.status === 'correct') return withPronoun;
            if (bare.status === 'correct') return bare;
            if (withPronoun && withPronoun.status === 'close') return withPronoun;
            return bare;
        }

        // ===== Écouter et répéter (conjugaison à l'oral) =====
        // L'app récite un verbe forme par forme, singulier puis pluriel (ik, jij, hij, wij, jullie,
        // zij), en français et en néerlandais, avec un blanc pour répéter. Trois modes : écoute
        // seule, répète après moi (blanc sans vérification), répétition vérifiée (le micro écoute
        // et compare ; le résultat compte dans state.conjStats comme l'entraînement écrit).
        // Ordre "fr" : le français d'abord, un blanc pour essayer de dire la forme, puis la réponse.
        const CONJ_AUDIO_PERSONS = [
            { key: 'ik', stat: 'ik', plural: false },
            { key: 'jij', stat: 'jij', plural: false },
            { key: 'hij', stat: 'hij', plural: false },
            { key: 'wij', stat: 'wij', plural: true },
            { key: 'jullie', stat: 'wij', plural: true },
            { key: 'zij', stat: 'wij', plural: true }
        ];
        const CONJ_AUDIO_MODES = [
            { key: 'listen', label: '👂 Écoute seule' },
            { key: 'repeat', label: '🗣️ Répète après moi' },
            { key: 'check', label: '🎤 Répétition vérifiée' }
        ];
        let conjAudioRun = null; // { stop, paused, skip, wakeLock, viewId } pendant une lecture
        // Vitesse de la voix et blanc laissé pour répéter, communs aux verbes et aux mots seuls.
        // Blanc « aucun » + vitesse rapide = simple écoute en continu, sans temps mort.
        const AUDIO_RATES = [
            { v: 0.75, label: '🐢 Lent' }, { v: 0.95, label: 'Normal' },
            { v: 1.2, label: '🐇 Rapide' }, { v: 1.5, label: '⚡ Très rapide' }
        ];
        const AUDIO_PAUSES = [0, 2, 4, 6];
        function audioSpeedPauseHtml(s, setter) {
            const chip = (active, onclick, label) => `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
            return `
                <div class="conj-audio-label">Vitesse de la voix</div>
                <div class="conj-audio-chips">${AUDIO_RATES.map(r => chip(s.rate === r.v, `${setter}('rate',${r.v})`, r.label)).join('')}</div>
                <div class="conj-audio-label">Blanc pour répéter</div>
                <div class="conj-audio-chips">${AUDIO_PAUSES.map(p => chip(s.pause === p, `${setter}('pause',${p})`, p ? p + ' s' : 'Aucun')).join('')}</div>`;
        }

        function conjAudioSettings() {
            if (!state.settings) state.settings = {};
            const s = state.settings.conjAudio || {};
            const tenses = Array.isArray(s.tenses) ? s.tenses.filter(t => CONJ_TENSES.includes(t)) : [];
            state.settings.conjAudio = {
                tenses: tenses.length ? tenses : ['present'],
                mode: CONJ_AUDIO_MODES.some(m => m.key === s.mode) ? s.mode : 'repeat',
                order: s.order === 'nl' ? 'nl' : 'fr',
                rate: AUDIO_RATES.some(r => r.v === s.rate) ? s.rate : 0.95,
                pause: AUDIO_PAUSES.includes(s.pause) ? s.pause : 4,
                count: [1, 5, 10].includes(s.count) ? s.count : 1
            };
            return state.settings.conjAudio;
        }

        function conjAudioSet(key, value) {
            const s = conjAudioSettings();
            if (key === 'tense') {
                const i = s.tenses.indexOf(value);
                if (i >= 0 && s.tenses.length > 1) s.tenses.splice(i, 1);
                else if (i < 0) s.tenses = CONJ_TENSES.filter(t => t === value || s.tenses.includes(t));
            } else {
                s[key] = value;
            }
            save();
            conjAudioRenderSetup();
        }

        function conjAudioOpen() {
            if (!conjugaisonSelectedVerb) return;
            conjAudioStop();
            conjExerciseState = null;
            conjAudioRenderSetup();
            document.getElementById('conj-exercise-box').scrollIntoView({ block: 'start' });
        }

        function conjAudioRenderSetup() {
            const box = document.getElementById('conj-exercise-box');
            const v = conjugaisonSelectedVerb;
            if (!box || !v) return;
            const s = conjAudioSettings();
            const chip = (active, onclick, label) => `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
            const pos = conjCurrentList.indexOf(v.infinitief);
            const remaining = pos >= 0 ? conjCurrentList.length - pos : 1;
            box.innerHTML = `
                <div class="conj-card conj-audio">
                    <div class="conj-audio-title">🎧 Écouter et répéter — <b>${rpEscapeHtml(v.infinitief)}</b></div>
                    <div class="conj-audio-label">Temps</div>
                    <div class="conj-audio-chips">${CONJ_TENSES.map(t => chip(s.tenses.includes(t), `conjAudioSet('tense','${t}')`, CONJ_TENSE_NAMES[t])).join('')}</div>
                    <div class="conj-audio-label">Mode</div>
                    <div class="conj-audio-chips">${CONJ_AUDIO_MODES.map(m => chip(s.mode === m.key, `conjAudioSet('mode','${m.key}')`, m.label)).join('')}</div>
                    <div class="conj-audio-label">Ordre</div>
                    <div class="conj-audio-chips">
                        ${chip(s.order === 'fr', "conjAudioSet('order','fr')", '🇫🇷 Français d\'abord (je cherche)')}
                        ${chip(s.order === 'nl', "conjAudioSet('order','nl')", '🇳🇱 Néerlandais d\'abord (je découvre)')}
                    </div>
                    ${audioSpeedPauseHtml(s, 'conjAudioSet')}
                    <div class="conj-audio-label">Verbes</div>
                    <div class="conj-audio-chips">
                        ${chip(s.count === 1, 'conjAudioSet(\'count\',1)', 'Ce verbe')}
                        ${remaining > 1 ? chip(s.count === 5, 'conjAudioSet(\'count\',5)', '+ les suivants (5)') : ''}
                        ${remaining > 5 ? chip(s.count === 10, 'conjAudioSet(\'count\',10)', '+ les suivants (10)') : ''}
                    </div>
                    ${s.mode === 'check' ? '<p class="conj-audio-hint">Après chaque forme, le micro t\'écoute quelques secondes : redis la forme avec le pronom (ex. « wij werken »).</p>' : ''}
                    <p class="conj-audio-hint">Garde l'écran allumé : sur téléphone, la lecture s'arrête quand il se verrouille.</p>
                    <button class="btn btn-green" style="margin-top:8px;" onclick="conjAudioStart()">▶️ Lancer</button>
                </div>`;
        }

        // Voix d'une langue donnée ; la promesse se résout à la fin de la phrase (avec un délai
        // maximum : certains navigateurs mobiles n'envoient pas toujours l'évènement de fin).
        // opt.speaker : 0 ou 1 = personnage d'une scène (2e voix néerlandaise si l'appareil en a une,
        // sinon même voix plus grave), opt.pitch pour forcer la hauteur.
        function conjAudioSpeak(text, lang, rate, opt) {
            return new Promise(resolve => {
                if (!('speechSynthesis' in window) || !text) return resolve();
                const u = new SpeechSynthesisUtterance(speechBlanks(stripMarkdown(text)));
                u.lang = lang === 'fr' ? 'fr-FR' : 'nl-NL';
                const voices = window.speechSynthesis.getVoices();
                const nlVoices = voices.filter(x => x.lang.toLowerCase().startsWith('nl'));
                let voice = lang === 'fr'
                    ? voices.find(x => x.lang.toLowerCase().startsWith('fr'))
                    : (rpDutchVoice || nlVoices[0]);
                if (lang !== 'fr' && opt && opt.speaker === 1) {
                    const other = nlVoices.find(x => x !== voice);
                    if (other) voice = other; else u.pitch = 0.75;
                }
                if (opt && opt.pitch) u.pitch = opt.pitch;
                if (voice) u.voice = voice;
                u.rate = rate;
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                u.onend = finish;
                u.onerror = finish;
                setTimeout(finish, 2500 + text.length * 180 / rate);
                window.speechSynthesis.speak(u);
            });
        }

        // Attente interrompue par Arrêter / Passer, et suspendue tant que la lecture est en pause.
        async function conjAudioWait(ms) {
            const run = conjAudioRun;
            let left = ms;
            while (run && !run.stop && !run.skip && (left > 0 || run.paused)) {
                await new Promise(r => setTimeout(r, 100));
                if (!run.paused) left -= 100;
                // Changement d'écran : on coupe la lecture plutôt que de parler dans le vide.
                if (!document.getElementById(run.viewId).classList.contains('active')) conjAudioStop();
            }
        }

        // Lecture qui respecte Pause / Passer / Arrêter : attend la reprise avant de parler.
        async function conjAudioSay(text, lang, rate, opt) {
            const run = conjAudioRun;
            if (!run) return;
            await conjAudioWait(0);
            if (run.stop || run.skip) return;
            if (!document.getElementById(run.viewId).classList.contains('active')) { conjAudioStop(); return; }
            await conjAudioSpeak(text, lang, rate, opt);
        }

        // ===== Lecture bilingue =====
        // Les explications en français contiennent souvent du néerlandais (« Ik ben 31 jaar »,
        // « zijn : ik ben, jij bent »…). Lues d'un bloc par la voix française, ces phrases étaient
        // prononcées à la française. On découpe donc le texte en morceaux FR / NL, mot à mot :
        // un mot connu du vocabulaire néerlandais de l'app (mots, formes conjuguées, dialogues
        // des modules) est NL ; un mot avec accent français ou un mot-outil français est FR ; les
        // mots ambigus (de, en, je…) ou inconnus prennent la langue de leurs voisins, avec une
        // préférence pour le NL entre guillemets « ». Chaque morceau est lu par la bonne voix.
        const BILINGUAL_FR = new Set(('le la les l un une des du de d et est sont à au aux en pour avec sans par sur sous dans entre vers chez qui que qu quoi dont où ou si mais donc car ni ne n pas plus moins très trop aussi même comme quand lorsque puis alors ensuite toujours jamais souvent parfois encore déjà ce cet cette ces c se s son sa ses mon ma mes ton ta tes notre nos votre vos leur leurs il ils elle elles on nous vous tu te t je j me m moi toi lui eux y a ai as avons avez ont été être avoir fait faire dit dire va aller vont peut peux pouvoir veut veux vouloir doit dois devoir prend prendre met mettre passe passer reste rester sert servir sert ici là voici voilà oui non bien mal tout tous toute toutes autre autres chaque quelque quelques plusieurs aucun aucune rien personne chose fois verbe verbes nom noms mot mots phrase phrases forme formes question questions réponse fin début place ordre sujet temps présent passé futur infinitif pluriel singulier article masculin féminin neutre exemple exemples règle sens comme surtout seulement souvent pareil même mêmes devant derrière après avant pendant depuis jusqu sinon') .split(' '));
        // Mots-outils français qui ne sont jamais lus en néerlandais, même s'ils existent aussi
        // en néerlandais (« les » = la leçon, « on », « pas »…).
        const BILINGUAL_FR_STRONG = new Set('le la les un une des du et est à au aux pour avec sans par sur dans qui que ce cette ces se son sa ses mon ma mes ton ta tes il ils elle elles on nous vous tu y ou où si mais donc car ne pas plus très aussi comme quand chose milieu'.split(' '));
        const BILINGUAL_ACCENT = /[éèêàâçîïôûùœ]/i;
        let bilingualNlSet = null;

        function bilingualWords(s) { return String(s || '').toLowerCase().match(/[a-zà-ÿ]+/g) || []; }

        function bilingualNl() {
            if (bilingualNlSet && bilingualNlSet.size > 500) return bilingualNlSet;
            const set = new Set();
            const add = s => bilingualWords(s).forEach(w => set.add(w));
            (fullDb || []).forEach(i => { if (i && i.nl) add(i.nl); });
            if (conjugationLoaded) conjugationData.forEach(v => {
                add(v.infinitief); add(v.preteritum); add(v.participePasse); add(v.exempleNl);
                Object.values(v.present || {}).forEach(add);
            });
            Object.values(typeof modRpData !== 'undefined' ? modRpData : {}).forEach(m => (m.etapes || []).forEach(e => {
                (e.dialogue || []).forEach(l => add(l.nl));
                ((e.regle || {}).exemples || []).forEach(x => add(x.nl));
                ((e.vocab || {}).mots || []).concat((e.vocab || {}).phrases || []).forEach(x => add(x.nl));
            }));
            ['ik', 'jij', 'je', 'hij', 'zij', 'ze', 'wij', 'we', 'jullie', 'u', 'het', 'een', 'niet', 'geen', 'is', 'ben', 'bent', 'zijn', 'heb', 'hebt', 'heeft', 'hebben', 'van', 'op', 'met', 'naar', 'als', 'dat', 'die', 'dit', 'wat', 'hoe', 'waar', 'om', 'te', 'er', 'maar', 'want', 'omdat', 'graag', 'ook', 'nog', 'al', 'zal', 'ga', 'gaat', 'mag', 'wil', 'kan', 'moet'].forEach(w => set.add(w));
            bilingualNlSet = set;
            return set;
        }

        // Découpe un texte « en français » en [{ lang, text }].
        function bilingualSegments(text) {
            text = stripMarkdown(String(text || ''));
            const NL = bilingualNl();
            const parts = text.split(/([A-Za-zÀ-ÿ]+(?:['’][A-Za-zÀ-ÿ]+)*)/);
            const words = [];
            let quote = 0;
            for (let i = 0; i < parts.length; i++) {
                if (i % 2 === 0) {
                    for (const ch of parts[i]) { if (ch === '«' || ch === '“') quote++; if ((ch === '»' || ch === '”') && quote > 0) quote--; }
                    continue;
                }
                const raw = parts[i], w = raw.toLowerCase();
                const frElision = /^(l|d|j|c|m|n|s|t|qu)['’]/i.test(raw);
                const inNl = NL.has(w), inFr = BILINGUAL_FR.has(w);
                let cls;
                if (frElision || BILINGUAL_FR_STRONG.has(w)) cls = 'fr';
                else if (inNl && !inFr) cls = 'nl';
                else if (inFr && !inNl) cls = 'fr';
                else if (BILINGUAL_ACCENT.test(w)) cls = 'fr';
                else cls = inNl ? 'amb' : 'unk';
                if (w.length === 1 && !['u', 'a', 'y', 'à'].includes(w)) cls = 'unk';
                words.push({ i, cls, quote: quote > 0, sep: i > 0 ? parts[i - 1] : '' });
            }
            // 1) Mots ambigus (de, en, je, dit…) : français s'ils suivent directement un mot
            // français (« On dit », « pas de »), sinon la langue du mot qui suit (l'article
            // prend celle de son nom) ; un mot inconnu voisin compte alors comme français.
            // Entre guillemets « », néerlandais sauf si tout autour est français.
            const near = (k, dir, val) => { for (let x = k + dir; x >= 0 && x < words.length; x += dir) { const v = val(words[x]); if (v) return v; } return null; };
            const firm = x => x.cls === 'fr' || x.cls === 'nl' ? x.cls : null;
            words.forEach((wd, k) => {
                if (wd.cls !== 'amb') return;
                const prevFr = k > 0 && words[k - 1].cls === 'fr' && !/[:(«=→\/·;]/.test(wd.sep);
                const side = x => firm(x) || (x.cls === 'unk' ? 'fr' : null);
                const l = near(k, -1, side), r = near(k, 1, side);
                if (wd.quote) wd.res = (l === 'fr' && r === 'fr') || prevFr ? 'fr' : 'nl';
                else wd.res = prevFr ? 'fr' : (r || l || 'fr');
            });
            // 2) Mots inconnus : néerlandais seulement entourés de néerlandais.
            const settled = x => firm(x) || x.res || null;
            words.forEach((wd, k) => {
                if (wd.cls !== 'unk') return;
                const l = near(k, -1, settled), r = near(k, 1, settled);
                if (wd.quote) wd.res = (l === 'fr' && r === 'fr') ? 'fr' : 'nl';
                else wd.res = ((l === 'nl' || l === null) && (r === 'nl' || r === null) && (l || r)) ? 'nl' : 'fr';
            });
            const langOf = new Map(words.map(wd => [wd.i, wd.res || wd.cls]));
            // Regroupement : la ponctuation suit le mot qui la précède.
            const segs = [];
            let cur = null;
            for (let i = 0; i < parts.length; i++) {
                const piece = parts[i];
                if (!piece) continue;
                const lang = i % 2 === 1 ? langOf.get(i) : (cur ? cur.lang : 'fr');
                if (cur && cur.lang === lang) cur.text += piece;
                else { cur = { lang, text: piece }; segs.push(cur); }
            }
            // Les chiffres entre deux morceaux néerlandais se lisent en néerlandais (déjà le cas
            // par regroupement) ; on retire les morceaux vides ou faits seulement de ponctuation.
            // Symboles lus à voix haute de travers (« égal », « is gelijk aan ») : retirés.
            return segs.map(s => ({ lang: s.lang, text: s.text.replace(/[«»“”=→·()…]/g, ' ').replace(/\s*\/\s*/g, ', ').replace(/\s+/g, ' ').trim() }))
                .filter(s => /[A-Za-zÀ-ÿ0-9]/.test(s.text));
        }

        // Lecture bilingue qui respecte Pause / Passer / Arrêter (moteur audio commun).
        async function conjAudioSayMixed(text, rate, nlRate) {
            for (const s of bilingualSegments(text)) {
                const run = conjAudioRun;
                if (!run || run.stop || run.skip) return;
                await conjAudioSay(s.text, s.lang, s.lang === 'fr' ? (rate || 1) : (nlRate || 0.9));
            }
        }

        // Lecture bilingue simple (sans moteur de pause), pour le cours particulier.
        async function conjAudioSpeakMixed(text, rate, nlRate, keepGoing) {
            for (const s of bilingualSegments(text)) {
                if (keepGoing && !keepGoing()) return;
                await conjAudioSpeak(s.text, s.lang, s.lang === 'fr' ? (rate || 1) : (nlRate || 0.9));
            }
        }

        // Une écoute courte, sur une instance de reconnaissance dédiée (non continue : elle s'arrête
        // d'elle-même après une phrase), distincte de celle du jeu de rôle.
        function conjAudioListen(lang) {
            return new Promise(resolve => {
                if (!window.SpeechRecognition) return resolve(null);
                if (rpIsRecording && rpRecognition) rpRecognition.stop();
                const rec = new window.SpeechRecognition();
                rec.lang = lang || 'nl-NL';
                rec.continuous = false;
                rec.interimResults = false;
                rec.maxAlternatives = 3;
                const heard = [];
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(heard); } };
                rec.onresult = e => {
                    for (let i = 0; i < e.results.length; i++)
                        for (let j = 0; j < e.results[i].length; j++) heard.push(e.results[i][j].transcript);
                };
                rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') heard.denied = true; finish(); };
                rec.onend = finish;
                setTimeout(() => { try { rec.abort(); } catch (e) {} finish(); }, 7000);
                try { rec.start(); } catch (e) { finish(); }
            });
        }

        // Correct si tous les mots de la forme (hors pronom) sont entendus, dans n'importe quel ordre.
        function conjAudioMatches(heard, form) {
            const clean = s => normalize(s).replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
            const target = clean(form);
            return heard.some(h => { const words = clean(h); return target.every(w => words.includes(w)); });
        }

        function conjAudioShow(html) {
            const el = document.getElementById('conj-audio-now');
            if (el) el.innerHTML = html;
        }

        async function conjAudioStart() {
            const first = conjugaisonSelectedVerb;
            if (!first) return;
            if (!('speechSynthesis' in window)) { alert('Ton navigateur ne sait pas lire à voix haute.'); return; }
            const s = conjAudioSettings();
            if (s.mode === 'check' && !window.SpeechRecognition) { alert("Ton navigateur ne supporte pas la reconnaissance vocale : choisis « Répète après moi », ou utilise Google Chrome."); return; }
            conjAudioStop();
            const pos = conjCurrentList.indexOf(first.infinitief);
            const names = pos >= 0 ? conjCurrentList.slice(pos, pos + s.count) : [first.infinitief];
            const verbs = names.map(n => conjugationData.find(x => x.infinitief === n)).filter(Boolean);
            const run = { stop: false, paused: false, skip: false, wakeLock: null, ok: 0, ko: 0, viewId: 'conjugaison-view' };
            conjAudioRun = run;
            try { if (navigator.wakeLock) run.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* pas grave */ }

            document.getElementById('conj-exercise-box').innerHTML = `
                <div class="conj-card conj-audio">
                    <div class="conj-audio-title">🎧 Écouter et répéter</div>
                    <div id="conj-audio-now" class="conj-audio-now"></div>
                    <div class="conj-audio-controls">
                        <button type="button" class="btn btn-gray" id="conj-audio-pause" data-audio-pause onclick="conjAudioTogglePause()">⏸ Pause</button>
                        <button type="button" class="btn btn-gray" onclick="conjAudioSkip()">⏭ Passer</button>
                        <button type="button" class="btn btn-gray" onclick="conjAudioStop(); conjAudioRenderSetup();">⏹ Arrêter</button>
                    </div>
                </div>`;

            for (const v of verbs) {
                if (run.stop) break;
                let fr = null;
                try { fr = await conjFetchFrenchForms(v, true); } catch (e) { fr = null; }
                if (run.stop) break;
                const rows = buildConjugationGrid(v);
                const nlForm = (t, p) => {
                    const r = rows.find(x => x.pronomKey === (p.plural ? 'wij' : p.key));
                    return { form: r[t], sentence: p.key + ' ' + r[t] };
                };
                for (const t of s.tenses) {
                    if (run.stop) break;
                    conjAudioShow(`<div class="conj-audio-verb">${rpEscapeHtml(v.infinitief)} <span>— ${rpEscapeHtml(v.fr)}</span></div><div class="conj-audio-tense">${CONJ_TENSE_NAMES[t]}</div>`);
                    run.skip = false;
                    await conjAudioSay(v.infinitief, 'nl', s.rate);
                    await conjAudioSay(v.fr + '. ' + CONJ_TENSE_NAMES[t] + '.', 'fr', s.rate);
                    for (const p of CONJ_AUDIO_PERSONS) {
                        if (run.stop) break;
                        run.skip = false;
                        const { form, sentence } = nlForm(t, p);
                        const frText = fr && fr[t] && fr[t][p.key] ? String(fr[t][p.key]) : '';
                        const header = `<div class="conj-audio-verb">${rpEscapeHtml(v.infinitief)} <span>— ${CONJ_TENSE_NAMES[t]} · ${p.plural ? 'pluriel' : 'singulier'}</span></div>`;
                        const card = (showNl, extra) => header +
                            `<div class="conj-audio-fr">${rpEscapeHtml(frText || '—')}</div>` +
                            `<div class="conj-audio-nl">${showNl ? rpEscapeHtml(sentence) : '…'}</div>` + (extra || '');
                        if (s.order === 'fr' && frText) {
                            conjAudioShow(card(false));
                            await conjAudioSay(frText, 'fr', s.rate);
                            if (s.mode !== 'listen') await conjAudioWait(s.pause * 1000);
                            if (run.stop || run.skip) continue;
                            conjAudioShow(card(true));
                            await conjAudioSay(sentence, 'nl', s.rate);
                        } else {
                            conjAudioShow(card(true));
                            await conjAudioSay(sentence, 'nl', s.rate);
                            if (frText) await conjAudioSay(frText, 'fr', s.rate);
                        }
                        if (run.stop || run.skip) continue;
                        if (s.mode === 'listen') { await conjAudioWait(s.pause ? 300 : 0); continue; }
                        if (s.mode === 'repeat') { conjAudioShow(card(true, '<div class="conj-audio-status">🗣️ À toi…</div>')); await conjAudioWait(s.pause * 1000); continue; }
                        // Répétition vérifiée : deux essais au plus, seul le premier compte.
                        for (let attempt = 0; attempt < 2 && !run.stop && !run.skip; attempt++) {
                            while (run.paused && !run.stop) await conjAudioWait(100);
                            conjAudioShow(card(true, '<div class="conj-audio-status">🎤 À toi, je t\'écoute…</div>'));
                            const heard = await conjAudioListen();
                            if (run.stop || run.skip) break;
                            if (heard && heard.denied) { conjAudioShow(card(true, '<div class="conj-audio-status bad">Micro refusé : autorise-le dans le navigateur.</div>')); run.stop = true; break; }
                            const ok = !!heard && conjAudioMatches(heard, form);
                            if (attempt === 0) { conjRecordResult(v.infinitief, t, p.stat, ok); ok ? run.ok++ : run.ko++; }
                            const said = heard && heard.length ? '« ' + rpEscapeHtml(heard[0]) + ' »' : 'rien entendu';
                            if (ok) { conjAudioShow(card(true, `<div class="conj-audio-status good">✅ ${said}</div>`)); await conjAudioWait(900); break; }
                            conjAudioShow(card(true, `<div class="conj-audio-status bad">❌ ${said}${attempt === 0 ? ' — écoute et réessaie' : ''}</div>`));
                            await conjAudioSay(sentence, 'nl', s.rate);
                        }
                    }
                }
            }
            const finished = !run.stop;
            const stats = s.mode === 'check' && (run.ok + run.ko) ? ` ${run.ok} ✅ / ${run.ko} ❌ du premier coup.` : '';
            if (s.mode === 'check' && (run.ok + run.ko)) save();
            if (conjAudioRun === run) {
                conjAudioRelease(run);
                conjAudioRun = null;
                if (finished) {
                    document.getElementById('conj-exercise-box').innerHTML = `
                        <div class="conj-card conj-audio">
                            <div class="conj-audio-title">🎧 Terminé !${stats}</div>
                            <button class="btn btn-green" style="margin-top:8px;" onclick="conjAudioStart()">🔁 Recommencer</button>
                            <button class="btn btn-gray" onclick="conjAudioRenderSetup()">⚙️ Changer les réglages</button>
                        </div>`;
                }
            }
        }

        function conjAudioRelease(run) {
            if (run && run.wakeLock) { try { run.wakeLock.release(); } catch (e) {} run.wakeLock = null; }
        }

        function conjAudioStop() {
            if (conjAudioRun) {
                conjAudioRun.stop = true;
                conjAudioRelease(conjAudioRun);
                conjAudioRun = null;
            }
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        }

        function conjAudioSkip() {
            if (!conjAudioRun) return;
            conjAudioRun.skip = true;
            conjAudioRun.paused = false;
            window.speechSynthesis.cancel();
        }

        function conjAudioTogglePause() {
            const run = conjAudioRun;
            if (!run) return;
            run.paused = !run.paused;
            document.querySelectorAll('[data-audio-pause]').forEach(btn => { btn.innerText = run.paused ? '▶️ Reprendre' : '⏸ Pause'; });
            if (run.paused) window.speechSynthesis.cancel();
        }

        // ===== Écouter une liste de mots (Mots → 🎧) =====
        // Même moteur de lecture que la conjugaison (conjAudioSay / conjAudioWait / Pause, Passer,
        // Arrêter), appliqué aux mots seuls de la liste affichée : tous les filtres de la liste
        // (catégorie verbes / adjectifs / adverbes..., sous-catégorie, statut, recherche, tri) ou
        // seulement les mots sélectionnés s'il y en a.
        let wlLastItems = [];
        const WORD_AUDIO_COUNTS = [20, 50, 100, 0];
        // Contexte de lecture : la liste de mots (par défaut) ou un kit de jeu de rôle.
        const WORD_AUDIO_LIST_CTX = { boxId: 'wl-audio-box', viewId: 'wordlist-view', items: null, label: '' };
        let wordAudioCtx = WORD_AUDIO_LIST_CTX;

        function wordAudioSettings() {
            if (!state.settings) state.settings = {};
            const s = state.settings.wordAudio || {};
            state.settings.wordAudio = {
                mode: s.mode === 'listen' ? 'listen' : 'repeat',
                order: s.order === 'fr' ? 'fr' : 'nl',
                rate: AUDIO_RATES.some(r => r.v === s.rate) ? s.rate : 0.95,
                pause: AUDIO_PAUSES.includes(s.pause) ? s.pause : 2,
                count: WORD_AUDIO_COUNTS.includes(s.count) ? s.count : 20
            };
            return state.settings.wordAudio;
        }

        function wordAudioSet(key, value) {
            wordAudioSettings()[key] = value;
            save();
            wordAudioRenderSetup();
        }

        function wordAudioItems() {
            const selected = wordAudioCtx.items ? wordAudioCtx.items : (wlSelected.size ? wlLastItems.filter(i => wlSelected.has(i.id)) : wlLastItems);
            const n = wordAudioSettings().count;
            return n ? selected.slice(0, n) : selected;
        }

        function wordAudioOpen() {
            wordAudioCtx = WORD_AUDIO_LIST_CTX;
            const box = document.getElementById('wl-audio-box');
            if (box && box.innerHTML && !conjAudioRun) { box.innerHTML = ''; return; } // 2e clic : referme
            conjAudioStop();
            wordAudioRenderSetup();
        }

        function wordAudioRenderSetup() {
            const box = document.getElementById(wordAudioCtx.boxId);
            if (!box) return;
            const s = wordAudioSettings();
            const chip = (active, onclick, label) => `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
            const source = wordAudioCtx.items ? wordAudioCtx.label : (wlSelected.size ? `les ${wlLastItems.filter(i => wlSelected.has(i.id)).length} mots sélectionnés` : `les ${wlLastItems.length} mots de la liste affichée (filtres et tri compris)`);
            box.innerHTML = `
                <div class="conj-card conj-audio">
                    <div class="conj-audio-title">🎧 Écouter les mots</div>
                    <p class="conj-audio-hint" style="margin-top:0;">On lit ${source}.${wordAudioCtx.items ? '' : ' Choisis une catégorie (Verbes, Adjectifs, Adverbes...) dans le filtre au-dessus pour n\'écouter qu\'elle.'}</p>
                    <div class="conj-audio-label">Mode</div>
                    <div class="conj-audio-chips">
                        ${chip(s.mode === 'listen', "wordAudioSet('mode','listen')", '👂 Écoute seule')}
                        ${chip(s.mode === 'repeat', "wordAudioSet('mode','repeat')", '🗣️ Répète après moi')}
                    </div>
                    <div class="conj-audio-label">Ordre</div>
                    <div class="conj-audio-chips">
                        ${chip(s.order === 'nl', "wordAudioSet('order','nl')", '🇳🇱 Néerlandais d\'abord')}
                        ${chip(s.order === 'fr', "wordAudioSet('order','fr')", '🇫🇷 Français d\'abord (je cherche)')}
                    </div>
                    ${audioSpeedPauseHtml(s, 'wordAudioSet')}
                    <div class="conj-audio-label">Nombre de mots</div>
                    <div class="conj-audio-chips">${WORD_AUDIO_COUNTS.map(n => chip(s.count === n, `wordAudioSet('count',${n})`, n ? String(n) : 'Tous')).join('')}</div>
                    <button class="btn btn-green" style="margin-top:12px;" onclick="wordAudioStart()">▶️ Lancer</button>
                </div>`;
        }

        async function wordAudioStart() {
            if (!('speechSynthesis' in window)) { alert('Ton navigateur ne sait pas lire à voix haute.'); return; }
            const items = wordAudioItems();
            if (!items.length) { alert('Aucun mot dans la liste affichée.'); return; }
            const s = wordAudioSettings();
            conjAudioStop();
            const run = { stop: false, paused: false, skip: false, wakeLock: null, viewId: wordAudioCtx.viewId };
            conjAudioRun = run;
            try { if (navigator.wakeLock) run.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* pas grave */ }
            const box = document.getElementById(wordAudioCtx.boxId);
            box.innerHTML = `
                <div class="conj-card conj-audio">
                    <div id="word-audio-now" class="conj-audio-now"></div>
                    <div class="conj-audio-controls">
                        <button type="button" class="btn btn-gray" data-audio-pause onclick="conjAudioTogglePause()">⏸ Pause</button>
                        <button type="button" class="btn btn-gray" onclick="conjAudioSkip()">⏭ Passer</button>
                        <button type="button" class="btn btn-gray" onclick="conjAudioStop(); wordAudioRenderSetup();">⏹ Arrêter</button>
                    </div>
                </div>`;
            const show = (i, idx, showSecond) => {
                const el = document.getElementById('word-audio-now');
                if (!el) return;
                const first = s.order === 'fr' ? i.fr : i.nl;
                const second = s.order === 'fr' ? i.nl : i.fr;
                el.innerHTML = `<div class="conj-audio-verb"><span>${idx + 1} / ${items.length} · ${rpEscapeHtml(categoryLabel(i.file))}</span></div>` +
                    `<div class="${s.order === 'fr' ? 'conj-audio-fr' : 'conj-audio-nl'}">${rpEscapeHtml(first)}</div>` +
                    `<div class="${s.order === 'fr' ? 'conj-audio-nl' : 'conj-audio-fr'}">${showSecond ? rpEscapeHtml(second) : '…'}</div>`;
            };
            for (let idx = 0; idx < items.length && !run.stop; idx++) {
                const i = items[idx];
                run.skip = false;
                // Une traduction comme « le fait de / l'acte de » se lit mieux sans les barres obliques.
                const frSpoken = i.fr.replace(/\s*\/\s*/g, ', ');
                if (s.order === 'fr') {
                    show(i, idx, false);
                    await conjAudioSay(frSpoken, 'fr', s.rate);
                    if (s.mode === 'repeat') await conjAudioWait(s.pause * 1000);
                    if (run.stop || run.skip) continue;
                    show(i, idx, true);
                    await conjAudioSay(i.nl, 'nl', s.rate);
                } else {
                    show(i, idx, true);
                    await conjAudioSay(i.nl, 'nl', s.rate);
                    await conjAudioSay(frSpoken, 'fr', s.rate);
                }
                if (run.stop || run.skip) continue;
                await conjAudioWait(s.mode === 'repeat' ? s.pause * 1000 : (s.pause ? 300 : 0));
            }
            if (conjAudioRun === run) {
                conjAudioRelease(run);
                conjAudioRun = null;
                box.innerHTML = `
                    <div class="conj-card conj-audio">
                        <div class="conj-audio-title">🎧 Terminé : ${items.length} mot(s) écouté(s).</div>
                        <button class="btn btn-green" style="margin-top:8px;" onclick="wordAudioStart()">🔁 Recommencer</button>
                        <button class="btn btn-gray" onclick="wordAudioRenderSetup()">⚙️ Changer les réglages</button>
                    </div>`;
            }
        }

        // ===== Écouter une scène (spectateur) =====
        // Lecteur commun : dialogues modèles des modules (stockés) et scènes complètes générées par
        // Gemini pour un jeu de rôle (gardées sur l'appareil, localStorage SCENES_KEY). Deux voix
        // quand c'est possible ; réglage state.settings.sceneMode : nl | nl_fr | fr_nl.
        const SCENES_KEY = 'nl_scenes_v1';
        let sceneCurrent = null; // { title, lines, roles, back, regen }

        function sceneMode() { return (state.settings && state.settings.sceneMode) || 'nl_fr'; }
        function sceneRate() { return (state.settings && state.settings.sceneRate) || 0.95; }
        function sceneSet(key, value) { state.settings[key] = value; save(); sceneRenderChips(); }

        function sceneRenderChips() {
            const el = document.getElementById('scene-chips');
            if (!el) return;
            const chip = (active, onclick, label) => `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
            const m = sceneMode(), r = sceneRate();
            el.innerHTML = `
                <div class="conj-audio-chips">
                    ${chip(m === 'nl', "sceneSet('sceneMode','nl')", '🇳🇱 seul')}
                    ${chip(m === 'nl_fr', "sceneSet('sceneMode','nl_fr')", '🇳🇱 puis 🇫🇷')}
                    ${chip(m === 'fr_nl', "sceneSet('sceneMode','fr_nl')", '🇫🇷 puis 🇳🇱')}
                    <span class="conj-chip-sep"></span>
                    ${chip(r === 0.8, "sceneSet('sceneRate',0.8)", '🐢 Lent')}
                    ${chip(r === 0.95, "sceneSet('sceneRate',0.95)", 'Normal')}
                    ${chip(r === 1.15, "sceneSet('sceneRate',1.15)", '🐇 Rapide')}
                    ${chip(r === 1.35, "sceneSet('sceneRate',1.35)", '⚡ Très rapide')}
                </div>`;
        }

        // lines : [{ qui: 'A' | 'B' | 'titre', nl, fr }] ; roles : { A, B } ; back : fonction de retour.
        function sceneOpen(scene) {
            conjAudioStop();
            sceneCurrent = scene;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('scene-view').classList.add('active');
            const box = document.getElementById('scene-content');
            const roles = scene.roles || {};
            box.innerHTML = `
                <h2 style="margin-bottom:4px;">👂 ${rpEscapeHtml(scene.title)}</h2>
                ${scene.subtitle ? `<p class="prep-sub">${rpEscapeHtml(scene.subtitle)}</p>` : ''}
                <div id="scene-chips"></div>
                <div class="conj-audio-controls" style="margin:10px 0;">
                    <button type="button" class="btn btn-green" onclick="scenePlay(0)">▶️ Écouter</button>
                    <button type="button" class="btn btn-gray" data-audio-pause onclick="conjAudioTogglePause()">⏸ Pause</button>
                    <button type="button" class="btn btn-gray" onclick="conjAudioSkip()">⏭</button>
                    <button type="button" class="btn btn-gray" onclick="conjAudioStop()">⏹</button>
                </div>
                ${scene.regen ? `<button type="button" class="report-link" onclick="sceneCurrent.regen()">🔄 Générer une autre scène</button>` : ''}
                <div id="scene-lines">${scene.lines.map((l, i) => l.qui === 'titre'
                    ? `<div class="scene-title" id="scene-line-${i}">${rpEscapeHtml(l.nl)}</div>`
                    : `<div class="scene-line scene-${l.qui}" id="scene-line-${i}" onclick="scenePlay(${i})">
                        <div class="scene-who">${rpEscapeHtml(roles[l.qui] || l.qui)}</div>
                        <div class="scene-nl">${rpEscapeHtml(l.nl)}</div>
                        <div class="scene-fr">${rpEscapeHtml(l.fr || '')}</div>
                    </div>`).join('')}</div>
                <p class="conj-audio-hint">Touche une réplique pour reprendre la lecture à partir d'elle. Garde l'écran allumé.</p>`;
            sceneRenderChips();
            window.scrollTo(0, 0);
        }

        function sceneBack() {
            conjAudioStop();
            if (sceneCurrent && sceneCurrent.back) sceneCurrent.back(); else showPratiquer();
        }

        async function scenePlay(from) {
            const sc = sceneCurrent;
            if (!sc) return;
            conjAudioStop();
            const run = { stop: false, paused: false, skip: false, wakeLock: null, viewId: 'scene-view' };
            conjAudioRun = run;
            try { if (navigator.wakeLock) run.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* pas grave */ }
            for (let i = from || 0; i < sc.lines.length && !run.stop; i++) {
                const l = sc.lines[i];
                run.skip = false;
                const el = document.getElementById('scene-line-' + i);
                document.querySelectorAll('#scene-lines .active').forEach(x => x.classList.remove('active'));
                if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
                const rate = sceneRate(), mode = sceneMode();
                if (l.qui === 'titre') { await conjAudioWait(600); continue; }
                const speaker = l.qui === 'B' ? 1 : 0;
                // Pauses raccourcies quand la lecture va plus vite.
                const gap = ms => conjAudioWait(Math.round(ms * Math.min(1, 0.95 / rate)));
                if (mode === 'fr_nl' && l.fr) { await conjAudioSay(l.fr, 'fr', rate); await gap(250); }
                await conjAudioSay(l.nl, 'nl', rate, { speaker });
                if (mode === 'nl_fr' && l.fr) { await gap(250); await conjAudioSay(l.fr, 'fr', rate); }
                await gap(500);
            }
            if (conjAudioRun === run) {
                conjAudioRelease(run);
                conjAudioRun = null;
                document.querySelectorAll('#scene-lines .active').forEach(x => x.classList.remove('active'));
            }
        }

        // Tous les dialogues modèles d'un module, étape par étape.
        function sceneModule(id) {
            const m = modRpData[id];
            if (!m) return;
            const lines = [];
            m.etapes.forEach((e, i) => {
                if (!(e.dialogue || []).length) return;
                lines.push({ qui: 'titre', nl: (i + 1) + '. ' + e.titre });
                e.dialogue.forEach(l => lines.push({ qui: l.qui, nl: l.nl, fr: l.fr, roleA: e.roles && e.roles.A }));
            });
            // Le nom du personnage A change d'une étape à l'autre : on l'affiche ligne par ligne.
            const roles = { A: 'Interlocuteur', B: 'Toi' };
            sceneOpen({ title: m.titre, subtitle: 'Tous les dialogues du module, à écouter comme un podcast.', lines: lines.map(l => l.roleA ? Object.assign({}, l) : l), roles, back: () => showModuleRp(id) });
            lines.forEach((l, i) => { if (l.roleA && l.qui === 'A') { const w = document.querySelector('#scene-line-' + i + ' .scene-who'); if (w) w.textContent = l.roleA; } });
        }

        // ----- Scènes générées pour un jeu de rôle -----
        function scenesCache() { try { return JSON.parse(localStorage.getItem(SCENES_KEY)) || {}; } catch (e) { return {}; } }
        function scenesSave(cache) { try { localStorage.setItem(SCENES_KEY, JSON.stringify(cache)); } catch (e) { /* stockage plein */ } }

        // Description d'un jeu de rôle pour Gemini : qui est A, la situation, la première réplique.
        function rpSceneSource(launch) {
            if (!launch) return null;
            if (launch.type === 'bank' && rpRealData) {
                const b = rpRealData.banks[launch.index];
                if (!b || rpBankLang(b) !== 'nl') return null;
                // Entretien complet de A à Z, et si le profil privé est rempli, le candidat modèle
                // c'est l'apprenant lui-même : il répond avec son vrai parcours et ses points de vigilance.
                const qs = Object.values(b.questions || {}).flat();
                const profile = (state.candidateProfile || '').trim();
                const notes = ((state.candidateNotes || {})[b.id] || '').trim();
                return { title: b.label, roleA: 'Le recruteur', roleB: profile ? 'Toi (le candidat)' : 'Le candidat', welcome: b.welcome || qs[0] || '',
                    length: '26 à 36', level: b.niveau && !/^(nl|en)$/i.test(b.niveau) ? b.niveau : 'B1',
                    desc: 'Entretien d\'embauche complet, du début à la fin, pour le poste : ' + (b.poste || '') + '. ' + (b.contexte || '') + ' Le recruteur pose ces questions, dans un ordre naturel, en relançant quand il le faut : ' + qs.join(' / ') +
                        (profile ? '\nLe candidat (B) est une personne réelle qui s\'entraîne : il répond avec SON vrai parcours, sans rien inventer : ' + profile : '') +
                        (notes ? '\nIl respecte strictement ces points : ' + notes : '') };
            }
            if (launch.type === 'rp') {
                const s = rpFindScenario(launch.cat, launch.id);
                if (!s) return null;
                return { title: s.label.replace(/^\S+\s/, ''), roleA: 'L\'interlocuteur', roleB: 'Toi', welcome: s.welcome, desc: s.prompt };
            }
            if (launch.type === 'sit' && rpJobData) {
                const s = rpJobData.situations.find(x => x.id === launch.id);
                if (!s || rpSitLang(s) !== 'nl') return null;
                return { title: rpSitTitle(s), roleA: 'L\'interlocuteur', roleB: 'L\'employé (toi)', welcome: rpSitAmorce(s),
                    desc: 'Situation au travail (' + (s.poste || 'logistique') + ') : ' + s.contexte + ' A est la personne qui s\'adresse à l\'employé ; B est l\'employé, qui gère bien la situation.' };
            }
            if (launch.type === 'lib') {
                const e = rpLibFind(launch.id);
                if (!e) return null;
                return { title: e.label, roleA: 'L\'interlocuteur', roleB: 'Toi', welcome: e.welcome, desc: 'Rôle de A : ' + e.role + ' Situation (vue par B) : ' + e.contexte };
            }
            return null;
        }

        function rpSceneOpenFromBtn(btn) {
            try { const d = JSON.parse(decodeURIComponent(btn.dataset.scene)); rpSceneOpen(d.key, d.launch, false); } catch (e) { console.warn(e); }
        }

        async function rpSceneOpen(key, launch, forceNew) {
            const src = rpSceneSource(launch);
            if (!src) return;
            const back = () => { document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById('roleplay-view').classList.add('active'); setActiveNav('nav-pratiquer'); rpShowScenarioPicker(); };
            const cache = scenesCache();
            const saved = (cache[key] || []);
            const show = sc => sceneOpen({ title: src.title, subtitle: (saved.length > 1 ? 'Scène ' + (saved.indexOf(sc) + 1) + '/' + saved.length + ' · ' : '') + 'Écoute la scène comme si tu étais dans la pièce.',
                lines: sc.lignes, roles: { A: sc.roleA || src.roleA, B: src.roleB }, back, regen: () => rpSceneOpen(key, launch, true) });
            if (saved.length && !forceNew) { show(saved[saved.length - 1]); return; }
            if (!GeminiService.getKey()) { alert('Générer une scène nécessite ta clé Gemini (Profil → 🤖 Intelligence IA).'); return; }
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('scene-view').classList.add('active');
            document.getElementById('scene-content').innerHTML = `<h2>👂 ${rpEscapeHtml(src.title)}</h2><p class="prep-sub">Gemini écrit la scène…</p>`;
            sceneCurrent = { back };
            const kit = rpHasKit(key) ? rpBuildKit(key) : null;
            const words = kit ? kit.verbs.map(v => v.inf).concat(kit.words.map(w => w.nl)).slice(0, 18) : [];
            try {
                const raw = await GeminiService.generate(
                    'Écris une scène de dialogue réaliste en néerlandais de Flandre courant (niveau ' + (src.level || 'B1') + ', phrases naturelles à l\'oral, pas trop longues) entre deux personnes.\n' +
                    'Situation : ' + src.desc + '\n' +
                    'A = ' + src.roleA + ' ; B = ' + src.roleB + ', un francophone qui parle bien néerlandais et se débrouille très bien : il sert de modèle à imiter.\n' +
                    'La scène commence par cette réplique de A : """' + src.welcome + '"""\n' +
                    (src.length || '12 à 16') + ' répliques qui alternent, avec un vrai déroulé (début, questions, réponses précises, conclusion).' + (String(src.roleB).startsWith('Toi') ? '' : ' Noms de personnes et d\'entreprises inventés.') +
                    (words.length ? ' Emploie naturellement plusieurs de ces mots : ' + words.join(', ') + '.' : '') + '\n' +
                    'Réponds UNIQUEMENT en JSON : {"roleA": "nom court de A en français (ex. La recruteuse)", "lignes": [{"qui": "A", "nl": "réplique", "fr": "traduction française"}]}'
                );
                const obj = rpHelpParseJson(raw);
                const lignes = obj && Array.isArray(obj.lignes) ? obj.lignes.filter(l => l && (l.qui === 'A' || l.qui === 'B') && l.nl).map(l => ({ qui: l.qui, nl: String(l.nl), fr: String(l.fr || '') })) : [];
                if (lignes.length < 4) throw new Error('scène incomplète');
                const sc = { roleA: obj.roleA ? String(obj.roleA) : src.roleA, lignes, at: Date.now() };
                const c2 = scenesCache();
                c2[key] = (c2[key] || []).concat(sc).slice(-3);
                scenesSave(c2);
                saved.push(sc);
                show(sc);
            } catch (e) {
                document.getElementById('scene-content').innerHTML = `<h2>👂 ${rpEscapeHtml(src.title)}</h2><p style="color:var(--wrong);">Scène impossible à générer : ${rpEscapeHtml(e.message)}</p><button class="btn btn-gray" onclick="sceneBack()">← Retour</button>`;
            }
        }

        // ===== Conjugaison mains libres (à l'oral) =====
        // L'app lit la question (« tu as appris » en fr2nl, « jij hebt geleerd » en nl2fr), écoute la
        // réponse dans l'autre langue, dit la bonne réponse et enchaîne seule. Un 2e essai après la
        // correction (non compté). Seul le sens fr2nl (produire la forme néerlandaise) alimente
        // state.conjStats, comme l'entraînement écrit. Moteur audio commun (Pause/Passer/Arrêter).
        async function conjHandsfreeRun(questions, dir, boxId, viewId, onExit, listenOnly) {
            if (!listenOnly && !window.SpeechRecognition) { alert("La reconnaissance vocale n'est pas disponible dans ce navigateur (utilise Chrome)."); return; }
            questions.forEach(q => { if (!q.frq) q.frq = conjFrQuestion(q.verb, q.tense, q.pronomKey, q.answer, true); });
            const list = questions.filter(q => q.frq);
            if (!list.length) { alert('Traductions françaises indisponibles pour ces verbes.'); return; }
            conjAudioStop();
            const run = { stop: false, paused: false, skip: false, wakeLock: null, viewId };
            conjAudioRun = run;
            try { if (navigator.wakeLock) run.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* pas grave */ }
            const box = document.getElementById(boxId);
            conjHfExit = onExit;
            box.innerHTML = `
                <div class="conj-card conj-audio">
                    <div class="conj-audio-title">${listenOnly ? '👂 Écoute seule' : '🗣️ Mains libres'} · ${dir === 'fr2nl' ? '🇫🇷 → 🇳🇱' : '🇳🇱 → 🇫🇷'}</div>
                    <div id="conj-hf-now" class="conj-audio-now"></div>
                    <div class="conj-audio-controls">
                        <button type="button" class="btn btn-gray" data-audio-pause onclick="conjAudioTogglePause()">⏸ Pause</button>
                        <button type="button" class="btn btn-gray" onclick="conjAudioSkip()">⏭ Passer</button>
                        <button type="button" class="btn btn-gray" onclick="conjAudioStop(); conjHfExit && conjHfExit();">⏹ Arrêter</button>
                    </div>
                </div>`;
            const show = (q, idx, status, reveal) => {
                const el = document.getElementById('conj-hf-now');
                if (!el) return;
                const asked = dir === 'fr2nl' ? q.frq.fr : q.frq.fullAnswer;
                const expected = dir === 'fr2nl' ? q.frq.fullAnswer : q.frq.fr;
                el.innerHTML = `<div class="conj-audio-verb"><span>${idx + 1} / ${list.length} · ${rpEscapeHtml(q.verb.infinitief)} · ${CONJ_TENSE_NAMES[q.tense]}</span></div>` +
                    `<div class="${dir === 'fr2nl' ? 'conj-audio-fr' : 'conj-audio-nl'}">${rpEscapeHtml(asked)}</div>` +
                    `<div class="${dir === 'fr2nl' ? 'conj-audio-nl' : 'conj-audio-fr'}">${reveal ? rpEscapeHtml(expected) : '…'}</div>` +
                    (status ? `<div class="conj-audio-status ${status.cls || ''}">${status.html}</div>` : '');
            };
            let ok = 0, done = 0;
            const missed = [];
            const listenLang = dir === 'fr2nl' ? 'nl-NL' : 'fr-FR';
            const matches = (heard, q) => {
                if (!heard || !heard.length) return false;
                const targets = dir === 'fr2nl' ? [q.frq.fullAnswer, q.answer] : [q.frq.fr];
                return heard.some(h => targets.some(t => rpSpeechMatch(h, t)));
            };
            for (let idx = 0; idx < list.length && !run.stop; idx++) {
                const q = list[idx];
                run.skip = false;
                const asked = dir === 'fr2nl' ? q.frq.fr : q.frq.fullAnswer;
                const expected = dir === 'fr2nl' ? q.frq.fullAnswer : q.frq.fr;
                show(q, idx);
                await conjAudioSay(asked, dir === 'fr2nl' ? 'fr' : 'nl', 0.95);
                if (run.stop || run.skip) continue;
                if (listenOnly) {
                    // Écoute seule : un court temps pour chercher, puis la traduction, sans écouter.
                    await conjAudioWait(900);
                    if (run.stop || run.skip) continue;
                    show(q, idx, null, true);
                    await conjAudioSay(expected, dir === 'fr2nl' ? 'nl' : 'fr', 0.95);
                    done++;
                    await conjAudioWait(700);
                    continue;
                }
                await conjAudioWait(0);
                show(q, idx, { html: '🎤 À toi…' });
                const heard = await conjAudioListen(listenLang);
                if (run.stop || run.skip) continue;
                if (heard && heard.denied) { show(q, idx, { html: 'Micro refusé : autorise-le dans le navigateur.', cls: 'bad' }); run.stop = true; break; }
                const good = matches(heard, q);
                done++;
                if (good) ok++; else missed.push(q);
                if (dir === 'fr2nl') conjRecordResult(q.verb.infinitief, q.tense, q.pronomKey, good);
                const said = heard && heard.length ? '« ' + rpEscapeHtml(heard[0]) + ' »' : 'rien entendu';
                show(q, idx, { html: (good ? '✅ ' : '❌ ') + said, cls: good ? 'good' : 'bad' }, true);
                await conjAudioSay(expected, dir === 'fr2nl' ? 'nl' : 'fr', 0.95);
                if (!good && !run.stop && !run.skip) {
                    show(q, idx, { html: '🔁 Répète : ' + rpEscapeHtml(expected), cls: 'bad' }, true);
                    const again = await conjAudioListen(listenLang);
                    if (run.stop) break;
                    show(q, idx, { html: matches(again, q) ? '👍 C\'est ça' : '➡️ On continue', cls: matches(again, q) ? 'good' : '' }, true);
                }
                await conjAudioWait(500);
            }
            if (done && !listenOnly) save();
            if (conjAudioRun === run) {
                conjAudioRelease(run);
                conjAudioRun = null;
                box.innerHTML = `
                    <div class="conj-card conj-audio">
                        <div class="conj-audio-title">${listenOnly ? '👂 Terminé : ' + done + ' formes écoutées' : '🗣️ Terminé : ' + ok + '/' + done + ' du premier coup'}</div>
                        ${listenOnly ? '' : missed.length ? `<div class="section-title">📌 À revoir</div>${missed.map(m => `
                            <div class="conj-tense-row" style="border-bottom:1px solid var(--border); padding:6px 0;">
                                <span class="conj-grid-pronom" style="flex:1 1 45%;">${rpEscapeHtml(m.frq.fr)}</span>
                                <span class="conj-form">${rpEscapeHtml(m.frq.fullAnswer)}</span>${speakBtnHtml(m.frq.fullAnswer)}
                            </div>`).join('')}` : '<p style="color:var(--success);">Aucune erreur, bravo ! 🎉</p>'}
                        <button class="btn btn-green" style="margin-top:12px;" onclick="conjHfRestart()">🔁 Recommencer</button>
                        <button class="btn btn-gray" onclick="conjHfExit && conjHfExit()">⚙️ Retour</button>
                    </div>`;
                conjHfLast = { questions, dir, boxId, viewId, onExit, listenOnly };
            }
        }
        let conjHfExit = null, conjHfLast = null;
        function conjHfRestart() {
            const l = conjHfLast;
            if (!l) return;
            if (l.boxId === 'conj-training-content') { conjTrainingLaunch(); return; }
            conjHandsfreeRun(l.questions.slice().sort(() => Math.random() - 0.5), l.dir, l.boxId, l.viewId, l.onExit, l.listenOnly);
        }

        // Mains libres sur un verbe (fiche) : 10 formes au hasard, sens choisi dans les réglages.
        function conjHandsfreeVerb(infinitief) {
            const v = conjugationData.find(x => x.infinitief === infinitief);
            if (!v) return;
            const cfg = conjTrainingConfig();
            const rows = buildConjugationGrid(v);
            const pool = [];
            rows.forEach(r => CONJ_TENSES.forEach(t => {
                if (cfg.skipPresentPlural !== false && conjIsTrivialPlural(v, t, r.pronomKey)) return;
                pool.push({ verb: v, tense: t, pronomKey: r.pronomKey, answer: r[t], pronom: r.pronom });
            }));
            pool.sort(() => Math.random() - 0.5);
            const box = document.getElementById('conj-exercise-box');
            const dir = cfg.hfDir === 'nl2fr' ? 'nl2fr' : 'fr2nl';
            box.innerHTML = `
                <div class="conj-card conj-audio">
                    <div class="conj-audio-title">🗣️ Mains libres — <b>${rpEscapeHtml(v.infinitief)}</b></div>
                    <div class="conj-audio-chips">
                        <button type="button" class="conj-filter-chip${dir === 'fr2nl' ? ' active' : ''}" onclick="conjTrainingConfig().hfDir='fr2nl'; save(); conjHandsfreeVerb('${v.infinitief.replace(/'/g, "\\'")}')">🇫🇷 → 🇳🇱</button>
                        <button type="button" class="conj-filter-chip${dir === 'nl2fr' ? ' active' : ''}" onclick="conjTrainingConfig().hfDir='nl2fr'; save(); conjHandsfreeVerb('${v.infinitief.replace(/'/g, "\\'")}')">🇳🇱 → 🇫🇷</button>
                    </div>
                    <div class="conj-audio-chips" style="margin-top:6px;">
                        <button type="button" class="conj-filter-chip${!cfg.hfListen ? ' active' : ''}" onclick="conjTrainingConfig().hfListen=false; save(); conjHandsfreeVerb('${v.infinitief.replace(/'/g, "\\'")}')">🗣️ Je réponds</button>
                        <button type="button" class="conj-filter-chip${cfg.hfListen ? ' active' : ''}" onclick="conjTrainingConfig().hfListen=true; save(); conjHandsfreeVerb('${v.infinitief.replace(/'/g, "\\'")}')">👂 Écoute seule</button>
                    </div>
                    <p class="conj-audio-hint">${cfg.hfListen ? '10 formes au hasard, dites dans une langue puis dans l\'autre, sans répondre.' : '10 formes au hasard. L\'app lit, t\'écoute, corrige et enchaîne.'}</p>
                    <button class="btn btn-green" id="conj-hf-start">▶️ Lancer</button>
                </div>`;
            document.getElementById('conj-hf-start').onclick = () => conjHandsfreeRun(pool.slice(0, 10), dir, 'conj-exercise-box', 'conjugaison-view', () => conjHandsfreeVerb(infinitief), !!cfg.hfListen);
            box.scrollIntoView({ block: 'start' });
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
            conjAudioStop();
            const rows = buildConjugationGrid(v);
            const tenses = ['present', 'futur', 'imperfectum', 'perfectum'];
            const pool = [];
            rows.forEach(r => tenses.forEach(t => {
                if (conjSkipPresentPlural() && conjIsTrivialPlural(v, t, r.pronomKey)) return;
                pool.push({ pronom: r.pronom, pronomKey: r.pronomKey, tense: t, answer: r[t] });
            }));
            // Mélange (Fisher-Yates) puis limite à 8 questions par session — assez pour réviser un
            // verbe sans que ce soit trop long.
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            const chosen = pool.slice(0, 8);
            chosen.forEach(q => { q.frq = conjFrQuestion(v, q.tense, q.pronomKey, q.answer); });
            conjExerciseState = { verb: v, pool: chosen, index: 0, score: 0 };
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
                    <div class="conj-filter-chips-row" style="margin-bottom:8px;">${conjQuestionLangChipsHtml('conjExerciseRelang')}<button type="button" class="conj-filter-chip${conjSkipPresentPlural() ? ' active' : ''}" onclick="conjTrainingToggleSkipPlural(conjExerciseRestart)">⏭️ Sans pluriel du présent</button></div>
                    ${q.frq
                        ? `<div class="conj-question-fr">${rpEscapeHtml(q.frq.fr)}</div><div class="conj-question-hint">${st.verb.infinitief} · ${CONJ_TENSE_NAMES[q.tense]}</div>`
                        : `<div style="font-weight:600; margin-bottom:10px;">${q.pronom} — ${st.verb.infinitief} (${st.verb.fr}) — ${CONJ_TENSE_LABELS[q.tense]}</div>`}
                    <input type="text" id="conj-ex-input" placeholder="${q.frq ? 'En néerlandais, avec le pronom...' : 'Tape la forme conjuguée...'}" style="width:100%; margin-bottom:8px;" autocomplete="off" onkeypress="if(event.key==='Enter') conjExerciseCheck()">
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
            if (st.checking) return;
            st.checking = true;
            const result = conjEvaluate(input.value, q);
            const shown = q.frq ? q.frq.fullAnswer : q.answer;
            if (result.status === 'correct') {
                st.score++;
                fb.style.color = 'var(--success)';
                fb.innerText = '✅ Bravo ! → ' + shown;
            } else if (result.status === 'close') {
                st.score++;
                fb.style.color = 'var(--success)';
                fb.innerText = '🟡 Presque, on valide ! → ' + shown;
            } else {
                fb.style.color = 'var(--wrong)';
                fb.innerText = '❌ → ' + shown;
            }
            fb.insertAdjacentHTML('beforeend', ' ' + reportBtnHtml({ kind: 'conjugaison', ref: st.verb.infinitief, nl: shown, fr: q.frq ? q.frq.fr : st.verb.fr, context: CONJ_TENSE_NAMES[q.tense] + ' · ' + q.pronom }));
            conjRecordResult(st.verb.infinitief, q.tense, q.pronomKey, result.status !== 'wrong');
            save();
            st.index++;
            // Plus de temps sur une erreur, pour lire la réponse (et la signaler si elle est fausse).
            setTimeout(() => { st.checking = false; conjExerciseRenderQuestion(); }, result.status === 'wrong' ? 2600 : 1300);
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

        // Limite optionnelle aux verbes d'un kit de jeu de rôle ({ label, verbs: Set }) : la tranche
        // « Top N » est alors ignorée, le filtre irréguliers reste appliqué.
        let conjTrainingVerbFilter = null;

        function conjTrainingVerbPool(cfg) {
            const { sorted } = conjByFrequency();
            if (conjTrainingVerbFilter) {
                const kitVerbs = sorted.filter(v => conjTrainingVerbFilter.verbs.has(v.infinitief));
                return cfg.irregOnly ? kitVerbs.filter(isStrongPreteritum) : kitVerbs;
            }
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
                    if (cfg.skipPresentPlural !== false && conjIsTrivialPlural(v, t, r.pronomKey)) return;
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
        // filter : undefined = garder le filtre en cours ; null = tous les verbes ; objet = kit.
        function startConjTrainingSession(filter) {
            if (filter !== undefined) conjTrainingVerbFilter = filter;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('conj-training-view').classList.add('active');
            setActiveNav('nav-vocab');
            const content = document.getElementById('conj-training-content');
            if (!conjugationLoaded) {
                content.innerHTML = '<p style="color:#888;">Données de conjugaison en cours de chargement...</p>';
                return;
            }
            conjTrainingState = null;
            renderConjTrainingSetup();
        }

        function conjTrainingSetRange(n) { conjTrainingConfig().range = n; save(); renderConjTrainingSetup(); }
        // Au présent, le pluriel (wij / jullie / zij) est simplement l'infinitif : « wij werken ».
        // Option pour ne pas être interrogé dessus (activée par défaut). Les verbes à particule
        // séparable restent posés, leur pluriel n'étant pas l'infinitif (« wij bieden aan »).
        function conjIsTrivialPlural(v, tense, pronomKey) {
            return tense === 'present' && pronomKey === 'wij' && v.present && v.present.wij === v.infinitief;
        }
        function conjSkipPresentPlural() { return conjTrainingConfig().skipPresentPlural !== false; }
        function conjTrainingToggleSkipPlural(rerender) {
            const c = conjTrainingConfig();
            c.skipPresentPlural = !conjSkipPresentPlural();
            save();
            if (rerender) rerender();
        }
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
                    ${conjTrainingVerbFilter ? `<div class="prep-filter-banner">📚 Verbes du kit « ${rpEscapeHtml(conjTrainingVerbFilter.label)} » (${conjTrainingVerbFilter.verbs.size}) <button type="button" class="conj-filter-chip" onclick="startConjTrainingSession(null)">✕ Tous les verbes</button></div>` : ''}
                    <div class="conj-setup-label">Quels verbes ?</div>
                    <div class="conj-filter-chips-row">
                        ${CONJ_RANGE_CHIPS.map(c => chip(c.key === cfg.range, `conjTrainingSetRange(${c.key})`, c.key ? c.label.replace('Top', 'Les') + ' plus courants' : 'Tous')).join('')}
                        ${chip(cfg.irregOnly, 'conjTrainingToggleIrreg()', '⚡ Irréguliers seulement')}
                        ${chip(conjSkipPresentPlural(), 'conjTrainingToggleSkipPlural(renderConjTrainingSetup)', '⏭️ Sauter le pluriel du présent (= infinitif)')}
                    </div>
                    <div class="conj-setup-label">Écrit ou à l'oral ?</div>
                    <div class="conj-filter-chips-row">
                        ${chip(!cfg.handsfree, 'conjTrainingSetHandsfree(false)', '⌨️ À l\'écrit')}
                        ${chip(!!cfg.handsfree && !cfg.hfListen, 'conjTrainingSetHandsfree(true)', '🗣️ Mains libres (je réponds)')}
                        ${chip(!!cfg.handsfree && !!cfg.hfListen, "conjTrainingSetHandsfree('ecoute')", '👂 Écoute seule')}
                    </div>
                    ${cfg.handsfree ? `<div class="conj-setup-label">Dans quel sens ?</div>
                    <div class="conj-filter-chips-row">
                        ${chip(cfg.hfDir !== 'nl2fr', "conjTrainingSetHfDir('fr2nl')", cfg.hfListen ? '🇫🇷 puis 🇳🇱' : '🇫🇷 → 🇳🇱 j\'entends le français, je dis le néerlandais')}
                        ${chip(cfg.hfDir === 'nl2fr', "conjTrainingSetHfDir('nl2fr')", cfg.hfListen ? '🇳🇱 puis 🇫🇷' : '🇳🇱 → 🇫🇷 j\'entends le néerlandais, je dis le français')}
                    </div>
                    <p class="conj-audio-hint">${cfg.hfListen ? 'L\'app lit chaque forme dans une langue puis dans l\'autre, sans t\'écouter, et enchaîne. Garde l\'écran allumé.' : 'L\'app lit chaque question, t\'écoute, te dit la bonne réponse et passe à la suivante toute seule. Garde l\'écran allumé.'}</p>` : `
                    <div class="conj-setup-label">Comment poser la question ?</div>
                    <div class="conj-filter-chips-row">${conjQuestionLangChipsHtml('renderConjTrainingSetup')}</div>`}
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

        function conjTrainingSetHandsfree(on) {
            const c = conjTrainingConfig();
            c.handsfree = !!on;
            c.hfListen = on === 'ecoute';
            save();
            renderConjTrainingSetup();
        }
        function conjTrainingSetHfDir(dir) { conjTrainingConfig().hfDir = dir; save(); renderConjTrainingSetup(); }

        function conjTrainingLaunch() {
            const questions = pickConjTrainingQuestions(conjTrainingConfig());
            if (!questions.length) return;
            if (conjTrainingConfig().handsfree) {
                conjHandsfreeRun(questions, conjTrainingConfig().hfDir === 'nl2fr' ? 'nl2fr' : 'fr2nl', 'conj-training-content', 'conj-training-view', () => renderConjTrainingSetup(), !!conjTrainingConfig().hfListen);
                return;
            }
            questions.forEach(q => { q.frq = conjFrQuestion(q.verb, q.tense, q.pronomKey, q.answer); });
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
                    ${q.frq ? `
                    <div class="conj-question-fr">${rpEscapeHtml(q.frq.fr)}</div>
                    <div class="conj-question-hint">${q.verb.infinitief} · ${CONJ_TENSE_NAMES[q.tense]}</div>` : `
                    <div class="conj-verb-title">${q.verb.infinitief} ${speakBtnHtml(q.verb.infinitief)}</div>
                    <div style="color:#888; margin-bottom:12px;">${q.verb.fr}</div>
                    <div class="conj-question-prompt"><b>${q.pronom}</b> — ${CONJ_TENSE_LABELS[q.tense]}</div>`}
                    <input type="text" id="conj-tr-input" style="width:100%; margin-bottom:8px;" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${q.frq ? 'En néerlandais, avec le pronom...' : 'Tape la forme conjuguée...'}" onkeypress="if(event.key==='Enter') conjTrainingCheck()">
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
            const result = conjEvaluate(document.getElementById('conj-tr-input').value, q);
            const isCorrect = result.status !== 'wrong';
            const fb = document.getElementById('conj-tr-feedback');
            const shown = q.frq ? q.frq.fullAnswer : q.answer;
            if (isCorrect) {
                st.score++;
                fb.style.color = 'var(--success)';
                fb.innerHTML = (result.status === 'close' ? '🟡 Presque, on valide ! → ' : '✅ ') + shown;
            } else {
                st.missed.push(q);
                fb.style.color = 'var(--wrong)';
                fb.innerHTML = `❌ Réponse attendue : ${shown}`;
            }
            fb.innerHTML += ' ' + speakBtnHtml(shown) + ' ' + reportBtnHtml({ kind: 'conjugaison', ref: q.verb.infinitief, nl: shown, fr: q.frq ? q.frq.fr : q.verb.fr, context: CONJ_TENSE_NAMES[q.tense] + ' · ' + q.pronom });
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
                        <span class="conj-grid-pronom" style="flex:1 1 45%;"><b style="color:var(--text);">${m.verb.infinitief}</b> · ${m.frq ? rpEscapeHtml(m.frq.fr) : m.pronom}<br>${CONJ_TENSE_NAMES[m.tense]}</span>
                        <span class="conj-form">${m.frq ? m.frq.fullAnswer : m.answer}</span>
                        ${speakBtnHtml(m.frq ? m.frq.fullAnswer : m.answer)}
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
            setActiveNav('nav-vocab');
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
            if (curriculumNotions.verbes_separables_intro) recordNotionAttempt('verbes_separables_intro', isCorrect);
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
            // Sa propre clé d'abord ; sinon la clé partagée par l'admin aux bêta-testeurs
            // (BETA_KEY_STORAGE, copiée depuis Firestore config/gemini à la connexion).
            function getKey() {
                return localStorage.getItem('gemini_api_key') || localStorage.getItem(BETA_KEY_STORAGE) || '';
            }
            function isAvailable() {
                return !!getKey();
            }
            async function generate(prompt) {
                const apiKey = getKey();
                if (!apiKey) throw new Error('Aucune clé API Gemini enregistrée (Profil → 🤖 Intelligence IA).');
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
                // Quand le prompt demande du JSON, on l'impose à l'API : sinon Gemini glisse parfois
                // une phrase ou un caractère qui rend la réponse illisible.
                const wantsJson = /UNIQUEMENT en JSON|JSON strict/i.test(prompt);
                const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
                if (wantsJson) body.generationConfig = { responseMimeType: 'application/json' };
                // Gemini surchargé (« trop de demandes ») : deux nouveaux essais, après 2 puis 5 s.
                const busy = (status, msg) => status === 429 || status === 500 || status === 503 || /overload|high demand|unavailable|exhausted|try again/i.test(msg || '');
                let data = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    let status = 0;
                    try {
                        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                        status = response.status;
                        data = await response.json();
                    } catch (e) { data = { error: { message: e.message } }; }
                    if (!(data && data.error && busy(status, data.error.message)) || attempt === 2) break;
                    await new Promise(r => setTimeout(r, attempt ? 5000 : 2000));
                }
                if (data.error) throw new Error(/overload|high demand|unavailable|exhausted|try again/i.test(data.error.message || '') ? 'Gemini est surchargé pour le moment (trop de demandes), réessaie dans un instant' : (data.error.message || 'Erreur API Gemini'));
                if (data.candidates && data.candidates[0].content) {
                    return (data.candidates[0].content.parts || []).map(x => x.text || '').join('');
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
            { file: 'LOCUTIONS_NL', label: 'Locutions & tournures écrites' },
            { file: 'PHRASES_LABO', label: 'Phrases Labo' }
        ];

        // Nom lisible d'une catégorie de mots. Sans ça, l'écran affichait le nom brut du fichier
        // CSV (THEME_COMPTABILITE, MOTS_LABO, VERBES_NL...) dans le tri rapide, le filtre et les
        // lignes de la liste de mots. Un fichier inconnu ici garde son nom, sans les "_".
        const THEME_LABELS = {
            THEME_BASE: '📚 Base', THEME_MARKETING: '📣 Marketing', THEME_FINANCE: '💰 Finance',
            THEME_COMPTABILITE: '🧾 Comptabilité', THEME_LOGISTIQUE: '📦 Logistique',
            THEME_SUPPLYCHAIN: '🚚 Supply Chain', THEME_MANAGEMENT: '🧭 Management', THEME_RH: '👥 RH',
            THEME_ENTRETIEN: '🤝 Entretien', THEME_BUSINESS_ANALYST: '📊 Business analyst', THEME_CONSULTANT: '💼 Consultant', THEME_PROJET: '🗂️ Gestion de projet', THEME_BIBLIOTHEQUE: '📚 Bibliothèque', THEME_DATA: '📈 Data', THEME_PMO: '🧭 PMO', THEME_ERP: '🧩 Logiciel / ERP', MOTS_LABO: 'Mots Labo', KITS_JEU_DE_ROLE: '🎭 Kits jeu de rôle',
            MOTS_JEU_DE_ROLE: '🎭 Mots repérés en jeu de rôle', MON_PORTRAIT: '🪪 Mon portrait'
        };
        function categoryLabel(file) {
            const main = MAIN_CATEGORIES.find(c => c.file === file);
            return (main && main.label) || THEME_LABELS[file] || String(file).replace(/^THEME_/, '').replace(/_/g, ' ');
        }

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
                <div class="card-menu blue" onclick="vocabOpenCat('file', '${cat.file}')">
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
            section.innerHTML = '<div class="section-title">💼 Thèmes métier</div><div class="grid" style="margin-top:0;">' +
                themes.map(t => `<div class="card-menu blue" onclick="vocabOpenCat('file', '${t.file}')">${categoryLabel(t.file)} (${t.count})</div>`).join('') +
                '</div>';
        }

        // « Mes listes » : les mots venus du jeu de rôle et du portrait (fichiers virtuels de
        // fullDb), puis les listes perso.
        const VOCAB_VIRTUAL_FILES = ['MOTS_JEU_DE_ROLE', 'KITS_JEU_DE_ROLE', 'MON_PORTRAIT'];
        function renderCustomListsHome() {
            const section = document.getElementById('customlist-section');
            if (!section) return;
            const files = VOCAB_VIRTUAL_FILES.map(f => ({ f, n: fullDb.filter(i => i.file === f).length })).filter(x => x.n);
            const names = Object.keys(state.customLists).filter(n => state.customLists[n].length);
            if (!files.length && !names.length) { section.innerHTML = ''; return; }
            section.innerHTML = '<div class="section-title">📋 Mes listes</div><div class="grid" style="margin-top:0;">' +
                files.map(x => `<div class="card-menu" style="color:#8b5cf6" onclick="vocabOpenCat('file', '${x.f}')">${categoryLabel(x.f)} (${x.n})</div>`).join('') +
                names.map(n => `<div class="card-menu" style="color:#8b5cf6" onclick="vocabOpenCat('list', decodeURIComponent('${encodeURIComponent(n).replace(/'/g, '%27')}'))">📋 ${rpEscapeHtml(n)} (${state.customLists[n].length})</div>`).join('') +
                '</div>';
        }

        // ===== Onglet « Vocabulaire » =====
        function showVocab() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('vocab-view').classList.add('active');
            setActiveNav('nav-vocab');
            renderMainCategories();
            renderCustomListsHome();
            updateDirectionButton();
            renderReviser();
        }

        // Fiche d'une catégorie (fichier de mots ou liste perso) : les mêmes boutons partout.
        let vocabCurrent = null;   // { kind, key }
        let studyReturnFn = null;  // où ramène « ← Retour » de l'entraînement
        function vocabItems(kind, key) {
            const items = kind === 'list'
                ? fullDb.filter(i => (state.customLists[key] || []).includes(i.id))
                : fullDb.filter(i => i.file === key);
            return byFrequencyDesc(items);
        }
        function vocabOpenCat(kind, key) {
            conjAudioStop();
            vocabCurrent = { kind, key };
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('vocabcat-view').classList.add('active');
            setActiveNav('nav-vocab');
            const items = vocabItems(kind, key);
            const label = kind === 'list' ? '📋 ' + key : categoryLabel(key);
            const mastered = items.filter(i => isTrueMastered(i.id)).length;
            const toReview = items.filter(i => wordStatus(i.id) === 'review').length;
            const pct = items.length ? Math.round(mastered / items.length * 100) : 0;
            document.getElementById('vocabcat-audio-box').innerHTML = '';
            document.getElementById('vocabcat-content').innerHTML = `
                <h2 style="margin-bottom:4px;">${rpEscapeHtml(label)}</h2>
                <p class="section-subtitle" style="margin-top:0;">${items.length} mots · ${mastered} maîtrisés (${pct}%)${toReview ? ' · ' + toReview + ' à revoir' : ''}${usedWordsCount(items) ? ' · 🗣️ ' + usedWordsCount(items) + " dits à l'oral" : ''}</p>
                <div class="cat-bar" style="margin-bottom:var(--space-3);"><div class="cat-bar-fill" style="width:${pct}%"></div></div>
                <div class="hub-grid single">
                    <div class="hub-card accent" onclick="vocabTrain()"><span class="hub-card-icon">✍️</span><div class="hub-card-title">S'entraîner</div><div class="hub-card-desc">Traduire les mots, du plus courant au plus rare, par paquets.</div></div>
                    <div class="hub-card" onclick="vocabListen()"><span class="hub-card-icon">🎧</span><div class="hub-card-title">Écouter</div><div class="hub-card-desc">Les mots lus en néerlandais et en français, mains libres.</div></div>
                    ${key === 'VERBES_NL' ? `<div class="hub-card" onclick="showConjugaison()"><span class="hub-card-icon">🔤</span><div class="hub-card-title">Conjugaison</div><div class="hub-card-desc">Fiches des verbes et entraînement, à l'écrit, à l'oral ou en écoute.</div></div>` : ''}
                    ${kind === 'file' ? `<div class="hub-card" onclick="showWordList('vocab', '${key}')"><span class="hub-card-icon">📋</span><div class="hub-card-title">Voir la liste</div><div class="hub-card-desc">Chercher, filtrer, sélectionner des mots pour en faire une liste.</div></div>` : ''}
                </div>`;
        }
        function vocabTrain() {
            if (!vocabCurrent) return;
            const { kind, key } = vocabCurrent;
            studyReturnFn = () => vocabOpenCat(kind, key);
            if (kind === 'list') startCustomList(key); else startSession(key);
        }
        function vocabListen() {
            if (!vocabCurrent) return;
            const box = document.getElementById('vocabcat-audio-box');
            if (box.innerHTML && !conjAudioRun) { box.innerHTML = ''; return; } // 2e clic : referme
            const { kind, key } = vocabCurrent;
            const label = kind === 'list' ? key : categoryLabel(key);
            wordAudioCtx = { boxId: 'vocabcat-audio-box', viewId: 'vocabcat-view', items: vocabItems(kind, key), label: `les mots « ${label} », du plus courant au plus rare` };
            conjAudioStop();
            wordAudioRenderSetup();
            box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        function studyBack() {
            const f = studyReturnFn;
            studyReturnFn = null;
            if (f) f(); else showHome();
        }

        // LISTE DES MOTS (vue + sélection + listes perso)
        // Accessible depuis Vocabulaire (fiche d'une catégorie). Ancien commentaire : "Apprendre →
        // Vocabulaire") : on retient d'où on vient pour que "← Retour" ramène au bon endroit,
        // plutôt que de renvoyer systématiquement vers Profil.
        let wordListReturnTo = 'vocab';
        function showWordList(returnTo, presetFile) {
            wordListReturnTo = returnTo || 'vocab';
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('wordlist-view').classList.add('active');
            setActiveNav('nav-vocab');
            const filter = document.getElementById('wl-filter');
            const categories = [...new Set(fullDb.map(i => i.file))];
            filter.innerHTML = '<option value="">Toutes catégories</option>' +
                categories.map(c => `<option value="${c}">${categoryLabel(c)}</option>`).join('');
            if (presetFile) filter.value = presetFile;
            renderWordList();
            // Les blocs arrivent en différé : on redessine la liste quand ils sont là (bouton 🧩).
            if (!chunksData) loadChunks().then(() => { if (document.getElementById('wordlist-view').classList.contains('active')) renderWordList(); });
        }

        function wordListBack() {
            if (vocabCurrent) vocabOpenCat(vocabCurrent.kind, vocabCurrent.key); else showVocab();
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
            if (statusFilter === 'useful') items = items.filter(i => isUsefulWord(i.id));
            else if (statusFilter) items = items.filter(i => wordStatus(i.id) === statusFilter);
            if (search) items = items.filter(i => normalize(i.fr).includes(search) || normalize(i.nl).includes(search));

            items = [...items];
            if (sortMode === 'freq-desc') items.sort((a, b) => (b.freq || 0) - (a.freq || 0));
            else if (sortMode === 'freq-asc') items.sort((a, b) => (a.freq || 0) - (b.freq || 0));
            else items.sort((a, b) => a.fr.localeCompare(b.fr));
            wlLastItems = items; // liste lue par 🎧 Écouter les mots

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
                    ${usefulStarHtml(i.id)}
                    ${reportBtnHtml({ kind: 'mot', ref: i.id, nl: i.nl, fr: i.fr, context: categoryLabel(i.file) })}
                    ${wordChunksButtonHtml(i)}
                    ${niveauCECRBadgeHtml(i.niveauCECR)}
                    <span class="wl-badge ${st}">${badgeLabel[st]}</span>
                    ${usedBadgeHtml(i.id)}
                    <span class="wl-file">${categoryLabel(i.file)}${i.sousCategorie ? ' · ' + i.sousCategorie : ''}${freqTxt ? ' · ' + freqTxt : ''}</span>
                </div>${wordChunksPanelHtml(i)}`;
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
                const label = categoryLabel(cat);
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
            document.querySelectorAll('.bottom-nav button, .header-profil-btn').forEach(b => b.classList.remove('active'));
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
            document.getElementById('session-title').innerText = categoryLabel(category);
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
            const ownKey = !!localStorage.getItem('gemini_api_key');
            const sharedKey = !ownKey && !!localStorage.getItem(BETA_KEY_STORAGE);
            return `
                <div class="study-box" style="margin-top:15px;">
                    <h3>🤖 Intelligence IA</h3>
                    <p style="font-size:0.85rem;">Utilisée pour les corrections, le jeu de rôle vocal et la production écrite/orale. Ta clé reste uniquement sur cet appareil — elle n'est jamais envoyée dans ta sauvegarde cloud avec ta progression.</p>
                    <p style="font-weight:bold; color:${configured ? 'var(--success)' : 'var(--wrong)'};">${sharedKey ? '✅ Clé fournie (accès bêta) : rien à faire' : (configured ? '✅ Clé configurée' : '❌ Aucune clé configurée')}</p>
                    ${sharedKey ? '<p style="font-size:0.8rem;">Tu peux quand même enregistrer ta propre clé ci-dessous : elle sera utilisée à la place.</p>' : ''}
                    <input type="password" id="gemini-key-input" placeholder="Colle ta clé API Gemini ici...">
                    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                        <button class="btn btn-green" onclick="geminiSaveKeyFromProfil()">💾 Enregistrer</button>
                        <button class="btn btn-gray" onclick="geminiTestConnection()">🔌 Tester la connexion</button>
                        ${ownKey ? `<button class="btn btn-red" onclick="geminiRemoveKey()">🗑️ Supprimer</button>` : ''}
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
            // Les sections repliables gardent leur état quand le profil se redessine (par exemple
            // après avoir enregistré une clé Gemini, qui se trouve dans une section repliée).
            const openSections = [...document.querySelectorAll('#profil-content details.profil-section[open]')].map(d => d.id);
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
                <div class="hub-card" onclick="notionGo('${w.id}')">
                    <div class="hub-card-title">${getNotionStatusLabel(w.status)} — ${rpEscapeHtml(notionTitle(w.id))}</div>
                    <div class="dash-mini-bar"><div class="dash-mini-fill" style="width:${w.mastery * 20}%"></div></div>
                    ${NOTION_TARGETED_PRACTICE[w.id] ? `<button class="gemini-explain-btn" onclick="event.stopPropagation(); rpStartTargetedPractice('${w.id}')">🎯 Pratiquer à l'oral cette notion</button>` : ''}
                </div>`).join('') : `<p style="font-size:0.85rem; color:var(--text-secondary);">Aucun point faible identifié pour l'instant 🎉</p>`;


            document.getElementById('profil-content').innerHTML = `
                ${compteSnapshotHtml}
                <div class="profil-stat-grid">
                    <div class="profil-stat-tile"><div class="ps-num">${cecrInfo.level}</div><div class="ps-label">Niveau CECR</div></div>
                    <div class="profil-stat-tile"><div class="ps-num">⭐ ${state.xp || 0}</div><div class="ps-label">XP</div></div>
                    <div class="profil-stat-tile"><div class="ps-num">🔥 ${state.stats.dailyStreak || 0}</div><div class="ps-label">Jours de suite</div></div>
                    <div class="profil-stat-tile"><div class="ps-num">${masteredNotions}</div><div class="ps-label">Notions maîtrisées</div></div>
                </div>
                <div class="profil-menu">
                    <div class="profil-menu-row" onclick="showOnboarding()"><span class="pm-icon">🧭</span><span>Choisir mon point de départ</span><span class="pm-chevron">›</span></div>
                    <div class="profil-menu-row" style="cursor:pointer;" onclick="toggleFreeAccess(${!state.freeAccess})">
                        <span class="pm-icon">${state.freeAccess ? '🔓' : '🔒'}</span>
                        <span>Mode libre (accès à toutes les leçons)</span>
                        <span class="pm-chevron">${state.freeAccess ? 'Activé' : 'Désactivé'}</span>
                    </div>
                    ${state.freeAccess ? `<p style="font-size:0.72rem; color:var(--text-secondary); margin:-8px 0 var(--space-2) 14px;">Tu peux sauter le déverrouillage progressif et aller direct où tu veux (ex. B2). Ce n'est pas l'ordre recommandé — les notions plus avancées supposent souvent des prérequis non travaillés — mais rien ne t'en empêche.</p>` : ''}
                    <div class="profil-menu-row" onclick="showSocial()"><span class="pm-icon">👥</span><span>Amis, défis & sessions</span><span class="pm-chevron">›</span></div>
                    <div class="profil-menu-row" onclick="showInfo()"><span class="pm-icon">ℹ️</span><span>Infos</span><span class="pm-chevron">›</span></div>
                    <div class="profil-menu-row" onclick="showCompte()"><span class="pm-icon">🔐</span><span>Compte</span><span class="pm-chevron">›</span></div>
                </div>

                <details class="profil-section" id="profil-sec-carte" ${openSections.includes('profil-sec-carte') || !openSections.length ? 'open' : ''}>
                <summary>🗺️ Carte de mes compétences</summary>
                <div class="carte">${competenceMapHtml()}</div>
                </details>

                <details class="profil-section" id="profil-sec-stats" ${openSections.includes('profil-sec-stats') ? 'open' : ''}>
                <summary>📊 Statistiques détaillées</summary>
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
                </details>

                ${reportsSectionHtml(openSections)}

                <details class="profil-section" id="profil-sec-settings" ${openSections.includes('profil-sec-settings') ? 'open' : ''}>
                <summary>⚙️ Réglages et sauvegarde</summary>
                ${renderGeminiConfigBlock()}
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
                </div>
                </details>`;
        }

        // Ouvre le Profil directement sur les réglages (clé Gemini, sauvegarde), qui sont
        // repliés par défaut.
        function showProfilSettings() {
            showProfil();
            const sec = document.getElementById('profil-sec-settings');
            if (sec) { sec.open = true; sec.scrollIntoView({ block: 'start' }); }
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
            setActiveNav('nav-vocab');
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
            testSetExtraControls(true);
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
            testSetExtraControls(true);
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
            testLocked = false;
            testRefreshStar();
            const label = testMode === 'adaptive' ? `Palier "${FREQ_BANDS[adaptiveBandIdx].label}" — ` : '';
            document.getElementById('test-progress').innerText = `${label}Mot ${testIndex + 1} / ${testQueue.length}`;
        }

        let testLocked = false; // vrai entre une réponse et le mot suivant : évite un double comptage

        function testCheckAns() {
            if (testLocked) return;
            const item = testQueue[testIndex];
            if (!item) return;
            const raw = document.getElementById('test-ans-input').value;
            const { answerField } = questionFor(item);
            const result = evaluateAnswer(raw, item[answerField]);
            testRecordAnswer(item, result.status !== 'wrong', false);
        }

        // "Je le connais" : compte le mot comme su sans avoir à taper la réponse. Enregistré
        // exactement comme une bonne réponse (mot vu, réussi, maîtrisé) — c'est une déclaration,
        // donc à utiliser honnêtement ; la réponse s'affiche quand même pour pouvoir vérifier.
        function testDeclareKnown() {
            if (testLocked) return;
            const item = testQueue[testIndex];
            if (!item) return;
            testRecordAnswer(item, true, true);
        }

        function testRecordAnswer(item, isCorrect, declared) {
            testLocked = true;
            const { answerField } = questionFor(item);
            const correctAnswer = item[answerField];
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
            // Un mot déclaré connu laisse un peu plus de temps pour lire la réponse affichée.
            setTimeout(testNextQ, declared ? 1300 : 900);
        }

        // ===== Mots utiles (étoile) =====
        // state.usefulWords[id] = true : les mots que l'apprenant veut retrouver facilement.
        // Indépendant de la maîtrise. Visible dans Apprendre → Mots, filtre "⭐ Mots utiles".
        function isUsefulWord(id) { return !!(state.usefulWords && state.usefulWords[id]); }

        function toggleUsefulWord(id) {
            if (!state.usefulWords) state.usefulWords = {};
            state.usefulWords[id] = !state.usefulWords[id];
            save();
        }

        function usefulStarHtml(id) {
            const on = isUsefulWord(id);
            return `<button type="button" class="star-btn${on ? ' on' : ''}" onclick="event.stopPropagation(); toggleUsefulWord('${id}'); renderWordList();" title="Mot utile" aria-label="Marquer comme mot utile">${on ? '★' : '☆'}</button>`;
        }

        function testRefreshStar() {
            const btn = document.getElementById('test-star-btn');
            const item = testQueue[testIndex];
            if (!btn || !item) return;
            const on = isUsefulWord(item.id);
            btn.innerText = on ? '★' : '☆';
            btn.classList.toggle('on', on);
        }

        function testToggleUseful() {
            const item = testQueue[testIndex];
            if (!item || testLocked) return;
            toggleUsefulWord(item.id);
            testRefreshStar();
        }

        // Affiche ou masque les commandes du test (masquées sur l'écran de résultat).
        function testSetExtraControls(visible) {
            ['test-star-btn', 'test-known-btn'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = visible ? '' : 'none';
            });
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
            testSetExtraControls(false);
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
            // Mots maîtrisés en exercice OU actifs à l'oral (dits dans plusieurs conversations).
            const masteredVocab = vocabItems.filter(i => isMasteredAnyDirection(i.id) || isActiveWord(i.id)).length;
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
            'Expressions courantes': ['THEME_BASE', 'PHRASES_LABO', 'EXPRESSIONS_NL', 'LOCUTIONS_NL'],
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
            const helpRow = document.getElementById('rp-help-row');
            if (helpRow) helpRow.style.display = 'none';

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
                   <button class="btn btn-gray" onclick="showProfilSettings()">Configurer dans Profil</button>
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
                // La dictée suit la langue du scénario (une dictée en français de l'aide ou la
                // Production orale ont pu la changer entre-temps).
                rpRecognition.lang = (rpCurrentScenario && rpCurrentScenario.lang === 'en') ? 'en-US' : 'nl-NL';
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
        function productionToggleVoiceCapture(btnId, statusId, onFinalTranscript, lang) {
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
            rpRecognition.lang = lang || 'nl-NL';
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
            if (btn) { btn.classList.remove('recording'); btn.innerText = activeVoiceBtnId === 'rp-help-mic-btn' ? '🎤' : "🎤 Cliquer pour parler"; }
            const st = document.getElementById(activeVoiceStatusId);
            if (st) st.innerText = "Prêt";
        }

        function rpAppendMessage(text, sender) {
            const historyDiv = document.getElementById('rp-chat-history');
            const msgDiv = document.createElement('div');
            msgDiv.className = `rp-message ${sender}`;
            // Répliques de l'interlocuteur en néerlandais : mots cliquables, inconnus soulignés.
            if (sender === 'assistant' && !(rpCurrentScenario && rpCurrentScenario.lang === 'en')) {
                msgDiv.innerHTML = rpAnnotateText(text);
                msgDiv.dataset.text = text;
                rpWordSessionHear(text);
            } else {
                msgDiv.innerText = text;
            }
            historyDiv.appendChild(msgDiv);
            historyDiv.scrollTop = historyDiv.scrollHeight;
            return msgDiv;
        }

        // ===== Mots cliquables dans les répliques du jeu de rôle =====
        // L'app (pas Gemini) repère les mots que l'apprenant ne connaît pas encore : hors de son
        // vocabulaire (orange) ou déjà ratés en exercice (bleu) ; en option, aussi les mots jamais
        // travaillés. Un clic donne la traduction (vocabulaire, ou Gemini en contexte pour un mot
        // inconnu) et « ➕ À apprendre » l'ajoute à la liste RP_WORDS_LIST. Les mots inconnus de l'app
        // ajoutés ainsi vivent dans state.rpWords (synchronisé) et rejoignent fullDb au démarrage.
        const RP_WORDS_LIST = '🎭 Mots du jeu de rôle';
        const RP_WORDS_FILE = 'MOTS_JEU_DE_ROLE';
        let rpWordIdxCache = null;

        // Formes fléchies probables d'un nom / adjectif (pluriel, -e, comparatif) : sans
        // lemmatiseur dans le navigateur, on couvre les règles d'orthographe courantes.
        function rpInflections(w) {
            const out = [w, w + 'en', w + 's', w + "'s", w + 'e', w + 'n', w + 'er', w + 'ste', w + 'st', w + 'ere'];
            const last = w.slice(-1);
            if (/[bdfgklmnprst]/.test(last) && /[aeiou][^aeiou]$/.test(w) && !/[aeiou]{2}[^aeiou]$/.test(w)) out.push(w + last + 'en', w + last + 'e', w + last + 'er');
            const m = w.match(/^(.*?)([aeou])\2([^aeiou])$/);
            if (m) { const s = m[1] + m[2] + m[3]; out.push(s + 'en', s + 'e', s + 'er'); }
            if (last === 'f') out.push(w.slice(0, -1) + 'ven', w.slice(0, -1) + 've');
            if (last === 's') out.push(w.slice(0, -1) + 'zen', w.slice(0, -1) + 'ze');
            if (m && m[3] === 'f') { const s = m[1] + m[2]; out.push(s + 'ven', s + 've'); }
            if (m && m[3] === 's') { const s = m[1] + m[2]; out.push(s + 'zen', s + 'ze'); }
            return out;
        }

        function rpWordIndex() {
            const key = fullDb.length + '|' + conjugationData.length;
            if (rpWordIdxCache && rpWordIdxCache.key === key) return rpWordIdxCache.idx;
            const idx = new Map();
            const add = (f, item) => { if (f && !idx.has(f)) idx.set(f, item); };
            const byNl = {};
            const bare = v => rpKitNorm(v).replace(/^(de|het|een|zich) /, '');
            // D'abord les entrées dont c'est la forme entière (« zijn »), puis les variantes d'une
            // entrée « a / b » (« aanwezig zijn / zijn ») : sinon la variante gagnait parfois.
            [true, false].forEach(exactPass => fullDb.forEach(i => {
                if (i.file === 'PHRASES_LABO') return;
                const variants = String(i.nl).split('/');
                if (exactPass && variants.length > 1) return;
                variants.forEach(v => {
                    const w = bare(v);
                    if (!w || w.includes(' ')) return;
                    if (!byNl[w]) byNl[w] = i;
                });
            }));
            // Les formes exactes d'abord, puis les verbes conjugués, puis les formes fléchies.
            Object.entries(byNl).forEach(([w, i]) => add(w, i));
            // Verbes simples d'abord : « ging » doit renvoyer à gaan, pas à doorgaan (« ging door »),
            // et « was » à zijn, pas à aanwezig zijn (« was aanwezig »).
            const isCompound = v => /\s/.test(v.infinitief) || /\s/.test(v.preteritum);
            // Puis du plus courant au plus rare : « was » = zijn plutôt que wassen.
            const byFreq = conjugationData.slice().sort((a, b) => (b.freq || 0) - (a.freq || 0));
            [false, true].forEach(compound => byFreq.filter(v => isCompound(v) === compound).forEach(v => {
                const item = byNl[rpKitNorm(v.infinitief).replace(/^zich /, '')] || { id: null, nl: v.infinitief, fr: v.fr, file: 'VERBES_NL' };
                const forms = [v.infinitief, v.preteritum, deriveImperfectumPluriel(v.preteritum), v.participePasse]
                    .concat(Object.values(v.present || {}));
                forms.forEach(f => String(f || '').split(' ').forEach(part => { const k = rpKitNorm(part); if (k.length > 1 && !['zich', 'me', 'je', 'ons'].includes(k)) add(k, item); }));
            }));
            Object.entries(byNl).forEach(([w, i]) => rpInflections(w).forEach(f => add(f, i)));
            rpWordIdxCache = { key, idx };
            return idx;
        }

        function rpWordLookup(token) {
            const k = rpKitNorm(token).replace(/^'+|'+$/g, '');
            return k ? (rpWordIndex().get(k) || null) : null;
        }

        function rpWordClass(token, item, sentenceStart) {
            const k = rpKitNorm(token);
            if (k.length <= 2) return '';
            if (!item) {
                // Nom propre probable (majuscule au milieu d'une phrase) : ni souligné ni signalé.
                if (!sentenceStart && /^[A-ZÀ-Ý]/.test(token)) return '';
                return 'rpw-new';
            }
            if (!item.id) return state.settings.rpUnderlineUnseen ? 'rpw-unseen' : '';
            const st = wordStatus(item.id);
            if (st === 'review') return 'rpw-review';
            if (st === 'unseen' && state.settings.rpUnderlineUnseen && (item.freq || 0) < 5.5) return 'rpw-unseen';
            return '';
        }

        function rpAnnotateText(text) {
            const parts = String(text).split(/([A-Za-zÀ-ÖØ-öø-ÿ'’]+(?:-[A-Za-zÀ-ÖØ-öø-ÿ]+)*)/);
            let sentenceStart = true;
            return parts.map((part, i) => {
                if (i % 2 === 0) {
                    if (/[.!?:]\s*$/.test(part) || (i === 0 && !part.trim())) sentenceStart = true;
                    return rpEscapeHtml(part);
                }
                const cls = rpWordClass(part, rpWordLookup(part), sentenceStart);
                sentenceStart = false;
                return `<span class="rpw ${cls}" onclick="rpWordTap(this)">${rpEscapeHtml(part)}</span>`;
            }).join('');
        }

        function rpWordsListIds() {
            if (!state.customLists[RP_WORDS_LIST]) state.customLists[RP_WORDS_LIST] = [];
            return state.customLists[RP_WORDS_LIST];
        }

        function rpWordAddToList(id) {
            const ids = rpWordsListIds();
            if (!ids.includes(id)) ids.push(id);
            save();
            renderCustomListsHome();
        }

        // Mots ajoutés pendant les jeux de rôle et absents du vocabulaire : rechargés au démarrage.
        function rpWordsInject() {
            Object.entries(state.rpWords || {}).forEach(([k, w]) => {
                const id = 'RPW:' + k;
                if (!fullDb.some(i => i.id === id)) fullDb.push({ id, fr: w.fr, nl: w.nl, freq: 3, file: RP_WORDS_FILE, tier: '', niveauCECR: '', sousCategorie: '' });
            });
        }

        function rpWordTap(el) {
            const token = el.textContent;
            const item = rpWordLookup(token);
            if (rpWordSession) rpWordSession.tapped.set(rpKitNorm(token), { token, item });
            const sentence = (el.closest('.rp-message') && el.closest('.rp-message').dataset.text) || '';
            const panel = document.getElementById('rp-coach-panel');
            panel.style.display = 'block';
            const listed = item && item.id && rpWordsListIds().includes(item.id);
            const statusTxt = item && item.id ? ({ unseen: 'jamais travaillé', review: 'à revoir (raté en exercice)', mastered: 'réussi', 'true-mastered': 'maîtrisé' }[wordStatus(item.id)]) : '';
            panel.innerHTML = `
                <div class="rp-coach-title">🔎 ${rpEscapeHtml(token)} ${speakBtnHtml(token)}</div>
                <div id="rpw-detail">${item
                    ? `<b>${rpEscapeHtml(item.nl)}</b> = ${rpEscapeHtml(item.fr)}${statusTxt ? `<div class="report-meta">Dans ton vocabulaire · ${statusTxt}</div>` : ''}`
                    : '<div class="report-meta">Ce mot n\'est pas encore dans ton vocabulaire.</div>'}</div>
                <div class="rp-help-actions" id="rpw-actions">
                    ${item && item.id
                        ? (listed ? '<span class="report-meta">✅ Déjà dans « ' + RP_WORDS_LIST + ' »</span>' : `<button type="button" class="rp-coach-btn" onclick="rpWordAddToList('${item.id.replace(/'/g, "\\'")}'); this.outerHTML='<span class=&quot;report-meta&quot;>✅ Ajouté à « ${RP_WORDS_LIST} »</span>'">➕ À apprendre</button>`)
                        : `<button type="button" class="rp-coach-btn" id="rpw-translate-btn">🇫🇷 Traduire</button>`}
                </div>`;
            const tBtn = document.getElementById('rpw-translate-btn');
            if (tBtn) tBtn.onclick = () => rpWordTranslate(token, sentence);
            panel.scrollIntoView({ block: 'nearest' });
        }

        async function rpWordTranslate(token, sentence) {
            const detail = document.getElementById('rpw-detail');
            const actions = document.getElementById('rpw-actions');
            if (!GeminiService.getKey()) { detail.innerText = 'Traduction : nécessite ta clé Gemini (Profil → 🤖 Intelligence IA).'; return; }
            detail.innerText = 'Traduction...';
            try {
                const raw = await GeminiService.generate(
                    'Dans cette phrase néerlandaise : """' + sentence + '"""\nle mot "' + token + '" : donne sa forme de base (infinitif pour un verbe, singulier avec de/het pour un nom, forme simple pour un adjectif) et sa traduction française dans ce contexte, en quelques mots.\n' +
                    'Réponds UNIQUEMENT en JSON : {"base":"...","fr":"..."}'
                );
                const obj = rpHelpParseJson(raw);
                if (!obj || !obj.base || !obj.fr) throw new Error('réponse illisible');
                const base = String(obj.base).trim(), fr = String(obj.fr).trim();
                detail.innerHTML = `<b>${rpEscapeHtml(base)}</b> = ${rpEscapeHtml(fr)}`;
                const existing = rpWordLookup(base.replace(/^(de|het|een) /i, ''));
                actions.innerHTML = '';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'rp-coach-btn';
                btn.innerText = '➕ À apprendre';
                btn.onclick = () => {
                    let id = existing && existing.id;
                    if (!id) {
                        const k = rpKitNorm(base);
                        if (!state.rpWords) state.rpWords = {};
                        state.rpWords[k] = { nl: base, fr, at: Date.now() };
                        rpWordsInject();
                        id = 'RPW:' + k;
                    }
                    rpWordAddToList(id);
                    actions.innerHTML = `<span class="report-meta">✅ Ajouté à « ${RP_WORDS_LIST} »</span>`;
                };
                actions.appendChild(btn);
            } catch (e) {
                detail.innerText = 'Traduction impossible : ' + e.message;
            }
        }

        // ===== Bilan des mots d'une partie (relié au kit) =====
        // Calculé par l'app, sans Gemini : mots du kit utilisés / évités dans les répliques de
        // l'apprenant, mots consultés (touchés), mots nouveaux entendus. Une journée type cumule
        // toutes ses situations (la session n'est pas remise à zéro entre deux situations).
        let rpWordSession = null; // { kitKey, userTexts: [], tapped: Map, heardNew: Map }

        function rpWordSessionStart(scenario) {
            if (rpDayState && rpDayState.index > 0 && rpWordSession) return; // suite d'une journée
            const id = String(scenario.id || '');
            let kitKey = null;
            if (rpDayState && rpDayState.journeeId) kitKey = 'day:' + rpDayState.journeeId;
            else if (id.startsWith('reel_')) kitKey = 'bank:' + id.slice(5);
            else if (id.startsWith('job_')) kitKey = 'sit:' + id.slice(4);
            else if (id.startsWith('lib_')) kitKey = 'lib:' + id.slice(4);
            else if (id.startsWith('mod_')) { const [mid, et] = id.slice(4).split('__'); kitKey = et === 'final' ? 'mod:' + mid : 'mod:' + mid + ':' + et; }
            else if (id) kitKey = 'rp:' + id;
            if (kitKey && !rpHasKit(kitKey)) kitKey = null;
            rpWordSession = { kitKey, label: rpDayState ? rpDayState.label : scenario.label, userTexts: [], tapped: new Map(), heardNew: new Map() };
        }

        // Mots orange d'une réplique de l'interlocuteur, gardés avec leur phrase (contexte de traduction).
        function rpWordSessionHear(text) {
            if (!rpWordSession) return;
            const tokens = String(text).match(/[A-Za-zÀ-ÖØ-öø-ÿ'’]+(?:-[A-Za-zÀ-ÖØ-öø-ÿ]+)*/g) || [];
            tokens.forEach((t, i) => {
                const k = rpKitNorm(t);
                if (k.length <= 2 || rpWordSession.heardNew.has(k)) return;
                if (rpWordClass(t, rpWordLookup(t), i === 0) === 'rpw-new') rpWordSession.heardNew.set(k, { token: t, sentence: text });
            });
        }

        function rpWordBase(nl) { return rpKitNorm(nl).replace(/^(de|het|een|zich) /, ''); }

        function rpWordsReport() {
            const ses = rpWordSession;
            if (!ses) return null;
            const allText = ses.userTexts.join(' ');
            const userNorm = ' ' + rpKitNorm(allText) + ' ';
            const usedBases = new Set();
            (allText.match(/[A-Za-zÀ-ÖØ-öø-ÿ'’]+/g) || []).forEach(t => { const it = rpWordLookup(t); if (it) usedBases.add(rpWordBase(it.nl)); });
            const isUsed = nl => { const b = rpWordBase(nl); return usedBases.has(b) || userNorm.includes(' ' + b + ' '); };
            let kit = null, used = [], avoided = [];
            if (ses.kitKey) {
                kit = rpBuildKit(ses.kitKey);
                const entries = kit.verbs.map(v => ({ nl: v.inf, fr: v.conj ? v.conj.fr : (v.item ? v.item.fr : ''), item: v.item }))
                    .concat(kit.words.map(w => ({ nl: w.nl, fr: w.fr, item: w.item })));
                entries.forEach(e => (isUsed(e.nl) ? used : avoided).push(e));
            }
            const tapped = [...ses.tapped.values()];
            const tappedKeys = new Set(tapped.map(t => rpKitNorm(t.token)));
            const heard = [...ses.heardNew.entries()].filter(([k]) => !tappedKeys.has(k)).map(([, v]) => v);
            return { kit, used, avoided, tapped, heard, spoke: ses.userTexts.length };
        }

        function rpWordsReportHtml() {
            const r = rpWordsReport();
            if (!r) return '';
            const chip = e => `<span class="rpw-chip">${rpEscapeHtml(e.nl)}${e.fr ? ' <small>' + rpEscapeHtml(e.fr) + '</small>' : ''}</span>`;
            const toLearn = r.avoided.concat(r.tapped.filter(t => t.item && t.item.id).map(t => ({ nl: t.item.nl, fr: t.item.fr, item: t.item })));
            const ids = [...new Set(toLearn.filter(e => e.item && e.item.id).map(e => e.item.id))];
            const heardHtml = r.heard.map(h => `<span class="rp-message assistant rpw-inline" data-text="${rpEscapeHtml(h.sentence)}"><span class="rpw rpw-new" onclick="rpWordTap(this)">${rpEscapeHtml(h.token)}</span></span>`).join(' ');
            return `
                <div class="rp-coach-title">🧾 Bilan des mots${rpWordSession.label ? ' — ' + rpEscapeHtml(rpWordSession.label) : ''}</div>
                ${!r.spoke ? '<p class="report-meta">Tu n\'as encore rien répondu : le bilan se remplit au fil de tes réponses.</p>' : ''}
                ${r.kit ? `
                    <div class="rp-iv-label">✅ Mots du kit que tu as utilisés (${r.used.length}/${r.used.length + r.avoided.length})</div>
                    <div class="rpw-chips">${r.used.map(chip).join('') || '<span class="report-meta">Aucun pour l\'instant.</span>'}</div>
                    <div class="rp-iv-label">🙈 Mots du kit pas encore utilisés (${r.avoided.length})</div>
                    <div class="rpw-chips">${r.avoided.map(chip).join('') || '<span class="report-meta">Tu as tout utilisé, bravo !</span>'}</div>`
                    : '<p class="report-meta">Pas de kit de préparation pour ce jeu de rôle : seuls les mots consultés et entendus sont listés.</p>'}
                <div class="rp-iv-label">🔎 Mots que tu as consultés (${r.tapped.length})</div>
                <div class="rpw-chips">${r.tapped.map(t => chip(t.item ? { nl: t.item.nl, fr: t.item.fr } : { nl: t.token, fr: '' })).join('') || '<span class="report-meta">Aucun.</span>'}</div>
                <div class="rp-iv-label">🆕 Mots nouveaux entendus (${r.heard.length}) — touche-les pour les traduire</div>
                <div class="rpw-chips">${heardHtml || '<span class="report-meta">Aucun.</span>'}</div>
                ${ids.length ? `<div class="rp-help-actions" style="margin-top:10px;">
                    <button type="button" class="rp-coach-btn" onclick="rpWordsAddMany(${rpEscapeHtml(JSON.stringify(ids))}, this)">➕ Mettre les ${ids.length} mots évités et consultés à apprendre</button>
                </div>` : ''}
                ${(state.customLists[RP_WORDS_LIST] || []).length ? `<div class="rp-help-actions"><button type="button" class="rp-coach-btn" onclick="startCustomList('${RP_WORDS_LIST}')">📝 Réviser « ${RP_WORDS_LIST} » (${state.customLists[RP_WORDS_LIST].length})</button></div>` : ''}`;
        }

        function rpWordsAddMany(ids, btn) {
            const list = rpWordsListIds();
            ids.forEach(id => { if (!list.includes(id)) list.push(id); });
            save();
            renderCustomListsHome();
            if (btn) btn.outerHTML = `<span class="report-meta">✅ Ajoutés à « ${RP_WORDS_LIST} » (${list.length} mots)</span>`;
        }

        function rpShowWordsReport() {
            const panel = document.getElementById('rp-coach-panel');
            panel.style.display = 'block';
            panel.innerHTML = rpWordsReportHtml() || '<p class="report-meta">Lance une conversation d\'abord.</p>';
            panel.scrollIntoView({ block: 'nearest' });
        }

        function rpToggleUnderlineUnseen() {
            state.settings.rpUnderlineUnseen = !state.settings.rpUnderlineUnseen;
            save();
            document.querySelectorAll('#rp-chat-history .rp-message.assistant[data-text]').forEach(m => { m.innerHTML = rpAnnotateText(m.dataset.text); });
            rpShowUnderlineHelp();
        }

        function rpShowUnderlineHelp() {
            const panel = document.getElementById('rp-coach-panel');
            panel.style.display = 'block';
            const on = !!state.settings.rpUnderlineUnseen;
            panel.innerHTML = `
                <div class="rp-coach-title">🔍 Mots soulignés</div>
                <div class="rp-coach-body">Touche n'importe quel mot de ton interlocuteur pour sa traduction.
<span class="rpw rpw-new">orange</span> : pas encore dans ton vocabulaire.
<span class="rpw rpw-review">bleu</span> : dans ton vocabulaire, raté en exercice.${on ? '\n<span class="rpw rpw-unseen">gris</span> : dans ton vocabulaire, jamais travaillé.' : ''}
« ➕ À apprendre » les met dans la liste « ${RP_WORDS_LIST} » (Vocabulaire → Mes listes).</div>
                <div class="rp-help-actions"><button type="button" class="rp-coach-btn" onclick="rpToggleUnderlineUnseen()">${on ? '✓ ' : ''}Souligner aussi les mots jamais travaillés</button></div>`;
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

        // Pratiquer n'a plus que deux entrées : Discuter (dont la vie courante) et « Mon travail »
        // (groupe 'travail' : entretiens + métier). Les anciens groupes 'entretiens' et
        // 'quotidien' sont redirigés.
        let rpCurrentGroup = null;
        function showRoleplay(group) {
            if (group === 'quotidien') { showTalk(); return; }
            if (group === 'entretiens') group = 'travail';
            const lbl = document.getElementById('rp-metier-label');
            const m = state.settings && state.settings.jobMetier;
            if (lbl) lbl.innerText = m && RP_JOB_METIERS[m] ? 'Au travail · ' + RP_JOB_METIERS[m].replace(/^\S+\s/, '') : 'Au travail : choisis ton métier';
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('roleplay-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            rpCurrentGroup = group || null;

            renderRpGeminiStatus();
            rpCheckDutchVoice();

            rpShowCategoryPicker();
        }

        // Bouton retour de la liste de scénarios : revient au choix de catégorie du groupe, ou à
        // Pratiquer quand le groupe n'a qu'une entrée (sinon on retomberait sur une carte unique).
        function rpBackFromScenarioList() {
            if (rpCurrentCategory === '__lib:travail') rpShowJobHome();
            else rpShowCategoryPicker();
        }

        function rpShowCategoryPicker() {
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            rpIvState = null;
            rpDayState = null;
            rpCaseState = null;
            rpHideInterviewer();
            rpJobHideDebrief();
            document.querySelectorAll('#rp-step-category .rp-group').forEach(g => {
                g.style.display = (!rpCurrentGroup || g.dataset.rpGroup === rpCurrentGroup) ? '' : 'none';
            });
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
                        html += rpPrepRow(`<button class="rp-scenario-btn" onclick="rpStartScenario('${catKey}','${item.id}')">${item.label}</button>`, 'rp:' + item.id, group.title.replace(/^\S+\s/, '') + ' — ' + item.label.replace(/^\S+\s/, ''), { type: 'rp', cat: catKey, id: item.id });
                    });
                });
            } else {
                cat.items.forEach(item => {
                    html += rpPrepRow(`<button class="rp-scenario-btn" onclick="rpStartScenario('${catKey}','${item.id}')">${item.label}</button>`, 'rp:' + item.id, item.label, { type: 'rp', cat: catKey, id: item.id });
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
            } else if (rpCurrentCategory && rpCurrentCategory.startsWith('__mod:')) {
                showModuleRp(rpCurrentCategory.slice(6));
            } else if (rpCurrentCategory && rpCurrentCategory.startsWith('__lib:')) {
                rpShowLibrary(rpCurrentCategory.slice(6));
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
            rpWordSessionStart(scenario);
            rpConversationHistory = [{ role: "model", parts: [{ text: scenario.prompt }] }];

            // Réinitialise le mode script à chaque nouveau scénario (jamais hérité de la
            // conversation précédente) — bannière, choix et micro repartent de l'état par défaut.
            rpScriptedActive = false;
            rpScriptedStepIndex = 0;
            const micBtn = document.getElementById('rp-mic-btn');
            if (micBtn) micBtn.style.display = '';
            const textRow = document.getElementById('rp-text-row');
            if (textRow) textRow.style.display = 'flex';
            const helpRow = document.getElementById('rp-help-row');
            if (helpRow) helpRow.style.display = 'flex';
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
        function rpAppendUserTurn(text) {
            const msgDiv = rpAppendMessage(text, 'user');
            if (rpWordSession) rpWordSession.userTexts.push(text);
            // Examen de module : après quelques échanges, le bouton « J'ai fini » ressort.
            const finishBtn = document.getElementById('modrp-finish-btn');
            if (finishBtn && rpWordSession && rpWordSession.userTexts.length >= 4) { finishBtn.classList.remove('btn-gray'); finishBtn.classList.add('btn-green'); }
            const historyDiv = document.getElementById('rp-chat-history');
            // Correction active (néerlandais seulement) : sous la bulle ; sinon bouton « Corrige-moi ».
            if (liveCorrectOn() && GeminiService.isAvailable() && !(rpCurrentScenario && rpCurrentScenario.lang === 'en')) {
                const prevMsgs = historyDiv.querySelectorAll('.rp-message.assistant');
                const prevMsg = prevMsgs.length ? prevMsgs[prevMsgs.length - 1] : null;
                liveCorrectUnder(msgDiv, text, null, prevMsg ? (prevMsg.dataset.text || prevMsg.innerText) : '').then(c => { usedWordsRecord(text, c); historyDiv.scrollTop = historyDiv.scrollHeight; });
                return;
            }
            if (!(rpCurrentScenario && rpCurrentScenario.lang === 'en')) usedWordsRecord(text);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rp-coach-btn';
            btn.innerText = '✍️ Corrige-moi';
            btn.onclick = () => rpCoachCorrect(text);
            historyDiv.appendChild(btn);
            historyDiv.scrollTop = historyDiv.scrollHeight;
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

        // ----- Aide pendant la conversation : "Je ne sais pas quoi dire" / "Je le dis en français" -----
        // Quatrième usage de Gemini, lui aussi séparé des trois autres : un souffleur. Il voit la
        // fin de la conversation (pour proposer une réponse qui colle) mais ne parle jamais à la
        // place de l'apprenant : la phrase proposée est placée dans la zone de texte, à lui de la
        // dire ou de l'envoyer. Affichage dans le même encart que la correction.
        function rpHelpAvailable() {
            if (!rpCurrentScenario || rpScriptedActive) return false;
            if (!GeminiService.getKey()) {
                alert("Renseigne d'abord ta clé API Gemini dans Profil → 🤖 Intelligence IA.");
                return false;
            }
            return true;
        }

        function rpHelpOpenPanel(titleText) {
            const panel = document.getElementById('rp-coach-panel');
            panel.style.display = 'block';
            panel.innerHTML = '';
            const title = document.createElement('div');
            title.className = 'rp-coach-title';
            title.innerText = titleText;
            const body = document.createElement('div');
            body.className = 'rp-help-body';
            panel.append(title, body);
            return body;
        }

        // Les derniers échanges, sans le prompt de rôle (premier élément de l'historique).
        function rpHelpTranscript() {
            const turns = rpConversationHistory.slice(1).slice(-6);
            const lines = turns.map(t => (t.role === 'user' ? 'Apprenant : ' : 'Interlocuteur : ') + t.parts[0].text);
            if (rpConversationHistory.length <= 1 && rpCurrentScenario.welcome) lines.push('Interlocuteur : ' + rpCurrentScenario.welcome);
            return lines.join('\n');
        }

        function rpHelpParseJson(text) {
            const m = String(text).match(/[\[{][\s\S]*[\]}]/);
            if (!m) return null;
            try { return JSON.parse(m[0]); } catch (e) { return null; }
        }

        function rpHelpPhraseCard(phrase, fr) {
            const card = document.createElement('div');
            card.className = 'rp-help-card';
            const main = document.createElement('div');
            main.className = 'rp-help-phrase';
            main.innerText = phrase;
            card.appendChild(main);
            if (fr) {
                const sub = document.createElement('div');
                sub.className = 'rp-help-fr';
                sub.innerText = fr;
                card.appendChild(sub);
            }
            const actions = document.createElement('div');
            actions.className = 'rp-help-actions';
            const listen = document.createElement('button');
            listen.type = 'button';
            listen.className = 'rp-coach-btn';
            listen.innerText = '🔊 Écouter';
            listen.onclick = () => rpSpeakText(phrase);
            const use = document.createElement('button');
            use.type = 'button';
            use.className = 'rp-coach-btn';
            use.innerText = '✏️ Mettre dans ma réponse';
            use.onclick = () => {
                const input = document.getElementById('rp-text-input');
                input.value = phrase;
                input.focus();
            };
            actions.append(listen, use);
            card.appendChild(actions);
            return card;
        }

        async function rpHelpSuggest() {
            if (!rpHelpAvailable()) return;
            const body = rpHelpOpenPanel('💡 Ce que tu pourrais dire');
            body.innerText = 'Je cherche des idées...';
            const langName = RP_LANG_NAMES[rpCurrentScenario.lang || 'nl'];
            try {
                const raw = await GeminiService.generate(
                    'Tu es le souffleur d\'un francophone qui apprend le ' + langName + ' et s\'exerce dans un jeu de rôle. Situation : ' + rpCurrentScenario.label + '.\n' +
                    'Derniers échanges :\n"""' + rpHelpTranscript() + '"""\n\n' +
                    'Il ne sait pas quoi répondre à la dernière réplique de son interlocuteur. Propose 3 réponses possibles en ' + langName + ', différentes par leur contenu (pas trois variantes de la même phrase), courtes (1 à 2 phrases), naturelles à l\'oral, niveau A2-B1. ' +
                    'N\'invente pas de faits précis sur sa vie : reste général ou laisse un blanc entre crochets.\n' +
                    'Réponds UNIQUEMENT par un tableau JSON, sans texte autour : [{"phrase":"réponse en ' + langName + '","fr":"traduction française"}]'
                );
                const list = rpHelpParseJson(raw);
                body.innerHTML = '';
                if (Array.isArray(list) && list.length) {
                    list.slice(0, 3).forEach(s => { if (s && s.phrase) body.appendChild(rpHelpPhraseCard(String(s.phrase), s.fr ? String(s.fr) : '')); });
                }
                if (!body.children.length) body.innerText = stripMarkdown(raw);
            } catch (e) {
                body.innerText = 'Aide impossible : ' + e.message;
            }
            document.getElementById('rp-coach-panel').scrollIntoView({ block: 'nearest' });
        }

        function rpHelpFrench() {
            if (!rpHelpAvailable()) return;
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            const langName = RP_LANG_NAMES[rpCurrentScenario.lang || 'nl'];
            const body = rpHelpOpenPanel('🇫🇷 Dis-le en français, je te donne le ' + langName);
            const row = document.createElement('div');
            row.className = 'rp-help-input-row';
            const input = document.createElement('input');
            input.type = 'text';
            input.id = 'rp-help-fr-input';
            input.placeholder = 'Ce que tu veux dire, en français';
            input.autocomplete = 'off';
            input.onkeypress = (ev) => { if (ev.key === 'Enter') rpHelpTranslate(); };
            const mic = document.createElement('button');
            mic.type = 'button';
            mic.id = 'rp-help-mic-btn';
            mic.className = 'btn';
            mic.innerText = '🎤';
            mic.onclick = rpHelpFrenchDictate;
            const go = document.createElement('button');
            go.type = 'button';
            go.className = 'btn btn-green';
            go.innerText = 'Traduire';
            go.onclick = rpHelpTranslate;
            row.append(input, mic, go);
            const status = document.createElement('div');
            status.id = 'rp-help-status';
            status.className = 'rp-help-fr';
            const result = document.createElement('div');
            result.id = 'rp-help-result';
            body.append(row, status, result);
            document.getElementById('rp-coach-panel').scrollIntoView({ block: 'nearest' });
            input.focus();
        }

        // Dictée en français : même moteur de reconnaissance, langue changée le temps de la
        // capture (rpToggleSpeechRecognition remet la langue du scénario à chaque écoute).
        function rpHelpFrenchDictate() {
            const wasRecording = rpIsRecording;
            productionToggleVoiceCapture('rp-help-mic-btn', 'rp-help-status', (text) => {
                const input = document.getElementById('rp-help-fr-input');
                if (!input) return;
                input.value = text;
                rpHelpTranslate();
            }, 'fr-FR');
            const mic = document.getElementById('rp-help-mic-btn');
            const status = document.getElementById('rp-help-status');
            if (!wasRecording && rpIsRecording) {
                if (mic) mic.innerText = '🛑';
                if (status) status.innerText = 'Parle en français...';
            }
        }

        async function rpHelpTranslate() {
            const input = document.getElementById('rp-help-fr-input');
            const result = document.getElementById('rp-help-result');
            const status = document.getElementById('rp-help-status');
            const mic = document.getElementById('rp-help-mic-btn');
            if (mic) mic.innerText = '🎤'; // rpStopRecordingUI y remet le libellé long du micro principal
            if (!input || !result) return;
            const text = input.value.trim();
            if (!text) return;
            const langName = RP_LANG_NAMES[rpCurrentScenario.lang || 'nl'];
            if (status) status.innerText = 'Traduction...';
            result.innerHTML = '';
            try {
                const raw = await GeminiService.generate(
                    'Un francophone qui apprend le ' + langName + ' s\'exerce dans un jeu de rôle. Situation : ' + rpCurrentScenario.label + '.\n' +
                    'Derniers échanges :\n"""' + rpHelpTranscript() + '"""\n\n' +
                    'Il veut répondre ceci, qu\'il a formulé en français : """' + text + '"""\n' +
                    'Donne la façon naturelle de le dire en ' + langName + ', à l\'oral, avec le registre qui convient à la situation, sans rien ajouter à son idée. ' +
                    'Ajoute une remarque d\'une phrase en français sur LE mot ou la tournure à retenir.\n' +
                    'Réponds UNIQUEMENT en JSON, sans texte autour : {"phrase":"...","note":"..."}'
                );
                const obj = rpHelpParseJson(raw);
                if (status) status.innerText = '';
                if (obj && obj.phrase) result.appendChild(rpHelpPhraseCard(String(obj.phrase), obj.note ? '💬 ' + String(obj.note) : ''));
                else result.innerText = stripMarkdown(raw);
            } catch (e) {
                if (status) status.innerText = 'Traduction impossible : ' + e.message;
            }
            document.getElementById('rp-coach-panel').scrollIntoView({ block: 'nearest' });
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
        const rpExampleTag = sc => sc.exemple ? ' <span class="wl-badge review">exemple à remplacer</span>'
            : (sc._source === 'redige_claude' ? ' <span class="wl-badge unseen">questions types</span>' : '');

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
            const known = RP_QUESTION_TYPES.map(t => t[0]).concat(['_tirage']);
            const sections = RP_QUESTION_TYPES.slice(0, 1).concat([['_tirage', 'Questions de cet entretien (dans un ordre naturel)']], RP_QUESTION_TYPES.slice(1))
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
                (bank._source === 'redige_claude' ? 'Voici des questions typiques de ce type d\'entretien' : 'Voici les questions réellement posées dans ce type d\'entretien') + ', classées par moment de l\'entretien. Suis cet ordre approximativement, sans le réciter : reformule librement, saute ce qui a déjà été abordé, et rebondis sur ce que le candidat vient de dire avec des relances improvisées avant de passer à la question suivante. ' +
                (bank._source === 'redige_claude' ? 'Les passages entre crochets comme [plaats] sont des blancs à remplacer par un détail plausible.\n\n' : 'Ces questions viennent d\'une transcription orale : certaines sont coupées en fin de phrase (complète-les naturellement) et les passages entre crochets comme [plaats] sont des blancs à remplacer par un détail plausible.\n\n') +
                sections + '\n\n' +
                (Array.isArray(bank.vocabulaire) && bank.vocabulaire.length
                    ? 'Le candidat révise le vocabulaire du poste : emploie naturellement ces mots dans tes questions et tes relances, surtout pour parler des tâches concrètes : ' + bank.vocabulaire.join(', ') + '.\n\n'
                    : '') +
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
            listDiv.innerHTML = '<div class="rp-group-title">🎯 Je suis candidat — entretiens</div>' +
                '<p class="rp-real-hint">Le recruteur pose les questions de vrais entretiens (ou des questions types du métier) et improvise ses relances selon tes réponses.</p>' +
                `<button class="rp-scenario-btn rp-profile-btn" onclick="rpEditCandidateProfile()">📄 Mon profil de candidat <small>(privé : ${(state.candidateProfile || '').trim() ? 'rempli' : 'à remplir'})</small></button>` +
                (banks.length
                    ? banks.map((b, i) => rpPrepRow(`<button class="rp-scenario-btn" onclick="rpRealSetup(${i})">${rpEscapeHtml(b.label)}${rpBankLang(b) === 'en' ? ' <span class="wl-badge unseen">🇬🇧 en anglais</span>' : ''}${rpExampleTag(b)}</button>`, 'bank:' + b.id, b.label, { type: 'bank', index: i })).join('')
                    : '<p style="color:#888;">Aucun scénario réel pour l\'instant.</p>');
        }

        // ----- Profil de candidat (privé) et préparation d'un entretien -----
        // Le profil (CV, parcours) et les « points de vigilance » propres à un entretien vivent
        // dans la progression de l'utilisateur (state.candidateProfile, state.candidateNotes) :
        // jamais dans les fichiers du dépôt public. Le profil est donné au recruteur (il connaît
        // le CV) ; les points de vigilance ne servent qu'au bilan.
        const RP_DIFFICULTY_LABELS = { facile: '🟢 Facile', moyen: '🟡 Moyen', difficile: '🔴 Difficile' };

        function rpEditCandidateProfile() {
            document.getElementById('rp-scenario-list').innerHTML = `
                <button class="back-btn" onclick="rpShowRealCandidateList()">← Entretiens</button>
                <div class="rp-group-title">📄 Mon profil de candidat</div>
                <p class="rp-real-hint">Ce que le recruteur peut savoir de toi, comme s'il avait ton CV : âge, ville, études, expériences, langues, formations. Écris-le en français ou en néerlandais. C'est privé : enregistré dans ton compte uniquement, jamais publié.</p>
                <textarea id="rp-profile-text" class="rp-profile-text" rows="12" placeholder="Ex. : 30 ans, habite à … Études : … Expériences : … Langues : …">${rpEscapeHtml(state.candidateProfile || '')}</textarea>
                <button class="btn btn-green" onclick="state.candidateProfile = document.getElementById('rp-profile-text').value; save(); rpShowRealCandidateList();">💾 Enregistrer</button>`;
        }

        function rpRealSetup(index) {
            const bank = rpRealData && rpRealData.banks[index];
            if (!bank) return;
            if (!state.settings.rpDifficulty) state.settings.rpDifficulty = {};
            const diff = bank.difficultes ? (state.settings.rpDifficulty[bank.id] || 'moyen') : null;
            const notes = (state.candidateNotes || {})[bank.id] || '';
            const chip = (on, click, label) => `<button type="button" class="conj-filter-chip${on ? ' active' : ''}" onclick="${click}">${label}</button>`;
            document.getElementById('rp-scenario-list').innerHTML = `
                <button class="back-btn" onclick="rpShowRealCandidateList()">← Entretiens</button>
                <div class="rp-group-title">${rpEscapeHtml(bank.label)}</div>
                ${bank.poste ? `<p class="rp-real-hint">${rpEscapeHtml(bank.poste)}</p>` : ''}
                ${diff ? `<div class="rp-job-canal">Difficulté</div><div class="conj-filter-chips-row" style="width:100%; max-width:520px;">${Object.keys(bank.difficultes).map(k => chip(k === diff, `state.settings.rpDifficulty['${bank.id}']='${k}'; save(); rpRealSetup(${index})`, RP_DIFFICULTY_LABELS[k] || k)).join('')}</div>
                    <p class="rp-real-hint">${rpEscapeHtml(bank.difficultes[diff])}</p>` : ''}
                <div class="rp-job-canal">Mon profil</div>
                <p class="rp-real-hint">${(state.candidateProfile || '').trim() ? '✅ Le recruteur connaît ton profil (ton CV).' : '⚠️ Profil vide : le recruteur ne sait rien de toi.'} <a href="#" onclick="rpEditCandidateProfile(); return false;">Modifier</a></p>
                <div class="rp-job-canal">Mes points de vigilance pour cet entretien (privé)</div>
                <p class="rp-real-hint">Ce que tu dois dire ou ne surtout pas dire (ex. « ne pas dire que je suis déjà des cours »). Le recruteur ne les voit pas : ils servent au bilan.</p>
                <textarea id="rp-notes-text" class="rp-profile-text" rows="5">${rpEscapeHtml(notes)}</textarea>
                <button class="btn btn-green" style="max-width:520px;" onclick="rpRealSaveNotes('${bank.id}'); rpStartRealCandidate(${index})">▶️ Commencer l'entretien</button>`;
        }

        function rpRealSaveNotes(bankId) {
            const el = document.getElementById('rp-notes-text');
            if (!el) return;
            if (!state.candidateNotes) state.candidateNotes = {};
            state.candidateNotes[bankId] = el.value;
            save();
        }

        // Tirage des questions (champ « tirage » d'une banque) : l'accroche et la clôture restent,
        // les autres sont tirées au hasard et leur ordre varie, pour que deux entretiens diffèrent.
        function rpSampleBank(bank) {
            if (!bank.tirage) return bank;
            const q = bank.questions || {};
            const first = (q.accroche || []).slice(0, 1), last = (q.cloture || []).slice(0, 1);
            const pool = [];
            Object.keys(q).forEach(type => (q[type] || []).forEach(text => {
                if (first.includes(text) || last.includes(text)) return;
                pool.push({ type, text });
            }));
            pool.sort(() => Math.random() - 0.5);
            const min = bank.tirage.min || 8, max = bank.tirage.max || 12;
            const n = Math.max(0, Math.min(pool.length, min + Math.floor(Math.random() * (max - min + 1))) - first.length - last.length);
            const chosen = pool.slice(0, n);
            const out = { accroche: first };
            chosen.forEach(x => { (out['_tirage'] = out['_tirage'] || []).push(x.text); });
            out.cloture = last;
            return Object.assign({}, bank, { questions: out });
        }

        function rpStartRealCandidate(index) {
            const bank = rpRealData && rpRealData.banks[index];
            if (!bank) return;
            const firstQuestion = ((bank.questions || {}).accroche || [])[0];
            const welcome = bank.welcome || firstQuestion || 'Goedendag, fijn dat u er bent. Kunt u zich eerst even kort voorstellen?';
            const diff = bank.difficultes ? ((state.settings.rpDifficulty || {})[bank.id] || 'moyen') : null;
            const profile = (state.candidateProfile || '').trim();
            rpDayState = null;
            rpBeginScenario({
                id: 'reel_' + bank.id,
                lang: rpBankLang(bank),
                label: bank.label,
                welcome,
                // La phrase d'accueil est affichée par l'app, pas générée : on la signale au
                // recruteur pour qu'il enchaîne au lieu de se présenter une deuxième fois.
                prompt: rpBuildRecruiterPrompt(rpSampleBank(bank)) +
                    (bank.tirage ? '\n\nLes questions ci-dessus ont été tirées au hasard pour cet entretien : pose-les dans un ordre naturel, une à la fois.' : '') +
                    (diff ? '\n\nDifficulté de cet entretien : ' + bank.difficultes[diff] : '') +
                    (profile ? '\n\nCe que tu sais du candidat (son CV et son parcours) : ' + profile + '\nUtilise-le pour poser des questions précises sur son parcours, sans jamais réciter ses réponses à sa place.' : '') +
                    '\n\nTu as déjà ouvert l\'entretien en disant : """' + welcome + '""" — enchaîne à partir de la réponse du candidat, sans te présenter à nouveau.'
            });
            rpRealInterview = { index, bank, diff };
            const nav = document.getElementById('rp-day-nav');
            nav.style.display = 'block';
            nav.innerHTML = `<button class="btn btn-gray" style="margin:0;" onclick="rpInterviewDebrief()">🏁 Fin de l'entretien : mon bilan</button>`;
            // Pense-bête affiché pendant l'entretien : mots du poste et phrases de secours.
            const vocab = Array.isArray(bank.vocabulaire) ? bank.vocabulaire : [];
            const bequilles = Array.isArray(bank.bequilles) ? bank.bequilles : [];
            if (vocab.length || bequilles.length) {
                const banner = document.getElementById('rp-mode-banner');
                banner.style.display = '';
                banner.innerHTML = `
                    <div class="rp-job-banner">
                        ${vocab.length ? `<details><summary>📝 Mots du poste (${vocab.length})</summary><div class="rp-bank-vocab">${vocab.map(rpEscapeHtml).join(' · ')}</div></details>` : ''}
                        ${bequilles.length ? `<details><summary>🛟 Phrases de secours</summary><ul class="rp-case-figures">${bequilles.map(b => `<li>${rpEscapeHtml(b)}</li>`).join('')}</ul></details>` : ''}
                    </div>`;
            }
        }

        // ----- Bilan d'un entretien (mode Candidat) -----
        // Appel Gemini séparé du recruteur : il reçoit la transcription, les critères de la banque,
        // les erreurs déjà commises en vrai et les points de vigilance privés du candidat.
        let rpRealInterview = null; // { index, bank, diff }

        async function rpInterviewDebrief() {
            const it = rpRealInterview;
            if (!it) return;
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            const bank = it.bank;
            rpJobHideNav();
            document.getElementById('rp-step-chat').style.display = 'none';
            document.getElementById('rp-step-debrief').style.display = 'flex';
            rpFillDebriefWords();
            const box = document.getElementById('rp-debrief-content');
            const header = `<div class="conj-verb-title">🏁 Bilan — ${rpEscapeHtml(bank.label)}${it.diff ? ' · ' + (RP_DIFFICULTY_LABELS[it.diff] || it.diff) : ''}</div>`;
            const footer = `${usedSessionHtml()}
                <button class="btn btn-green" style="margin-top:14px;" onclick="tutorOpen('rp')">🧑‍🏫 Revoir avec mon tuteur</button>
                <button class="btn btn-gray" style="margin-top:8px;" onclick="rpRealSetup(${it.index})">🔁 Refaire l'entretien</button>
                <button class="btn btn-gray" style="margin-top:8px;" onclick="rpShowRealCandidateList()">Retour aux entretiens</button>`;
            const lines = rpConversationHistory.slice(1).map(m => (m.role === 'user' ? 'CANDIDAT : ' : 'RECRUTEUR : ') + m.parts[0].text);
            if (!rpConversationHistory.slice(1).some(m => m.role === 'user')) {
                box.innerHTML = `<div class="conj-card">${header}<p>Tu n'as encore rien répondu : rien à analyser.</p>${footer}</div>`;
                return;
            }
            box.innerHTML = `<div class="conj-card">${header}<p style="color:var(--text-secondary);">Analyse de ton entretien en cours...</p></div>`;
            const crit = Array.isArray(bank.criteres) ? bank.criteres : [];
            const errs = Array.isArray(bank.erreurs_frequentes) ? bank.erreurs_frequentes : [];
            const notes = ((state.candidateNotes || {})[bank.id] || '').trim();
            let d = null;
            try {
                d = rpHelpParseJson(await GeminiService.generate(
                    'Tu es un coach d\'entretien d\'embauche et un professeur de néerlandais pour francophones. Voici la transcription d\'un entretien d\'entraînement pour le poste : ' + (bank.poste || bank.label) + '. Les répliques du CANDIDAT peuvent avoir été dictées : ignore ponctuation et majuscules.\n\n' +
                    'RECRUTEUR : ' + (rpCurrentScenario && rpCurrentScenario.welcome || '') + '\n' + lines.join('\n') + '\n\n' +
                    (crit.length ? 'Critères à évaluer :\n' + crit.map(x => '- ' + x).join('\n') + '\n\n' : '') +
                    (errs.length ? 'Erreurs que ce candidat a déjà faites en vrai entretien (vérifie s\'il les refait) :\n' + errs.map(x => '- « ' + x.faux + ' » au lieu de « ' + x.correct + ' »').join('\n') + '\n\n' : '') +
                    (notes ? 'Points de vigilance personnels du candidat (ce qu\'il doit dire ou ne surtout pas dire ; signale toute réplique qui les contredit) :\n' + notes + '\n\n' : '') +
                    'Analyse UNIQUEMENT les répliques du CANDIDAT. Réponds UNIQUEMENT en JSON :\n' +
                    '{"resume": "en français, 2 phrases sur l\'impression générale", "criteres": [{"critere": "", "ok": true, "commentaire": "en français, court"}], ' +
                    '"corrections": [{"phrase": "ce qu\'il a dit", "correction": "la bonne formulation en néerlandais", "explication": "en français, court"}], ' +
                    '"vigilance": [{"phrase": "ce qu\'il a dit", "probleme": "en français : quel point de vigilance ou quelle erreur connue est en cause"}], ' +
                    '"conseil": "en français, le conseil prioritaire pour le vrai entretien"}\n6 corrections maximum, les plus utiles ; vigilance vide si rien à signaler.'));
            } catch (e) { d = { error: e.message }; }
            if (rpRealInterview !== it) return;
            if (!d || d.error) {
                box.innerHTML = `<div class="conj-card">${header}<p style="color:var(--wrong);">Bilan impossible${d && d.error ? ' : ' + rpEscapeHtml(d.error) : ''}.</p><button class="btn btn-gray" onclick="rpInterviewDebrief()">Réessayer</button>${footer}</div>`;
                return;
            }
            const arr = x => Array.isArray(x) ? x : [];
            box.innerHTML = `
                <div class="conj-card" style="text-align:left;">
                    ${header}
                    ${d.resume ? `<p>${rpEscapeHtml(d.resume)}</p>` : ''}
                    ${arr(d.criteres).length ? `<div class="rp-iv-label">📋 Critères</div>${arr(d.criteres).map(x => `<div class="modrp-check ${x.ok ? 'ok' : 'ko'}">${x.ok ? '✓' : '✗'} ${rpEscapeHtml(x.critere || '')}${x.commentaire ? `<div class="rp-debrief-sub">${rpEscapeHtml(x.commentaire)}</div>` : ''}</div>`).join('')}` : ''}
                    ${arr(d.vigilance).length ? `<div class="rp-iv-label">⚠️ Points de vigilance</div>${arr(d.vigilance).map(v => `<div class="rp-debrief-item"><div>« ${rpEscapeHtml(v.phrase || '')} »</div><div class="rp-debrief-sub">${rpEscapeHtml(v.probleme || '')}</div></div>`).join('')}` : ''}
                    ${arr(d.corrections).length ? `<div class="rp-iv-label">✍️ À corriger</div>${arr(d.corrections).map(x => `<div class="rp-debrief-item"><div class="rp-debrief-sub">« ${rpEscapeHtml(x.phrase || '')} »</div><div><b>${rpEscapeHtml(x.correction || '')}</b> ${x.correction ? speakBtnHtml(x.correction) : ''}</div><div class="rp-debrief-sub">${rpEscapeHtml(x.explication || '')}</div></div>`).join('')}` : ''}
                    ${d.conseil ? `<div class="rp-iv-label">💡 Pour le vrai entretien</div><p>${rpEscapeHtml(d.conseil)}</p>` : ''}
                    ${footer}
                </div>`;
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
            listDiv.innerHTML = '<div class="rp-group-title">🇫🇷 Traduction guidée — français → néerlandais</div>' +
                '<p class="rp-real-hint">On te donne la phrase en français, tu la dis en néerlandais. Tu joues le recruteur d\'un vrai entretien.</p>' +
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
        // Liste centrale des métiers : ajouter un métier = une entrée ici + ses contenus (situations,
        // journées, fiches, kits, banque d'entretien, thèmes d'études de cas, THEME_<METIER>.csv).
        // domaine : pour les prompts ; noms : entreprises inventées que Gemini peut utiliser.
        const RP_METIERS = {
            logistique: { label: '🚚 Logistique', domaine: 'logistique / supply chain', noms: 'Logistiko pour l\'entreprise du candidat, Transvio ou Nordvracht pour des transporteurs, Delmaro pour un client' },
            business_analyst: { label: '📊 Business analyst', domaine: 'business analysis (analyse des besoins, processus, projets IT)', noms: 'Zonvella pour l\'entreprise du candidat, Delmaro ou Logistiko pour des clients, Transvio pour un éditeur de logiciel' },
            consultant_junior: { label: '💼 Consultant junior', domaine: 'conseil en organisation et en management (consultant junior en cabinet)', noms: 'Zonvella Consulting pour le cabinet du candidat, Delmaro, Logistiko ou Nordvracht pour des clients' },
            projet_junior: { label: '🗂️ Chef de projet junior', domaine: 'gestion de projet (chef de projet junior)', noms: 'Zonvella pour l\'entreprise du candidat, Transvio ou Delmaro pour des fournisseurs' },
            bibliotheque: { label: '📚 Bibliothèque', domaine: 'bibliothèque publique (employé de bibliothèque d\'une commune)', noms: 'la bibliothèque communale de Zonvelde (commune inventée) pour l\'employeur, Delmaro pour un fournisseur de livres' },
            data_analyst: { label: '📈 Data analyst junior', domaine: 'analyse de données (data analyst junior)', noms: 'Zonvella pour l\'entreprise du candidat, Delmaro ou Logistiko pour des clients' },
            pmo: { label: '🧭 PMO (pilotage de projets)', domaine: 'PMO, pilotage de portefeuille de projets (assistant(e) PMO junior)', noms: 'Zonvella pour l\'entreprise du candidat, Transvio ou Delmaro pour des fournisseurs' },
            consultant_fonctionnel: { label: '🧩 Consultant fonctionnel', domaine: 'conseil fonctionnel en logiciel de gestion / ERP (consultant fonctionnel junior)', noms: 'Zonvella pour l\'éditeur ou l\'intégrateur du candidat, Delmaro ou Logistiko pour des clients (PME)' }
        };
        const RP_JOB_METIERS = Object.fromEntries(Object.entries(RP_METIERS).map(([k, v]) => [k, v.label])); // un métier absent s'affiche avec son nom brut
        const RP_JOB_CANAUX = {
            guichet_chauffeur: { label: '🚛 Guichet chauffeurs', prompt: 'face à face, au guichet ou sur le quai' },
            telephone_client: { label: '📞 Téléphone', prompt: 'au téléphone' },
            collegue_interne: { label: '🧑‍🤝‍🧑 Collègues', prompt: 'entre collègues, sur le lieu de travail' },
            picking_zone: { label: '📦 Zone de picking', prompt: 'dans l\'entrepôt, en zone de préparation de commandes' },
            email: { label: '✉️ E-mail', prompt: 'par e-mail : tes messages sont des e-mails courts, et l\'apprenant répond par écrit' },
            reunion: { label: '🗓️ Réunions & ateliers', prompt: 'en réunion, sur place ou en visioconférence' },
            chat: { label: '💬 Messagerie interne', prompt: 'par messagerie instantanée : tes messages sont courts et écrits, et l\'apprenant répond par écrit' },
            balie: { label: '🛎️ Accueil / comptoir', prompt: 'au comptoir d\'accueil, en face à face' }
        };
        // Intensité par type de situation, pour ordonner une journée tirée au sort (calme → pic → calme).
        const RP_JOB_INTENSITY = { administratif: 1, clarification: 1, probleme_document: 2, proposition_solution: 2, presentation: 2, negociation: 3, urgence: 3, reclamation: 3, retour: 2 };
        const RP_JOB_DURATIONS = { courte: 6, longue: 10 };
        // Blancs entre crochets dans les amorces ([klant]...) : l'amorce est affichée et lue telle
        // quelle, on les remplace donc par un nom d'entreprise INVENTÉ (jamais une entreprise
        // réelle) — "bedrijf X" faisait bizarre à l'oral.
        const RP_JOB_BLANKS = { klant: 'Delmaro', bedrijf: 'Transvio', plaats: 'Mechelen' };

        let rpJobData = null;      // { situations: [...], journees: [...] }
        let rpJobMetier = null;
        let rpJobDuration = 'courte';
        let rpDayState = null;     // { label, situations, index, log: [{ situation, turns }] } — null hors journée
        const rpJobSeen = new Set(); // situations déjà jouées depuis l'ouverture de la page (pour varier les tirages)

        async function rpLoadJobData() {
            if (rpJobData) return rpJobData;
            const load = url => fetch(url).then(r => r.ok ? r.json() : {}).catch(() => ({}));
            const [data, playbooks] = await Promise.all([
                load('data/roleplay/job_simulations.json'),
                load('data/roleplay/job_playbooks.json')
            ]);
            rpJobData = { situations: data.situations || [], journees: data.journees || [], fiches: playbooks.fiches || {} };
            return rpJobData;
        }

        // Fiche réflexe d'une situation (data/roleplay/job_playbooks.json, même id) : la marche à
        // suivre courante en entreprise, avec les phrases utiles. Affichée repliée pendant la
        // situation (pour essayer seul d'abord), dans le bilan, et sur la page "Fiches réflexes".
        function rpPlaybookBodyHtml(id) {
            const f = rpJobData && rpJobData.fiches[id];
            if (!f) return '';
            // Pas de lecture à voix haute pour une situation en anglais : la voix est néerlandaise.
            const sit = rpJobData.situations.find(x => x.id === id);
            const speak = p => (sit && rpSitLang(sit) === 'en') ? '' : speakBtnHtml(p);
            return `<ol class="rp-playbook-steps">${(f.etapes || []).map(e =>
                    `<li>${rpEscapeHtml(e.fr || '')}${e.phrase ? `<div class="rp-playbook-phrase">${rpEscapeHtml(e.phrase)} ${speak(e.phrase)}</div>` : ''}</li>`).join('')}</ol>` +
                ((f.a_eviter || []).length ? `<div class="rp-playbook-avoid"><b>À éviter :</b> ${f.a_eviter.map(rpEscapeHtml).join(' ')}</div>` : '');
        }

        function rpPlaybookDetailsHtml(id, summary) {
            const body = rpPlaybookBodyHtml(id);
            return body ? `<details class="rp-playbook"><summary>${summary}</summary>${body}</details>` : '';
        }

        function rpShowPlaybooks() {
            const bank = rpJobData.situations.filter(s => s.metier === rpJobMetier && rpJobData.fiches[s.id]);
            const canaux = [...new Set(bank.map(s => s.canal))];
            document.getElementById('rp-scenario-list').innerHTML = `
                <button class="back-btn" onclick="rpShowJobHome()">← Retour aux situations</button>
                <div class="rp-group-title">📋 Fiches réflexes — ${rpEscapeHtml(RP_JOB_METIERS[rpJobMetier] || rpJobMetier)}</div>
                <p class="rp-real-hint">La marche à suivre la plus courante pour chaque situation, avec les phrases utiles. Chaque entreprise a ses propres procédures : adapte-les à ce que tu vois sur le terrain.</p>
                ${canaux.map(c =>
                    `<div class="rp-job-canal">${rpEscapeHtml((RP_JOB_CANAUX[c] || { label: c }).label)}</div>` +
                    bank.filter(s => s.canal === c).map(s =>
                        `<details class="rp-playbook rp-playbook-card"><summary>${rpEscapeHtml(rpJobData.fiches[s.id].titre || rpSitTitle(s))}</summary>
                            ${rpPlaybookBodyHtml(s.id)}
                            <button class="btn btn-gray" style="margin-top:10px;" onclick="rpStartSituation('${s.id}')">▶️ S'entraîner sur cette situation</button>
                        </details>`).join('')
                ).join('')}`;
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
            return 'Tu joues un personnage dans une mise en situation professionnelle (métier : ' + ((RP_METIERS[s.metier] || {}).domaine || s.metier || 'non précisé') + '). ' +
                'L\'apprenant occupe le poste de ' + (s.poste || 'employé') + ' ; toi, tu es son interlocuteur dans cette situation (client, utilisateur, chauffeur, collègue ou responsable selon le contexte) — jamais l\'apprenant lui-même.\n\n' +
                'Situation : ' + s.contexte + '\n' +
                (canal.prompt ? 'L\'échange a lieu ' + canal.prompt + '.\n' : '') +
                'Tu as ouvert l\'échange en disant : """' + rpSitAmorce(s) + '"""\n\n' +
                'Continue à partir de là, exclusivement en ' + langName + ', avec des répliques courtes (une ou deux phrases) et naturelles. ' +
                'Réagis à ce que l\'apprenant dit réellement et invente les détails plausibles dont tu as besoin (heure, référence, numéro, nom de projet ou d\'outil générique, nom de client générique). ' +
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
        // =====================================================================================
        // Kits de préparation (« 📚 Préparer ») : verbes, mots et phrases utiles d'un jeu de rôle
        // =====================================================================================
        // data/roleplay/prep_kits.json : blocs thématiques réunis par scénario (base entretien +
        // métier, ou blocs d'une situation de travail). Depuis le kit : réviser les mots (session de
        // vocabulaire habituelle), conjuguer les verbes (entraînement réglable limité au kit),
        // écouter le kit (moteur audio de la liste de mots), puis lancer le jeu de rôle.
        let rpPrepData = null;      // { themes, scenarios, situations }
        let rpPrepCurrent = null;   // { key, label, launch, kit }
        const KIT_FILE = 'KITS_JEU_DE_ROLE';

        function rpKitNorm(s) { return normalize(String(s || '')).replace(/[^a-z0-9 '-]/g, ' ').replace(/\s+/g, ' ').trim(); }

        // Index du vocabulaire par forme néerlandaise (chaque variante d'un « a / b »).
        function rpKitVocabIndex() {
            const idx = {};
            fullDb.forEach(i => {
                if (i.file === 'PHRASES_LABO') return;
                String(i.nl).split('/').forEach(part => { const k = rpKitNorm(part); if (k && !idx[k]) idx[k] = i; });
            });
            return idx;
        }

        // Ajoute à fullDb les mots d'un bloc de kit absents du vocabulaire (id stable KIT:<nl>).
        function rpKitInjectWords(t, idx) {
            idx = idx || rpKitVocabIndex();
            const entries = (t.verbes || []).map(v => ({ nl: v, fr: '' })).concat(t.mots || []);
            entries.forEach(e => {
                const k = rpKitNorm(e.nl);
                if (!k || idx[k]) return;
                let fr = e.fr;
                if (!fr) { const cv = conjugationData.find(x => x.infinitief === e.nl); fr = cv ? cv.fr : ''; }
                if (!fr) return;
                const item = { id: 'KIT:' + k, fr, nl: e.nl, freq: 3, file: KIT_FILE, tier: '', niveauCECR: '', sousCategorie: t.label || '' };
                fullDb.push(item);
                idx[k] = item;
            });
        }

        async function rpLoadPrepKits() {
            if (rpPrepData) return rpPrepData;
            try {
                rpPrepData = await fetch('data/roleplay/prep_kits.json').then(r => r.ok ? r.json() : null);
            } catch (e) { rpPrepData = null; }
            if (!rpPrepData) rpPrepData = { themes: {}, scenarios: {}, situations: {} };
            const idx = rpKitVocabIndex();
            Object.values(rpPrepData.themes).forEach(t => rpKitInjectWords(t, idx));
            await rpLoadLibrary();
            rpLibAll().forEach(e => rpKitInjectWords(Object.assign({ label: e.label }, e.kit), idx));
            await modRpLoadAll();
            return rpPrepData;
        }

        function rpKitThemesFor(key) {
            if (!rpPrepData) return [];
            if (rpPrepData.scenarios[key]) return rpPrepData.scenarios[key];
            const sitThemes = id => {
                const prefix = Object.keys(rpPrepData.situations || {}).find(p => id.startsWith(p));
                return prefix ? rpPrepData.situations[prefix] : [];
            };
            if (key.startsWith('sit:')) return sitThemes(key.slice(4));
            if (key.startsWith('day:') && rpJobData) {
                const j = rpJobData.journees.find(x => x.id === key.slice(4));
                return j ? [...new Set((j.sequence || []).flatMap(sitThemes))] : [];
            }
            return [];
        }

        function rpBuildKit(key) {
            const lib = key.startsWith('lib:') ? rpLibFind(key.slice(4)) : null;
            const themes = key.startsWith('mod:') ? modRpKitThemes(key)
                : lib ? [Object.assign({ label: lib.label }, lib.kit)] : rpKitThemesFor(key).map(t => rpPrepData.themes[t]).filter(Boolean);
            if (!themes.length) return null;
            const idx = rpKitVocabIndex();
            const seen = new Set();
            const verbs = [], words = [], phrases = [];
            themes.forEach(t => {
                (t.verbes || []).forEach(v => {
                    if (seen.has('v:' + v)) return; seen.add('v:' + v);
                    verbs.push({ inf: v, conj: conjugationData.find(x => x.infinitief === v) || null, item: idx[rpKitNorm(v)] || null });
                });
                (t.mots || []).forEach(m => {
                    const k = rpKitNorm(m.nl);
                    if (seen.has('m:' + k)) return; seen.add('m:' + k);
                    words.push({ nl: m.nl, fr: m.fr, item: idx[k] || null });
                });
                (t.phrases || []).forEach(p => phrases.push(p));
            });
            return { themes: themes.map(t => t.label), verbs, words, phrases };
        }

        function rpHasKit(key) {
            if (key.startsWith('mod:')) return modRpKitThemes(key).length > 0;
            return key.startsWith('lib:') ? !!rpLibFind(key.slice(4)) : rpKitThemesFor(key).length > 0;
        }

        // =====================================================================================
        // Bibliothèque de situations (data/roleplay/situations_library.json + générées par Gemini)
        // =====================================================================================
        // Situations stockées en dur : s'ouvrent et se préparent sans Gemini (seule la conversation
        // l'utilise). « 🎲 Nouvelle situation » en fait inventer une par Gemini, gardée ensuite dans
        // state.rpLibrary (synchronisé) pour être rejouée sans la régénérer.
        let rpLibData = null; // { themes: {key: label}, situations: [...] }

        async function rpLoadLibrary() {
            if (rpLibData) return rpLibData;
            try { rpLibData = await fetch('data/roleplay/situations_library.json').then(r => r.ok ? r.json() : null); } catch (e) { rpLibData = null; }
            if (!rpLibData) rpLibData = { themes: {}, situations: [] };
            return rpLibData;
        }

        function rpLibGenerated() {
            return Object.entries(state.rpLibrary || {}).filter(([, e]) => e && !e.hidden).map(([id, e]) => Object.assign({ id, generated: true }, e));
        }
        function rpLibAll() { return ((rpLibData && rpLibData.situations) || []).concat(rpLibGenerated()); }
        function rpLibFind(id) { return rpLibAll().find(e => e.id === id) || null; }
        const RP_LIB_THEMES_FALLBACK = { emploi: "💼 Recherche d'emploi", travail: '🏢 Au bureau', quotidien: '🏠 Vie courante en Belgique' };
        function rpLibThemeLabel(t) { return (rpLibData && rpLibData.themes && rpLibData.themes[t]) || RP_LIB_THEMES_FALLBACK[t] || t; }

        function rpBuildLibPrompt(e) {
            const words = (e.kit.verbes || []).concat((e.kit.mots || []).map(m => m.nl)).join(', ');
            return 'Tu joues un rôle dans un jeu de rôle avec un apprenant francophone de néerlandais qui vit en Belgique.\n' +
                'Ton rôle : ' + e.role + '\nLa situation, vue par l\'apprenant : ' + e.contexte + '\n\n' +
                'Parle exclusivement en néerlandais de Flandre courant, niveau B1 : phrases courtes, mots courants, une question ou une idée à la fois, comme à l\'oral. ' +
                'Réagis à ce que dit réellement l\'apprenant, ne corrige jamais sa langue et ne sors jamais de ton rôle. ' +
                'Pour qu\'il pratique son vocabulaire, emploie naturellement certains de ces mots quand c\'est pertinent : ' + words + '. ' +
                'Quand la situation est réglée, conclus naturellement.\n\n' +
                'Tu as déjà ouvert la conversation en disant : """' + e.welcome + '""" — enchaîne à partir de la réponse de l\'apprenant.';
        }

        async function rpShowLibrary(theme) {
            rpCurrentCategory = '__lib:' + theme;
            rpHideInterviewer();
            rpJobHideDebrief();
            const listDiv = document.getElementById('rp-scenario-list');
            document.getElementById('rp-step-category').style.display = 'none';
            document.getElementById('rp-step-scenario').style.display = '';
            document.getElementById('rp-step-chat').style.display = 'none';
            await rpLoadLibrary();
            const list = rpLibAll().filter(e => e.theme === theme);
            const row = e => rpPrepRow(
                `<button class="rp-scenario-btn" onclick="rpStartLib('${e.id}')">${rpEscapeHtml(e.label)}${e.generated ? ' <span class="wl-badge unseen">🎲 générée</span>' : ''}</button>`,
                'lib:' + e.id, e.label, { type: 'lib', id: e.id });
            listDiv.innerHTML = `
                <div class="rp-group-title">${rpEscapeHtml(rpLibThemeLabel(theme))}</div>
                <p class="rp-real-hint">Prépare d'abord les mots avec 📚, puis lance la conversation. Ton interlocuteur emploiera les mots du kit.</p>
                ${list.map(row).join('') || '<p style="color:#888;">Aucune situation pour l\'instant.</p>'}
                <div class="rp-group-title">🎲 Nouvelle situation (Gemini)</div>
                <p class="rp-real-hint">Gemini invente une situation et son kit sur ce thème ; elle est ensuite gardée ici.</p>
                <div class="rp-help-input-row" style="width:100%; max-width:520px;">
                    <input type="text" id="rp-lib-subject" placeholder="Sujet (facultatif), ex. : réserver une salle de sport" autocomplete="off">
                    <button class="btn btn-green" id="rp-lib-gen-btn" onclick="rpLibGenerate('${theme}')">🎲 Créer</button>
                </div>
                <div id="rp-lib-gen-status" class="rp-real-hint"></div>`;
        }

        function rpStartLib(id) {
            const e = rpLibFind(id);
            if (!e) return;
            if (e.theme === 'quotidien') { talkOpenSituation(id); return; }
            if (!GeminiService.getKey()) { alert("La conversation a besoin de ta clé Gemini (Profil → 🤖 Intelligence IA). Tu peux déjà préparer les mots avec 📚."); return; }
            rpDayState = null;
            rpBeginScenario({ id: 'lib_' + e.id, lang: 'nl', label: e.label, welcome: e.welcome, prompt: rpBuildLibPrompt(e) });
            const banner = document.getElementById('rp-mode-banner');
            banner.style.display = '';
            banner.innerHTML = `
                <div class="rp-job-banner">
                    <div class="rp-iv-label" style="margin-top:0;">${rpEscapeHtml(rpLibThemeLabel(e.theme))}</div>
                    <div>${rpEscapeHtml(e.contexte)}</div>
                    <details><summary>💬 Phrases utiles</summary><ul class="rp-case-figures">${(e.kit.phrases || []).map(p => `<li>${rpEscapeHtml(p.nl)} <small>— ${rpEscapeHtml(p.fr)}</small></li>`).join('')}</ul></details>
                </div>`;
        }

        async function rpLibGenerate(theme) {
            const status = document.getElementById('rp-lib-gen-status');
            const btn = document.getElementById('rp-lib-gen-btn');
            if (!GeminiService.getKey()) { status.innerText = 'Nécessite ta clé Gemini (Profil → 🤖 Intelligence IA).'; return; }
            const subject = (document.getElementById('rp-lib-subject').value || '').trim();
            const existing = rpLibAll().filter(e => e.theme === theme).map(e => e.label).join(' ; ');
            status.innerText = 'Gemini invente la situation et son kit...';
            btn.disabled = true;
            try {
                const raw = await GeminiService.generate(
                    'Invente une situation de jeu de rôle oral en néerlandais pour un francophone de niveau B1 qui vit et travaille en Flandre (Belgique).\n' +
                    'Thème : ' + rpLibThemeLabel(theme) + '.\n' +
                    (subject ? 'Sujet demandé : ' + subject + '.\n' : 'Choisis un sujet concret et courant, différent de ceux-ci : ' + existing + '.\n') +
                    'Noms de personnes et d\'entreprises inventés. Le kit liste le vocabulaire dont l\'apprenant aura besoin pour s\'en sortir.\n' +
                    'Réponds UNIQUEMENT avec un objet JSON, sans texte autour :\n' +
                    '{"label": "titre court en français", "contexte": "en français, 1-2 phrases : ce que vit l\'apprenant", ' +
                    '"role": "en français : qui est l\'interlocuteur, ce qu\'il veut, comment il réagit", "welcome": "première réplique de l\'interlocuteur, en néerlandais", ' +
                    '"kit": {"verbes": ["10 infinitifs néerlandais utiles"], "mots": [{"nl": "12 noms avec de/het, ou adjectifs", "fr": "traduction"}], "phrases": [{"nl": "4 phrases utiles pour l\'apprenant", "fr": "traduction"}]}}'
                );
                const e = rpHelpParseJson(raw);
                const ok = e && e.label && e.contexte && e.role && e.welcome && e.kit && Array.isArray(e.kit.verbes) && Array.isArray(e.kit.mots);
                if (!ok) throw new Error('réponse incomplète');
                const clean = {
                    theme, label: String(e.label), contexte: String(e.contexte), role: String(e.role), welcome: String(e.welcome), at: Date.now(),
                    kit: {
                        verbes: e.kit.verbes.map(String).slice(0, 14),
                        mots: e.kit.mots.filter(m => m && m.nl && m.fr).map(m => ({ nl: String(m.nl), fr: String(m.fr) })).slice(0, 16),
                        phrases: (e.kit.phrases || []).filter(p => p && p.nl && p.fr).map(p => ({ nl: String(p.nl), fr: String(p.fr) })).slice(0, 6)
                    }
                };
                if (!state.rpLibrary) state.rpLibrary = {};
                const id = 'gen_' + Date.now().toString(36);
                state.rpLibrary[id] = clean;
                save();
                rpKitInjectWords(Object.assign({ label: clean.label }, clean.kit));
                await rpShowLibrary(theme);
                const s = document.getElementById('rp-lib-gen-status');
                if (s) s.innerText = '✅ « ' + clean.label + ' » ajoutée à la liste. Prépare-la avec 📚 ou lance-la.';
            } catch (err) {
                status.innerText = 'Création impossible : ' + err.message;
                btn.disabled = false;
            }
        }

        // Bouton « 📚 Préparer » accolé au bouton d'un scénario dans les listes.
        function rpPrepRow(scenarioBtnHtml, key, label, launch) {
            const hasKit = rpHasKit(key);
            const canListen = !!rpSceneSource(launch);
            if (!hasKit && !canListen) return scenarioBtnHtml;
            const data = encodeURIComponent(JSON.stringify({ key, label, launch }));
            const sceneData = encodeURIComponent(JSON.stringify({ key, launch }));
            return `<div class="rp-scenario-row">${scenarioBtnHtml}` +
                (hasKit ? `<button type="button" class="rp-prep-btn" data-prep="${data}" onclick="rpPrepOpenFromBtn(this)" title="Préparer les mots et les verbes de ce jeu de rôle">📚<span class="rp-prep-label"> Préparer</span></button>` : '') +
                (canListen ? `<button type="button" class="rp-prep-btn" data-scene="${sceneData}" onclick="rpSceneOpenFromBtn(this)" title="Écouter une scène complète, comme spectateur">👂</button>` : '') +
                `</div>`;
        }

        function rpPrepOpenFromBtn(btn) {
            try { const d = JSON.parse(decodeURIComponent(btn.dataset.prep)); rpPrepOpen(d.key, d.label, d.launch); } catch (e) { console.warn(e); }
        }

        function rpPrepOpen(key, label, launch) {
            const kit = rpBuildKit(key);
            if (!kit) return;
            conjAudioStop();
            rpPrepCurrent = { key, label, launch, kit };
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('prep-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            rpPrepRender();
            window.scrollTo(0, 0);
        }

        function rpPrepRender() {
            const p = rpPrepCurrent;
            const box = document.getElementById('prep-content');
            if (!p || !box) return;
            const { kit } = p;
            const conjCount = kit.verbs.filter(v => v.conj).length;
            const row = (nl, fr, extra, report) => `
                <div class="prep-row">
                    <span class="prep-nl">${rpEscapeHtml(nl)}</span>
                    <span class="prep-fr">${rpEscapeHtml(fr || '')}</span>
                    <span class="prep-actions">${extra || ''}${speakBtnHtml(nl)}${report}</span>
                </div>`;
            const status = item => item ? `<span class="wl-badge ${wordStatus(item.id)}">${{ unseen: 'Non vu', review: 'À réviser', mastered: 'Réussi', 'true-mastered': '★ Maîtrisé' }[wordStatus(item.id)]}</span>` : '';
            box.innerHTML = `
                <h2 style="margin-bottom:4px;">📚 Me préparer</h2>
                <p class="prep-sub">${rpEscapeHtml(p.label)} · ${rpEscapeHtml(kit.themes.join(' + '))}</p>
                <div class="prep-actions-grid">
                    <button class="btn btn-green" onclick="rpPrepVocab()">📝 Réviser les ${kit.verbs.length + kit.words.length} mots</button>
                    <button class="btn btn-gray" onclick="rpPrepConj()" ${conjCount ? '' : 'disabled'}>🔤 Conjuguer les ${conjCount} verbes</button>
                    <button class="btn btn-gray" onclick="rpPrepAudio()">🎧 Écouter le kit</button>
                    <button class="btn btn-gray" onclick="rpPrepLaunch()">▶️ Lancer le jeu de rôle</button>
                </div>
                <div id="prep-audio-box"></div>
                <div class="section-title">🔤 Verbes (${kit.verbs.length})</div>
                ${kit.verbs.map(v => row(v.inf, v.conj ? v.conj.fr : (v.item ? v.item.fr : ''),
                    (v.conj ? `<button type="button" class="conj-filter-chip" onclick="rpPrepShowVerb('${v.inf.replace(/'/g, "\\'")}')">fiche</button>` : '') + status(v.item),
                    reportBtnHtml({ kind: 'kit', ref: p.key, nl: v.inf, fr: v.conj ? v.conj.fr : '', context: 'kit · verbe' }))).join('')}
                <div class="section-title">🧱 Mots (${kit.words.length})</div>
                ${kit.words.map(w => row(w.nl, w.fr, status(w.item), reportBtnHtml({ kind: 'kit', ref: p.key, nl: w.nl, fr: w.fr, context: 'kit · mot' }))).join('')}
                ${kit.phrases.length ? `<div class="section-title">💬 Phrases utiles (${kit.phrases.length})</div>
                ${kit.phrases.map(ph => row(ph.nl, ph.fr, '', reportBtnHtml({ kind: 'kit', ref: p.key, nl: ph.nl, fr: ph.fr, context: 'kit · phrase' }))).join('')}` : ''}`;
        }

        function rpPrepBack() {
            conjAudioStop();
            const key = rpPrepCurrent && rpPrepCurrent.key;
            if (key && key.startsWith('mod:')) {
                const [, mid, et] = key.split(':');
                showModuleRp(mid);
                if (et) modRpShowEtape(et);
                return;
            }
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('roleplay-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            rpShowScenarioPicker();
        }

        function rpPrepKitItems() {
            const k = rpPrepCurrent && rpPrepCurrent.kit;
            if (!k) return [];
            return k.verbs.map(v => v.item).concat(k.words.map(w => w.item)).filter(Boolean);
        }

        function rpPrepVocab() {
            const items = rpPrepKitItems();
            if (!items.length) return;
            inRevisionMode = false;
            const orderedItems = byFrequencyDesc(items);
            const sourceKey = 'kit:' + rpPrepCurrent.key + '::' + state.settings.direction;
            const unlocked = getUnlockedItems(sourceKey, orderedItems);
            sessionDb = activePool(unlocked);
            if (!sessionDb.length) { alert('Tu maîtrises déjà tous les mots débloqués de ce kit (dans ce sens) ! 🎉'); return; }
            currentSessionSourceKey = sourceKey;
            currentSessionOrderedItems = orderedItems;
            document.getElementById('session-title').innerText = '📚 ' + rpPrepCurrent.label;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('study-view').classList.add('active');
            batchResults = [];
            document.getElementById('batch-recap').innerHTML = '';
            bumpMode('classique');
            save();
            nextQ();
        }

        function rpPrepConj() {
            const verbs = rpPrepCurrent.kit.verbs.filter(v => v.conj).map(v => v.inf);
            if (!verbs.length) return;
            startConjTrainingSession({ label: rpPrepCurrent.label, verbs: new Set(verbs) });
        }

        function rpPrepShowVerb(inf) {
            showConjugaison();
            showConjugaisonDetail(inf);
        }

        function rpPrepAudio() {
            const k = rpPrepCurrent.kit;
            const items = k.verbs.map(v => ({ nl: v.inf, fr: v.conj ? v.conj.fr : (v.item ? v.item.fr : ''), file: KIT_FILE }))
                .concat(k.words.map(w => ({ nl: w.nl, fr: w.fr, file: KIT_FILE })))
                .concat(k.phrases.map(ph => ({ nl: ph.nl, fr: ph.fr, file: KIT_FILE })))
                .filter(i => i.fr);
            wordAudioCtx = { boxId: 'prep-audio-box', viewId: 'prep-view', items, label: 'les ' + items.length + ' éléments du kit (verbes, mots, phrases)' };
            const box = document.getElementById('prep-audio-box');
            if (box && box.innerHTML && !conjAudioRun) { box.innerHTML = ''; return; }
            conjAudioStop();
            wordAudioRenderSetup();
        }

        async function rpPrepLaunch() {
            const l = rpPrepCurrent && rpPrepCurrent.launch;
            if (!l) return;
            conjAudioStop();
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('roleplay-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            renderRpGeminiStatus();
            if (l.type === 'bank') { await rpShowRealCandidateList(); rpStartRealCandidate(l.index); }
            else if (l.type === 'rp') { rpShowCategory(l.cat); rpStartScenario(l.cat, l.id); }
            else if (l.type === 'sit') { await rpShowJobHome(); rpStartSituation(l.id); }
            else if (l.type === 'day') { await rpShowJobHome(); rpStartDay(l.index); }
            else if (l.type === 'mod') { modRpPlay(l.id, l.etape || 'final'); }
            else if (l.type === 'lib') { const e = rpLibFind(l.id); if (e && e.theme === 'quotidien') talkOpenSituation(l.id); else if (e) { await rpShowLibrary(e.theme); rpStartLib(l.id); } }
        }

        // =====================================================================================
        // Modules en format « jeu de rôle » (pilote : Premier contact, A1)
        // =====================================================================================
        // Un module = une situation de vie découpée en étapes (vocabulaire, règle courte, exercices
        // stockés en dur, mini jeu de rôle). Le portrait (questions en français) produit les phrases
        // personnelles de l'apprenant : elles entrent dans les kits, les exercices (« dis-le ») et
        // le prompt des interlocuteurs. Tout vit dans state.modRp[id] (synchronisé, jamais public).
        const MODRP_IDS = ['premier_contact', 'rendez_vous', 'courses', 'logement', 'deplacer', 'journee', 'travail_a1', 'weekend',
            'a2_sante', 'a2_souvenir', 'a2_projets', 'a2_telephone', 'a2_avis', 'a2_reclamation', 'a2_voyage', 'a2_invitation'];
        const MODRP_SPECIAL = {
            '#epeler': /(^|\s)([a-z][\s,.-]+){3,}/,
            '#perfectum-hebben': /\b(heb|hebt|heeft|hebben)\b[^.?!]*\b[a-z]*ge[a-z]{2,}(t|d|n)\b/,
            '#perfectum-zijn': /\b(ben|bent|is|zijn)\b[^.?!]*\b([a-z]*ge[a-z]{2,}(n|d|t)|vertrokken|verhuisd)\b/,
            // pronom + imparfait (« ik werkte ») ou imparfait + pronom après inversion (« toen werkte ik »)
            '#imperfectum': /\b(ik|je|jij|hij|zij|ze|we|wij|het|er|u|dat)\s+([a-z]{2,}(de|te)n?|was|waren|had|hadden|ging|gingen|deed|deden|kwam|kwamen|zag|kreeg|hielp|begon|bleef|vond|wist|kon|moest|wou|wilde)\b|\b([a-z]{2,}(de|te)n?|was|waren|had|hadden|ging|gingen|deed|kwam|zag|kreeg|hielp|begon|bleef|vond|kon|moest)\s+(ik|je|jij|hij|zij|ze|we|wij|het|er)\b/
        };
        const MODRP_FILE = 'MON_PORTRAIT';
        const modRpData = {};
        let modRpCurrent = null;   // id du module affiché
        let modRpEx = null;        // exercices en cours

        async function modRpLoadAll() {
            await Promise.all(MODRP_IDS.map(async id => {
                if (modRpData[id]) return;
                try { const d = await fetch('data/modules_rp/' + id + '.json').then(r => r.ok ? r.json() : null); if (d) modRpData[id] = d; } catch (e) { /* module absent */ }
            }));
            const idx = rpKitVocabIndex();
            Object.values(modRpData).forEach(m => m.etapes.forEach(e => rpKitInjectWords(Object.assign({ label: m.titre }, e.vocab), idx)));
            MODRP_IDS.forEach(modRpInjectPerso);
        }

        function modRpState(id) {
            if (!state.modRp) state.modRp = {};
            if (!state.modRp[id]) state.modRp[id] = { portrait: {}, extras: [], etapes: {}, final: false };
            const s = state.modRp[id];
            if (!s.portrait) s.portrait = {};
            if (!Array.isArray(s.extras)) s.extras = [];
            if (!s.etapes) s.etapes = {};
            return s;
        }

        const NL_NUMBERS = ['nul', 'één', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien'];
        const FR_NUMBERS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];
        function nlCount(n, sing, plur) { return n === 1 ? 'een ' + sing : (NL_NUMBERS[n] || n) + ' ' + plur; }
        function frCount(n, sing, plur) { return n === 1 ? 'un' + (/e$/.test(sing) && sing !== 'frère' ? 'e ' : ' ') + sing : (FR_NUMBERS[n] || n) + ' ' + plur; }

        // Phrases personnelles tirées du portrait : [{ key, etape, nl, fr }].
        function modRpSentences(id) {
            const m = modRpData[id];
            if (!m) return [];
            const p = modRpState(id).portrait;
            const P = m.portrait;
            if (!P) return [];
            const out = [];
            const add = (key, etape, nl, fr) => out.push({ key, etape, nl, fr });
            if (p.naam) add('naam', 'identite', `Ik heet ${p.naam}.`, `Je m'appelle ${p.naam}.`);
            if (p.leeftijd) add('leeftijd', 'identite', `Ik ben ${p.leeftijd} jaar.`, `J'ai ${p.leeftijd} ans.`);
            const pays = P.pays.find(x => x.fr === p.land);
            if (pays) add('land', 'identite', `Ik kom uit ${pays.land}. Ik ben ${pays.adj}.`, `Je viens ${pays.defr || 'de ' + pays.fr}. Je suis ${pays.natfr || pays.fr}.`);
            if (p.stad) add('stad', 'identite', `Ik woon in ${p.stad}.`, `J'habite à ${p.stad}.`);
            const rel = { alleenstaand: ['Ik ben alleenstaand.', 'Je suis célibataire.'], getrouwd: ['Ik ben getrouwd.', 'Je suis marié(e).'], samenwonend: ['Ik woon samen met mijn partner.', "J'habite avec mon/ma partenaire."], relatie: ['Ik heb een relatie.', "Je suis en couple."] }[p.relatie];
            if (rel) add('relatie', 'famille', rel[0], rel[1]);
            if (p.kinderen !== undefined && p.kinderen !== '') {
                const k = +p.kinderen;
                add('kinderen', 'famille', k ? `Ik heb ${nlCount(k, 'kind', 'kinderen')}.` : 'Ik heb geen kinderen.', k ? `J'ai ${frCount(k, 'enfant', 'enfants')}.` : "Je n'ai pas d'enfants.");
            }
            if ((p.broers !== undefined && p.broers !== '') || (p.zussen !== undefined && p.zussen !== '')) {
                const b = +(p.broers || 0), z = +(p.zussen || 0);
                if (!b && !z) add('fratrie', 'famille', 'Ik heb geen broers of zussen.', "Je n'ai pas de frères et sœurs.");
                else {
                    const nl = [b ? nlCount(b, 'broer', 'broers') : '', z ? nlCount(z, 'zus', 'zussen') : ''].filter(Boolean).join(' en ');
                    const fr = [b ? frCount(b, 'frère', 'frères') : '', z ? frCount(z, 'sœur', 'sœurs') : ''].filter(Boolean).join(' et ');
                    add('fratrie', 'famille', `Ik heb ${nl}.`, `J'ai ${fr}.`);
                }
            }
            const met = P.metiers.find(x => x.fr === p.beroep);
            if (p.situatie === 'werk') add('werk', 'travail', met ? `Ik werk als ${met.nl}.` : 'Ik werk.', met ? `Je travaille comme ${met.fr}.` : 'Je travaille.');
            if (p.situatie === 'werkzoekend') add('werk', 'travail', 'Ik ben werkzoekend.' + (met ? ` Ik zoek werk als ${met.nl}.` : ''), "Je suis demandeur d'emploi." + (met ? ` Je cherche du travail comme ${met.fr}.` : ''));
            if (p.situatie === 'student') add('werk', 'travail', 'Ik ben student.', 'Je suis étudiant(e).');
            const langs = P.langues.filter(l => (p.talen || []).includes(l.fr));
            if (langs.length) {
                const list = (arr) => arr.length > 1 ? arr.slice(0, -1).join(', ') + ' en ' + arr[arr.length - 1] : arr[0];
                const listFr = (arr) => arr.length > 1 ? arr.slice(0, -1).join(', ') + ' et ' + arr[arr.length - 1] : arr[0];
                add('talen', 'loisirs', `Ik spreek ${list(langs.map(l => l.nl))}. Ik leer Nederlands.`, `Je parle ${listFr(langs.map(l => l.fr))}. J'apprends le néerlandais.`);
            }
            P.loisirs.filter(l => (p.hobbies || []).includes(l.fr)).forEach((l, i) => add('hobby' + i, 'loisirs', l.nl, "J'aime " + l.fr + '.'));
            modRpState(id).extras.forEach((x, i) => add('extra' + i, x.etape || 'identite', x.nl, x.fr));
            return out;
        }

        // Les phrases du portrait deviennent des « mots » révisables (fichier virtuel MON_PORTRAIT).
        function modRpInjectPerso(id) {
            const prefix = 'PERSO:' + id + ':';
            for (let i = fullDb.length - 1; i >= 0; i--) if (String(fullDb[i].id).startsWith(prefix)) fullDb.splice(i, 1);
            modRpSentences(id).forEach(s => fullDb.push({ id: prefix + s.key, fr: s.fr, nl: s.nl, freq: 3, file: MODRP_FILE, tier: '', niveauCECR: '', sousCategorie: '' }));
        }

        // Thèmes de kit d'un module (clé mod:<id>) ou d'une étape (mod:<id>:<etape>).
        function modRpKitThemes(key) {
            const [, id, etapeId] = key.split(':');
            const m = modRpData[id];
            if (!m) return [];
            const etapes = m.etapes.filter(e => !etapeId || e.id === etapeId);
            const perso = modRpSentences(id).filter(s => !etapeId || s.etape === etapeId);
            const themes = etapes.map(e => Object.assign({ label: e.titre }, e.vocab));
            if (perso.length) themes.push({ label: 'Mes phrases', verbes: [], mots: perso.map(s => ({ nl: s.nl, fr: s.fr })), phrases: [] });
            return themes;
        }

        function showModuleRp(id) {
            const m = modRpData[id];
            if (!m) { alert('Module en cours de chargement, réessaie dans un instant.'); return; }
            conjAudioStop();
            modRpCurrent = id;
            modRpEx = null;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('modrp-view').classList.add('active');
            setActiveNav('nav-apprendre');
            modRpRenderHome();
            window.scrollTo(0, 0);
        }

        function modRpEtapeDone(id, e) {
            const st = modRpState(id).etapes[e.id] || {};
            return (st.best || 0) >= Math.ceil(0.7 * modRpExercises(id, e).length) && !!st.played;
        }

        function modRpRenderHome() {
            const id = modRpCurrent, m = modRpData[id];
            const s = modRpState(id);
            const nPerso = modRpSentences(id).length;
            const done = m.etapes.filter(e => modRpEtapeDone(id, e)).length;
            const box = document.getElementById('modrp-content');
            box.innerHTML = `
                <div class="modrp-head">
                    <span class="conj-niveau-badge">${m.niveau}</span>
                    <h2 style="margin:6px 0;">${rpEscapeHtml(m.titre)}</h2>
                    <p class="prep-sub">🎯 ${rpEscapeHtml(m.objectif)}</p>
                    <div class="cat-bar"><div class="cat-bar-fill" style="width:${Math.round(done / m.etapes.length * 100)}%"></div></div>
                    <p class="report-meta">${done}/${m.etapes.length} étapes terminées${s.finalResult && s.finalResult.passed ? ' · 🏆 module réussi' : (s.final ? ' · examen final tenté' : '')}</p>
                </div>
                <button class="btn btn-green" style="margin-bottom:12px;" onclick="guideStart('${id}')">▶️ ${s.guide ? 'Continuer la session guidée' : 'Commencer la session guidée'}</button>
                <p class="report-meta" style="margin-top:0;">Ou revois une partie précise :</p>
                ${m.portrait ? `<button class="modrp-step${nPerso ? ' done' : ''}" onclick="modRpShowPortrait()">
                    <span class="modrp-num">🪪</span><span><b>Mon portrait</b><br><small>${nPerso ? nPerso + ' phrases sur toi, prêtes à apprendre' : 'Commence ici : dis qui tu es, l\'app en fait tes phrases en néerlandais'}</small></span>
                </button>` : ''}
                ${m.etapes.map((e, i) => {
                    const st = s.etapes[e.id] || {};
                    const total = modRpExercises(id, e).length;
                    return `<button class="modrp-step${modRpEtapeDone(id, e) ? ' done' : ''}" onclick="modRpShowEtape('${e.id}')">
                        <span class="modrp-num">${modRpEtapeDone(id, e) ? '✓' : i + 1}</span>
                        <span><b>${rpEscapeHtml(e.titre)}</b><br><small>${st.best !== undefined ? `Exercices : meilleur score ${st.best}/${total}` : `${total} exercices`} · ${st.played ? '🎭 joué' : '🎭 jeu de rôle à faire'}</small></span>
                    </button>`;
                }).join('')}
                <button class="modrp-step final${s.finalResult && s.finalResult.passed ? ' done' : ''}" onclick="modRpPlay('${id}', 'final')">
                    <span class="modrp-num">🏆</span><span><b>${rpEscapeHtml(m.final.titre)} · examen du module</b><br><small>${s.finalResult && s.finalResult.passed ? '✅ Réussi — tu peux le rejouer quand tu veux' : rpEscapeHtml(m.final.consigne)}</small></span>
                </button>
                <button class="btn btn-gray" style="margin-top:12px;" onclick="sceneModule('${id}')">🎧 Écouter tous les dialogues du module</button>
                <button class="btn btn-gray" style="margin-top:8px;" onclick="rpPrepOpen('mod:${id}', '${rpEscapeHtml(m.titre).replace(/'/g, "\\'")} — tout le module', { type: 'mod', id: '${id}', etape: 'final' })">📚 Tout le vocabulaire du module (réviser, conjuguer, écouter)</button>`;
        }

        // ----- Portrait -----
        function modRpShowPortrait() {
            const id = modRpCurrent, m = modRpData[id], P = m.portrait;
            const p = modRpState(id).portrait;
            const opt = (list, val, getLabel) => '<option value="">—</option>' + list.map(x => { const l = getLabel(x); return `<option value="${rpEscapeHtml(l)}" ${l === val ? 'selected' : ''}>${rpEscapeHtml(l)}</option>`; }).join('');
            const num = (key, label) => `<label class="modrp-field"><span>${label}</span><input type="number" min="0" max="20" id="mp-${key}" value="${p[key] !== undefined ? rpEscapeHtml(p[key]) : ''}"></label>`;
            const checks = (key, list) => `<div class="modrp-checks">${list.map(x => `<label><input type="checkbox" data-mp="${key}" value="${rpEscapeHtml(x.fr)}" ${(p[key] || []).includes(x.fr) ? 'checked' : ''}> ${rpEscapeHtml(x.fr)}</label>`).join('')}</div>`;
            const sentences = modRpSentences(id);
            document.getElementById('modrp-content').innerHTML = `
                <button class="back-btn" onclick="modRpRenderHome()">← Le module</button>
                <h2>🪪 Mon portrait</h2>
                <p class="prep-sub">${rpEscapeHtml(P.intro)}</p>
                <div class="conj-card modrp-form">
                    <label class="modrp-field"><span>Prénom</span><input type="text" id="mp-naam" value="${rpEscapeHtml(p.naam || '')}" autocomplete="off"></label>
                    ${num('leeftijd', 'Âge')}
                    <label class="modrp-field"><span>Pays d'origine</span><select id="mp-land">${opt(P.pays, p.land, x => x.fr)}</select></label>
                    <label class="modrp-field"><span>Ville où tu habites</span><input type="text" id="mp-stad" value="${rpEscapeHtml(p.stad || '')}" placeholder="ex. Gent, Kortrijk, Brussel" autocomplete="off"></label>
                    <label class="modrp-field"><span>Situation</span><select id="mp-relatie">
                        ${[['', '—'], ['alleenstaand', 'célibataire'], ['relatie', 'en couple'], ['samenwonend', 'cohabitant'], ['getrouwd', 'marié(e)']].map(([v, l]) => `<option value="${v}" ${p.relatie === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                    ${num('kinderen', 'Enfants')}${num('broers', 'Frères')}${num('zussen', 'Sœurs')}
                    <label class="modrp-field"><span>Tu es…</span><select id="mp-situatie">
                        ${[['', '—'], ['werk', 'en emploi'], ['werkzoekend', "demandeur d'emploi"], ['student', 'étudiant(e)']].map(([v, l]) => `<option value="${v}" ${p.situatie === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                    <label class="modrp-field"><span>Métier (actuel ou recherché)</span><select id="mp-beroep">${opt(P.metiers, p.beroep, x => x.fr)}</select></label>
                    <div class="modrp-field"><span>Langues que tu parles</span>${checks('talen', P.langues)}</div>
                    <div class="modrp-field"><span>Ce que tu aimes faire</span>${checks('hobbies', P.loisirs)}</div>
                    <button class="btn btn-green" onclick="modRpSavePortrait()">💾 Enregistrer et voir mes phrases</button>
                </div>
                <div class="section-title">🗣️ Mes phrases (${sentences.length})</div>
                ${sentences.map(s => `<div class="prep-row"><span class="prep-nl">${rpEscapeHtml(s.nl)}</span><span class="prep-fr">${rpEscapeHtml(s.fr)}</span><span class="prep-actions">${speakBtnHtml(s.nl)}${reportBtnHtml({ kind: 'portrait', ref: id, nl: s.nl, fr: s.fr, context: 'phrase générée du portrait' })}</span></div>`).join('') || '<p class="report-meta">Remplis le portrait pour obtenir tes phrases.</p>'}
                <div class="section-title">➕ Autre chose à dire sur toi</div>
                <p class="report-meta">Écris en français ce que tu veux savoir dire (ex. « je suis arrivé en Belgique il y a cinq ans »). Gemini le traduit une fois, puis la phrase est gardée.</p>
                <div class="rp-help-input-row"><input type="text" id="mp-extra" placeholder="En français…" autocomplete="off"><button class="btn btn-green" id="mp-extra-btn" onclick="modRpAddExtra()">Traduire</button></div>
                <div id="mp-extra-status" class="report-meta"></div>`;
        }

        function modRpSavePortrait() {
            const id = modRpCurrent;
            const p = modRpState(id).portrait;
            ['naam', 'stad'].forEach(k => { p[k] = document.getElementById('mp-' + k).value.trim(); });
            ['leeftijd', 'kinderen', 'broers', 'zussen'].forEach(k => { const v = document.getElementById('mp-' + k).value; p[k] = v === '' ? '' : String(Math.max(0, Math.min(120, parseInt(v, 10) || 0))); });
            ['land', 'relatie', 'situatie', 'beroep'].forEach(k => { p[k] = document.getElementById('mp-' + k).value; });
            ['talen', 'hobbies'].forEach(k => { p[k] = [...document.querySelectorAll(`[data-mp="${k}"]:checked`)].map(c => c.value); });
            modRpInjectPerso(id);
            save();
            modRpShowPortrait();
        }

        async function modRpAddExtra() {
            const id = modRpCurrent;
            const input = document.getElementById('mp-extra');
            const status = document.getElementById('mp-extra-status');
            const fr = (input.value || '').trim();
            if (!fr) return;
            if (!GeminiService.getKey()) { status.innerText = 'Nécessite ta clé Gemini (Profil → 🤖 Intelligence IA).'; return; }
            status.innerText = 'Traduction...';
            try {
                const raw = await GeminiService.generate(
                    'Traduis cette phrase qu\'un francophone veut dire sur lui-même en se présentant, en néerlandais de Flandre simple (niveau A1-A2), naturel à l\'oral : """' + fr + '"""\n' +
                    'Indique aussi le thème le plus proche parmi : identite, famille, travail, loisirs.\nRéponds UNIQUEMENT en JSON : {"nl": "...", "etape": "..."}'
                );
                const obj = rpHelpParseJson(raw);
                if (!obj || !obj.nl) throw new Error('réponse illisible');
                const etape = ['identite', 'famille', 'travail', 'loisirs'].includes(obj.etape) ? obj.etape : 'identite';
                modRpState(id).extras.push({ fr, nl: String(obj.nl), etape });
                modRpInjectPerso(id);
                save();
                modRpShowPortrait();
            } catch (e) {
                status.innerText = 'Traduction impossible : ' + e.message;
            }
        }

        // ----- Étape -----
        function modRpExercises(id, e) {
            const perso = modRpSentences(id).filter(s => s.etape === e.id).map(s => ({ type: 'traduire', fr: s.fr, answer: s.nl, perso: true }));
            return (e.exercices || []).concat(perso);
        }

        function modRpShowEtape(etapeId) {
            const id = modRpCurrent, m = modRpData[id];
            const e = m.etapes.find(x => x.id === etapeId);
            if (!e) return;
            const st = modRpState(id).etapes[e.id] || {};
            const perso = modRpSentences(id).filter(s => s.etape === e.id);
            const verbFr = v => { const c = conjugationData.find(x => x.infinitief === v); return c ? c.fr : ''; };
            const row = (nl, fr) => `<div class="prep-row"><span class="prep-nl">${rpEscapeHtml(nl)}</span><span class="prep-fr">${rpEscapeHtml(fr)}</span><span class="prep-actions">${speakBtnHtml(nl)}${reportBtnHtml({ kind: 'module', ref: id + ':' + e.id, nl, fr, context: e.titre })}</span></div>`;
            const total = modRpExercises(id, e).length;
            document.getElementById('modrp-content').innerHTML = `
                <button class="back-btn" onclick="modRpRenderHome()">← Le module</button>
                <h2>${rpEscapeHtml(e.titre)}</h2>
                <p class="prep-sub">${rpEscapeHtml(e.intro)}</p>
                ${e.portrait ? `<div class="conj-card"><div class="section-title" style="margin-top:0;">🗣️ Tes phrases pour cette étape</div>
                    ${perso.map(s => row(s.nl, s.fr)).join('') || `<p class="report-meta">Remplis <a href="#" onclick="modRpShowPortrait(); return false;">ton portrait</a> pour avoir tes propres phrases ici.</p>`}</div>` : ''}
                ${(e.dialogue || []).length ? `<div class="conj-card">
                    <div class="section-title" style="margin-top:0;">🎧 Dialogue modèle</div>
                    <p class="report-meta">${rpEscapeHtml((e.roles && e.roles.A) || 'A')} et ${rpEscapeHtml((e.roles && e.roles.B) || 'toi')}. Écoute-le, puis joue le rôle de ${rpEscapeHtml((e.roles && e.roles.B) || 'B')} : l'app dit l'autre rôle et t'écoute.</p>
                    <div id="modrp-dialog">${e.dialogue.map((l, i) => `<div class="modrp-line modrp-${l.qui}" id="modrp-line-${i}"><b>${l.qui === 'A' ? rpEscapeHtml((e.roles && e.roles.A) || 'A') : rpEscapeHtml((e.roles && e.roles.B) || 'Toi')}</b> : <span class="modrp-line-nl">${rpEscapeHtml(l.nl)}</span> <small>${rpEscapeHtml(l.fr)}</small></div>`).join('')}</div>
                    <div class="prep-actions-grid" style="margin-top:10px;">
                        <button class="btn btn-gray" onclick="modRpDialog('${e.id}', 'ecoute')">▶️ Écouter</button>
                        <button class="btn btn-green" onclick="modRpDialog('${e.id}', 'jouer')">🎤 Jouer mon rôle</button>
                    </div>
                    <div id="modrp-dialog-status" class="report-meta"></div>
                </div>` : ''}
                <div class="conj-card modrp-rule">
                    <div class="section-title" style="margin-top:0;">💡 ${rpEscapeHtml(e.regle.titre)}</div>
                    <p>${rpEscapeHtml(e.regle.explication)}</p>
                    ${e.regle.exemples.map(x => row(x.nl, x.fr)).join('')}
                </div>
                <div class="section-title">🧱 Vocabulaire</div>
                ${e.vocab.verbes.map(v => row(v, verbFr(v))).join('')}
                ${e.vocab.mots.map(x => row(x.nl, x.fr)).join('')}
                ${e.vocab.phrases.map(x => row(x.nl, x.fr)).join('')}
                <div class="prep-actions-grid" style="margin-top:14px;">
                    <button class="btn btn-green" onclick="modRpStartEx('${e.id}')">✍️ Exercices (${total})${st.best !== undefined ? ' · record ' + st.best + '/' + total : ''}</button>
                    <button class="btn btn-gray" onclick="modRpPlay('${id}', '${e.id}')">🎭 Jouer : ${rpEscapeHtml(e.jeu.titre)}</button>
                    <button class="btn btn-gray" onclick="rpPrepOpen('mod:${id}:${e.id}', '${rpEscapeHtml(e.titre).replace(/'/g, "\\'")}', { type: 'mod', id: '${id}', etape: '${e.id}' })">📚 Réviser, conjuguer, écouter</button>
                </div>
                <div id="modrp-ex"></div>`;
        }

        // ----- Dialogue modèle -----
        // « ecoute » : l'app lit tout le dialogue. « jouer » : elle lit les répliques de A ; pour
        // celles de B, elle cache le texte, montre le français, écoute l'apprenant et compare
        // (rpSpeechMatch), puis lit la bonne réplique. Moteur audio commun (Pause/Arrêt, écran).
        async function modRpDialog(etapeId, mode) {
            const e = modRpData[modRpCurrent].etapes.find(x => x.id === etapeId);
            if (!e || !e.dialogue) return;
            conjAudioStop();
            const run = { stop: false, paused: false, skip: false, wakeLock: null, viewId: 'modrp-view' };
            conjAudioRun = run;
            const status = document.getElementById('modrp-dialog-status');
            const lines = e.dialogue;
            let ok = 0, asked = 0;
            const lineEl = i => document.getElementById('modrp-line-' + i);
            document.querySelectorAll('#modrp-dialog .modrp-line').forEach(el => el.classList.remove('active', 'good', 'bad'));
            if (mode === 'jouer') document.querySelectorAll('#modrp-dialog .modrp-B .modrp-line-nl').forEach(el => el.classList.add('hidden'));
            for (let i = 0; i < lines.length && !run.stop; i++) {
                const l = lines[i], el = lineEl(i);
                if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
                if (mode === 'jouer' && l.qui === 'B') {
                    asked++;
                    if (status) status.innerText = '🎤 À toi : ' + l.fr;
                    let heard = await conjAudioListen();
                    if (run.stop) break;
                    if (heard && heard.denied) { if (status) status.innerText = 'Micro refusé : autorise-le dans le navigateur.'; break; }
                    let good = !!heard && heard.some(h => rpSpeechMatch(h, l.nl));
                    if (!good && !run.stop) {
                        if (status) status.innerText = '🔁 Écoute et répète : ' + l.fr;
                        await conjAudioSay(l.nl, 'nl', 0.9);
                        heard = await conjAudioListen();
                        good = !!heard && heard.some(h => rpSpeechMatch(h, l.nl));
                    } else if (good) ok++;
                    if (el) { el.querySelector('.modrp-line-nl').classList.remove('hidden'); el.classList.add(good ? 'good' : 'bad'); }
                    if (good) await conjAudioWait(400); else await conjAudioSay(l.nl, 'nl', 0.9);
                } else {
                    await conjAudioSay(l.nl, 'nl', 0.95);
                    await conjAudioWait(250);
                }
                if (el) el.classList.remove('active');
            }
            if (conjAudioRun === run) {
                conjAudioRelease(run);
                conjAudioRun = null;
                document.querySelectorAll('#modrp-dialog .modrp-line-nl').forEach(el => el.classList.remove('hidden'));
                if (status) status.innerText = mode === 'jouer' ? `Terminé : ${ok}/${asked} répliques réussies du premier coup.` : '';
            }
        }

        // ----- Exercices -----
        function modRpStartEx(etapeId) {
            const id = modRpCurrent;
            const e = modRpData[id].etapes.find(x => x.id === etapeId);
            modRpEx = { etapeId, list: modRpExercises(id, e), i: 0, score: 0, built: [] };
            modRpRenderEx();
            document.getElementById('modrp-ex').scrollIntoView({ block: 'start' });
        }

        function modRpRenderEx() {
            const ex = modRpEx, box = document.getElementById((ex && ex.boxId) || 'modrp-ex');
            if (!ex || !box) return;
            if (ex.i >= ex.list.length && ex.onDone) { const f = ex.onDone; ex.onDone = null; f(ex); return; }
            if (ex.i >= ex.list.length) {
                const id = modRpCurrent;
                const st = modRpState(id).etapes[ex.etapeId] || (modRpState(id).etapes[ex.etapeId] = {});
                st.best = Math.max(st.best || 0, ex.score);
                save();
                box.innerHTML = `<div class="conj-card"><div class="conj-verb-title">Résultat : ${ex.score}/${ex.list.length}</div>
                    <p class="report-meta">${ex.score >= Math.ceil(0.7 * ex.list.length) ? 'Bien joué ! Passe au jeu de rôle de l\'étape.' : 'Refais-les une fois : il faut 70 % pour valider l\'étape.'}</p>
                    <button class="btn btn-green" onclick="modRpPlay('${id}', '${ex.etapeId}')">🎭 Jouer l'étape</button>
                    <button class="btn btn-gray" onclick="modRpStartEx('${ex.etapeId}')">🔁 Recommencer</button></div>`;
                return;
            }
            const q = ex.list[ex.i];
            ex.built = [];
            const head = `<div class="report-meta">Exercice ${ex.i + 1}/${ex.list.length} · Score ${ex.score}${q.perso ? ' · 🪪 ta phrase' : ''}</div>`;
            let body = '';
            if (q.type === 'qcm') {
                body = `<div class="conj-question-fr" style="font-size:1.05rem;">${rpEscapeHtml(q.q)}</div>
                    <div class="modrp-choices">${q.choices.map((c, i) => `<button class="rp-scenario-btn" onclick="modRpCheck(${i})">${rpEscapeHtml(c)}</button>`).join('')}</div>`;
            } else if (q.type === 'ordre') {
                const shuffled = q.mots.map((w, i) => ({ w, i })).sort(() => Math.random() - 0.5);
                body = `<div class="conj-question-hint">Remets dans l'ordre : ${rpEscapeHtml(q.fr || '')}</div>
                    <div id="modrp-built" class="modrp-built">…</div>
                    <div class="rpw-chips">${shuffled.map(x => `<button type="button" class="conj-filter-chip" data-w="${rpEscapeHtml(x.w)}" onclick="modRpPick(this)">${rpEscapeHtml(x.w)}</button>`).join('')}</div>
                    <div class="prep-actions-grid" style="margin-top:10px;"><button class="btn btn-gray" onclick="modRpRenderEx()">↺ Effacer</button><button class="btn btn-green" onclick="modRpCheck()">Vérifier</button></div>`;
            } else {
                const say = s => `speakNL('${String(s).replace(/\\/g, '').replace(/'/g, "\\'")}')`;
                const prompt = q.type === 'trou' ? `<div class="conj-question-fr">${rpEscapeHtml(q.phrase)}</div><div class="conj-question-hint">${rpEscapeHtml(q.fr || '')} — complète le mot manquant</div>`
                    : q.type === 'traduire' ? `<div class="conj-question-fr">${rpEscapeHtml(q.fr)}</div><div class="conj-question-hint">Écris-le ou dis-le en néerlandais</div>`
                    : q.type === 'dire' ? `<div class="modrp-oral-tag">🗣️ Dis-le à voix haute</div><div class="conj-question-fr">${rpEscapeHtml(q.fr)}</div><div class="conj-question-hint">Appuie sur 🎤 et dis la phrase en néerlandais</div>`
                    : q.type === 'repondre' ? `<div class="modrp-oral-tag">💬 Réponds à la question</div><div class="conj-question-fr">🔊 …</div><button class="btn btn-gray" onclick="${say(q.question)}">🔊 Réécouter la question</button>
                        <details class="conj-question-hint"><summary>Voir la question</summary>${rpEscapeHtml(q.question)} — ${rpEscapeHtml(q.question_fr || '')}</details>`
                    : `<div class="conj-question-hint">Écoute et écris (ou répète) ce que tu entends</div><button class="btn btn-gray" onclick="${say(q.nl)}">🔊 Réécouter</button>`;
                const oral = q.type === 'dire' || q.type === 'repondre';
                body = `${prompt}
                    <div class="modrp-answer-row">
                        <input type="text" id="modrp-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${oral ? 'Ce que tu as dit apparaît ici…' : 'En néerlandais…'}" onkeypress="if(event.key==='Enter') modRpCheck()">
                        <button type="button" class="btn ${oral ? 'btn-green' : 'btn-gray'} modrp-mic" id="modrp-mic" onclick="modRpMic()">🎤</button>
                    </div>
                    <button class="btn btn-green" onclick="modRpCheck()">Vérifier</button>`;
            }
            box.innerHTML = `<div class="conj-card">${head}${body}<div class="acc-error" id="modrp-fb" style="margin-top:8px;"></div></div>`;
            if (ex.onRender) { ex.onRender(q); return; }
            if (q.type === 'ecoute') speakNL(q.nl);
            if (q.type === 'repondre') speakNL(q.question);
            const input = document.getElementById('modrp-input');
            if (input) input.focus();
        }

        // Reconnaissance vocale tolérante : au moins 75 % des mots attendus entendus (tous pour une
        // phrase de 3 mots ou moins). La dictée oublie souvent ponctuation et petits mots.
        function rpSpeechMatch(heard, target) {
            const words = s => normalize(s).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
            const t = words(target), h = new Set(words(heard));
            if (!t.length) return false;
            const found = t.filter(w => h.has(w)).length;
            return t.length <= 3 ? found === t.length : found / t.length >= 0.75;
        }

        // 🎤 : une écoute courte (instance de reconnaissance dédiée) qui remplit le champ puis vérifie.
        async function modRpMic() {
            const btn = document.getElementById('modrp-mic');
            const input = document.getElementById('modrp-input');
            if (!window.SpeechRecognition) { alert("La reconnaissance vocale n'est pas disponible dans ce navigateur (utilise Chrome). Tu peux écrire ta réponse."); return; }
            if (btn) { btn.innerText = '👂'; btn.disabled = true; }
            const heard = await conjAudioListen();
            if (btn) { btn.innerText = '🎤'; btn.disabled = false; }
            if (heard && heard.denied) { alert('Micro refusé : autorise-le dans le navigateur.'); return; }
            if (!heard || !heard.length) { if (input) input.placeholder = 'Rien entendu, réessaie ou écris.'; return; }
            if (input) input.value = heard[0];
            if (modRpEx) modRpEx.heard = heard;
            modRpCheck();
        }

        function modRpPick(btn) {
            modRpEx.built.push(btn.dataset.w);
            btn.disabled = true;
            btn.style.opacity = 0.35;
            document.getElementById('modrp-built').innerText = modRpEx.built.join(' ');
        }

        function modRpCheck(choice) {
            const ex = modRpEx;
            if (!ex || ex.checking) return;
            const q = ex.list[ex.i];
            let ok, expected;
            if (q.type === 'qcm') { ok = choice === q.answer; expected = q.choices[q.answer]; }
            else if (q.type === 'ordre') {
                const clean = s => normalize(s).replace(/[.?!,]/g, '').trim();
                ok = clean(ex.built.join(' ')) === clean(q.answer); expected = q.answer;
            } else if (q.type === 'repondre') {
                const alts = (ex.heard && ex.heard.length) ? ex.heard : [(document.getElementById('modrp-input') || {}).value || ''];
                const need = (q.attendu || []).map(w => normalize(w));
                const oneOf = (q.un_de || []).map(w => normalize(w));
                const has = (t, w) => t.includes(' ' + w + ' ') || t.includes(' ' + w);
                ok = alts.some(a => { const t = ' ' + normalize(a).replace(/[^a-z0-9' ]/g, ' ') + ' '; return need.every(w => has(t, w)) && (!oneOf.length || oneOf.some(w => has(t, w))); });
                expected = q.exemple || q.attendu.join(' … ');
            } else {
                const val = (document.getElementById('modrp-input') || {}).value || '';
                const target = q.type === 'ecoute' || q.type === 'dire' ? q.nl : q.answer;
                const targets = String(target).split('/').map(s => s.replace(/[.?!]+$/, ''));
                ok = evaluateAnswer(val.replace(/[.?!]+$/, ''), targets.join('/')).status !== 'wrong'
                    || ((ex.heard || []).some(h => targets.some(t => rpSpeechMatch(h, t))));
                expected = targets[0];
            }
            ex.heard = null;
            ex.checking = true;
            if (ok) ex.score++;
            (ex.results || (ex.results = []))[ex.i] = ok;
            modRpEtapeNotions(modRpCurrent, ex.etapeId).forEach(n => { if (curriculumNotions[n]) recordNotionAttempt(n, ok); });
            if (ex.onCheck) ex.onCheck(ok, expected);
            const fb = document.getElementById('modrp-fb');
            fb.style.color = ok ? 'var(--success)' : 'var(--wrong)';
            fb.innerHTML = (ok ? '✅ ' : '❌ Réponse : ') + rpEscapeHtml(expected) + ' ' + speakBtnHtml(expected) +
                (ok ? '' : ' ' + reportBtnHtml({ kind: 'module', ref: modRpCurrent + ':' + ex.etapeId, nl: expected, fr: q.fr || q.q || '', context: 'exercice ' + q.type }));
            setTimeout(() => { ex.checking = false; ex.i++; modRpRenderEx(); }, ok ? 1100 : 2600);
        }

        // ----- Jeu de rôle d'une étape ou final -----
        function modRpRolePrompt(id, etapeId) {
            const m = modRpData[id];
            const isFinal = etapeId === 'final';
            const e = isFinal ? null : m.etapes.find(x => x.id === etapeId);
            const jeu = isFinal ? m.final : e.jeu;
            const perso = modRpSentences(id).filter(s => isFinal || s.etape === etapeId);
            const words = isFinal ? [] : e.vocab.verbes.concat(e.vocab.mots.map(x => x.nl));
            const prompt = 'Tu joues un rôle dans un jeu de rôle avec un apprenant francophone qui débute en néerlandais (niveau ' + (m.niveau || 'A1') + ').\n' +
                'Ton rôle : ' + jeu.role + '\n' +
                'Parle exclusivement en néerlandais de Flandre très simple : phrases courtes, mots très courants, une seule question à la fois. Réagis à ce que dit réellement l\'apprenant, ne corrige jamais sa langue et ne sors jamais de ton rôle. Si l\'apprenant semble perdu, reformule plus simplement.\n' +
                (words.length ? 'Emploie naturellement ces mots de la leçon : ' + words.join(', ') + '.\n' : '') +
                (perso.length ? 'Voici ce que l\'apprenant a préparé sur lui (ne le récite pas : pose tes questions et laisse-le le dire ; s\'il oublie un point, relance-le dessus) : ' + perso.map(s => s.nl).join(' ') + '\n' : '') +
                '\nTu as déjà ouvert la conversation en disant : """' + jeu.welcome + '""" — enchaîne à partir de sa réponse.';
            return { jeu, perso, prompt };
        }

        function modRpPlay(id, etapeId) {
            const m = modRpData[id];
            if (!m) return;
            if (!GeminiService.getKey()) { alert("Le jeu de rôle a besoin de ta clé Gemini (Profil → 🤖 Intelligence IA). Les exercices et le vocabulaire marchent sans."); return; }
            const isFinal = etapeId === 'final';
            const { jeu, perso, prompt } = modRpRolePrompt(id, etapeId);
            const st = modRpState(id);
            if (isFinal) st.final = true; else (st.etapes[etapeId] || (st.etapes[etapeId] = {})).played = true;
            save();
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('roleplay-view').classList.add('active');
            setActiveNav('nav-apprendre');
            renderRpGeminiStatus();
            rpCurrentCategory = '__mod:' + id;
            rpDayState = null;
            rpBeginScenario({ id: 'mod_' + id + '__' + etapeId, lang: 'nl', label: m.titre + ' — ' + jeu.titre, welcome: jeu.welcome, prompt });
            const banner = document.getElementById('rp-mode-banner');
            banner.style.display = '';
            banner.innerHTML = `
                <div class="rp-job-banner">
                    <div class="rp-iv-label" style="margin-top:0;">${rpEscapeHtml(m.titre)} · ${rpEscapeHtml(jeu.titre)}${isFinal ? ' · 🏆 examen du module' : ''}</div>
                    <div>🎯 ${rpEscapeHtml(jeu.consigne)}</div>
                    ${isFinal ? '<div class="report-meta">Quand tu as tout dit (ou si ton interlocuteur ne relance plus), clique sur « 🏁 J\'ai fini » : tu auras ton bilan et le verdict du module.</div>' : ''}
                    ${perso.length ? `<details><summary>🗣️ Mes phrases (${perso.length})</summary><ul class="rp-case-figures">${perso.map(s => `<li>${rpEscapeHtml(s.nl)} <small>— ${rpEscapeHtml(s.fr)}</small></li>`).join('')}</ul></details>` : ''}
                </div>`;
            const nav = document.getElementById('rp-day-nav');
            nav.style.display = 'block';
            nav.innerHTML = isFinal
                ? `<button class="btn btn-gray" id="modrp-finish-btn" style="margin:0;" onclick="modRpEvaluateFinal('${id}')">🏁 J'ai fini : évaluer ma présentation</button>`
                : `<button class="btn btn-gray" style="margin:0;" onclick="showModuleRp('${id}'); modRpShowEtape('${etapeId}')">✅ Terminer et revenir à l'étape</button>`;
        }

        // ----- Examen : jeu de rôle final → bilan et verdict du module -----
        // Deux parties : une liste de contrôle calculée par l'app (les sujets du module abordés
        // dans les répliques de l'apprenant), puis l'avis d'un « examinateur » Gemini (appel séparé,
        // jamais mêlé au prompt du personnage). Verdict : sujets abordés ≥ 75 % ET note de
        // communication ≥ 6/10 (sans Gemini disponible, la liste de contrôle seule décide).
        const MODRP_TOPICS = [
            { key: 'naam', etape: 'identite', label: 'ton prénom', test: (t, p) => (p.naam && t.includes(normalize(p.naam))) || /\b(ik heet|mijn naam)\b/.test(t) },
            { key: 'leeftijd', etape: 'identite', label: 'ton âge', test: (t, p) => (p.leeftijd && new RegExp('\\b' + p.leeftijd + '\\b').test(t)) || /\bjaar\b/.test(t) },
            { key: 'land', etape: 'identite', label: "d'où tu viens", test: t => /\b(kom uit|afkomstig|belgisch|frans|marokkaans|nationaliteit)\b/.test(t) },
            { key: 'stad', etape: 'identite', label: 'où tu habites', test: (t, p) => (p.stad && t.includes(normalize(p.stad))) || /\bwoon\b/.test(t) },
            { key: 'famille', etape: 'famille', label: 'ta famille', test: t => /\b(broer|broers|zus|zussen|kind|kinderen|getrouwd|alleenstaand|partner|ouders|familie|vrouw|man)\b/.test(t) },
            { key: 'travail', etape: 'travail', label: 'ton travail ou tes études', test: t => /\b(werk|werkzoekend|student|studeer|studeren|job|bedrijf|beroep|zoek werk)\b/.test(t) },
            { key: 'talen', etape: 'loisirs', label: 'les langues que tu parles', test: t => /\b(spreek|talen|frans|engels|nederlands|arabisch)\b/.test(t) },
            { key: 'hobbies', etape: 'loisirs', label: 'tes loisirs', test: t => /\b(graag|hobby|hobby's|vrije tijd|sport|sporten)\b/.test(t) }
        ];

        async function modRpEvaluateFinal(id) {
            const m = modRpData[id];
            if (!m) return;
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            const userLines = rpConversationHistory.slice(1).filter(x => x.role === 'user').map(x => x.parts[0].text);
            const { checks, covered, coverageOk } = modRpExamChecks(id, userLines);
            rpJobHideNav();

            document.getElementById('rp-step-chat').style.display = 'none';
            document.getElementById('rp-step-debrief').style.display = 'flex';
            rpFillDebriefWords();
            const box = document.getElementById('rp-debrief-content');
            const checklist = `
                <div class="rp-iv-label">📋 Les sujets abordés (${covered}/${checks.length})</div>
                ${checks.map(c => `<div class="modrp-check ${c.ok ? 'ok' : 'ko'}">${c.ok ? '✓' : '✗'} ${rpEscapeHtml(c.label)}</div>`).join('')}`;
            const render = (judge) => {
                const score = judge && typeof judge.note === 'number' ? judge.note : null;
                const passed = coverageOk && (score === null || score >= 6);
                const st = modRpState(id);
                st.finalResult = { passed: passed || !!(st.finalResult && st.finalResult.passed), lastScore: score, lastCovered: covered, at: Date.now() };
                save();
                const missing = checks.filter(c => !c.ok);
                if (passed) modRpValidateNotions(id); else modRpFlagMissing(id, missing.map(c => c.etape));
                const etapesToReview = [...new Set(missing.map(c => c.etape))].map(eid => m.etapes.find(e => e.id === eid)).filter(Boolean);
                const arr = x => Array.isArray(x) ? x : [];
                box.innerHTML = `
                    <div class="conj-card" style="text-align:left;">
                        <div class="conj-verb-title">${passed ? '✅ Module réussi !' : '🔁 Presque : encore un essai'}</div>
                        <p class="report-meta">${passed ? (m.examen && m.examen.reussite ? rpEscapeHtml(m.examen.reussite) : 'Objectif atteint.') + ' 🏆 Le module est validé.' : 'Pour valider le module : parler d\'au moins ' + Math.ceil(0.75 * checks.length) + ' sujets sur ' + checks.length + (score !== null ? ' et obtenir au moins 6/10 en communication.' : '.')}</p>
                        ${checklist}
                        ${judge ? `
                            <div class="rp-iv-label">🗣️ Communication : ${score !== null ? score + '/10' : '—'}</div>
                            ${judge.resume ? `<p>${rpEscapeHtml(judge.resume)}</p>` : ''}
                            ${arr(judge.points_forts).length ? `<div class="rp-iv-label">👍 Points forts</div><ul>${arr(judge.points_forts).map(x => `<li>${rpEscapeHtml(x)}</li>`).join('')}</ul>` : ''}
                            ${arr(judge.corrections).length ? `<div class="rp-iv-label">✍️ À corriger</div>${arr(judge.corrections).map(c => `
                                <div class="rp-debrief-item"><div class="rp-debrief-sub">« ${rpEscapeHtml(c.phrase || '')} »</div>
                                <div><b>${rpEscapeHtml(c.correction || '')}</b> ${c.correction ? speakBtnHtml(c.correction) : ''}</div>
                                <div class="rp-debrief-sub">${rpEscapeHtml(c.explication || '')}</div></div>`).join('')}` : ''}
                            ${judge.conseil ? `<div class="rp-iv-label">💡 Conseil</div><p>${rpEscapeHtml(judge.conseil)}</p>` : ''}`
                            : '<p class="report-meta">Avis détaillé indisponible (Gemini) : verdict basé sur les sujets abordés.</p>'}
                        ${!passed && missing.length ? `<div class="rp-iv-label">➡️ Suggestions</div>
                            <p>Tu n'as pas parlé de : ${missing.map(c => rpEscapeHtml(c.label)).join(', ')}. Revois ${etapesToReview.length > 1 ? 'ces étapes' : 'cette étape'}, puis rejoue :</p>
                            ${etapesToReview.map(e => `<button class="btn btn-gray" onclick="showModuleRp('${id}'); modRpShowEtape('${e.id}')">📖 ${rpEscapeHtml(e.titre)}</button>`).join('')}` : ''}
                        <button class="btn btn-green" style="margin-top:12px;" onclick="modRpPlay('${id}', 'final')">🔁 Rejouer l'examen</button>
                        <button class="btn btn-gray" onclick="showModuleRp('${id}')">← Retour au module</button>
                    </div>`;
            };
            if (!userLines.length) {
                box.innerHTML = `<div class="conj-card">${checklist}<p>Tu n'as encore rien dit : présente-toi d'abord !</p>
                    <button class="btn btn-gray" onclick="document.getElementById('rp-step-debrief').style.display='none'; document.getElementById('rp-step-chat').style.display='flex'; document.getElementById('rp-day-nav').style.display='block';">↩ Revenir à la conversation</button></div>`;
                document.getElementById('rp-day-nav').innerHTML = `<button class="btn btn-gray" style="margin:0;" onclick="modRpEvaluateFinal('${id}')">🏁 J'ai fini : évaluer ma présentation</button>`;
                return;
            }
            box.innerHTML = `<div class="conj-card" style="text-align:left;">${checklist}<p class="report-meta">L'examinateur analyse ta présentation...</p></div>`;
            const transcript = rpConversationHistory.slice(1).map(x => (x.role === 'user' ? 'APPRENANT : ' : 'INTERLOCUTEUR : ') + x.parts[0].text).join('\n');
            render(await modRpExamJudge(id, transcript));
        }

        // Liste de contrôle de l'examen : les sujets du module abordés dans les répliques.
        function modRpExamChecks(id, userLines) {
            const m = modRpData[id];
            const p = modRpState(id).portrait;
            const text = normalize(userLines.join(' '));
            const topics = (m.examen && Array.isArray(m.examen.sujets)) ? m.examen.sujets.map(s => ({
                key: s.label, etape: s.etape, label: s.label,
                // Motifs spéciaux : « #epeler » = au moins trois lettres isolées à la suite (« k a y e m b e ») ;
                // « #perfectum-hebben / -zijn » = auxiliaire puis participe dans la même phrase.
                test: (t, pp) => (s.mots || []).some(w => w[0] === '#' && (MODRP_SPECIAL[w] || /$^/).test(t)) || (s.mots || []).filter(w => w[0] !== '#').some(w => new RegExp('(^|[^a-z])' + normalize(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])').test(t))
                    || (s.portrait && pp[s.portrait] && t.includes(normalize(String(pp[s.portrait]))))
            })) : MODRP_TOPICS;
            const checks = topics.map(t => Object.assign({ ok: !!text && t.test(text, p) }, t));
            const covered = checks.filter(c => c.ok).length;
            return { checks, covered, coverageOk: covered >= Math.ceil(0.75 * checks.length) };
        }

        // Avis de l'examinateur (appel Gemini séparé) ; null si indisponible.
        async function modRpExamJudge(id, transcript) {
            const m = modRpData[id];
            let judge = null;
            if (GeminiService.getKey()) {
                try {
                    const raw = await GeminiService.generate(
                        'Tu es examinateur de néerlandais pour francophones (niveau ' + m.niveau + '). Un apprenant a passé l\'examen oral du module « ' + m.titre + ' ». Consigne qu\'il avait : ' + m.final.consigne + ' Ses répliques peuvent avoir été dictées : ignore ponctuation et majuscules.\n\n' +
                        'Interlocuteur : ' + m.final.welcome + '\n' + transcript + '\n\n' +
                        'Évalue UNIQUEMENT les répliques de l\'APPRENANT, avec bienveillance et pour son niveau : l\'important est d\'être compris et d\'accomplir la tâche, pas la perfection. Réponds UNIQUEMENT en JSON :\n' +
                        '{"note": nombre de 0 à 10 (capacité à accomplir la tâche de façon compréhensible), "resume": "en français, 1-2 phrases", "points_forts": ["en français, 2 maximum"], ' +
                        '"corrections": [{"phrase": "ce qu\'il a dit", "correction": "en néerlandais", "explication": "en français, courte"}], "conseil": "en français, un conseil prioritaire"}\n3 corrections maximum, les plus utiles.'
                    );
                    judge = rpHelpParseJson(raw);
                    if (judge && typeof judge.note === 'string') judge.note = parseFloat(judge.note);
                    if (judge && (typeof judge.note !== 'number' || isNaN(judge.note))) judge.note = null;
                } catch (e) { judge = null; }
            }
            return judge;
        }

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
            const saved = state.settings && state.settings.jobMetier;
            if (!metiers.includes(rpJobMetier)) rpJobMetier = metiers.includes(saved) ? saved : metiers[0];
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
                    rpPrepRow(`<button class="rp-scenario-btn" onclick="rpStartSituation('${s.id}')">${rpEscapeHtml(rpSitTitle(s))}${rpSitLang(s) === 'en' ? ' <span class="wl-badge unseen">🇬🇧 en anglais</span>' : ''}</button>`, 'sit:' + s.id, rpSitTitle(s), { type: 'sit', id: s.id })
                ).join('')
            ).join('');

            listDiv.innerHTML = `
                <div class="rp-group-title">${RP_JOB_METIERS[rpJobMetier] || rpEscapeHtml(rpJobMetier)}</div>
                <p class="rp-real-hint">Tu es en poste : clients, collègues et utilisateurs viennent vers toi, à toi de gérer.</p>
                <details class="rp-more" style="width:100%; max-width:520px;"><summary>Changer de métier</summary>
                    <div class="conj-filter-chips-row">${metiers.map(m => chip(m === rpJobMetier, `rpJobSetMetier('${m}')`, RP_JOB_METIERS[m] || rpEscapeHtml(m))).join('')}</div>
                </details>
                <div class="rp-group-title">🏢 Au bureau</div>
                <button class="rp-scenario-btn" onclick="rpShowLibrary('travail')">🏢 Situations de bureau : réunion, collègues, fournisseurs, congé, évaluation…</button>
                <div class="rp-group-title">📅 Journée complète</div>
                <p class="rp-real-hint">Plusieurs situations à la suite, puis un bilan : vocabulaire à retenir et formulations corrigées.</p>
                <div class="conj-filter-chips-row" style="width:100%; max-width:520px;">
                    ${chip(rpJobDuration === 'courte', "rpJobSetDuration('courte')", `Courte · ${RP_JOB_DURATIONS.courte} situations`)}
                    ${chip(rpJobDuration === 'longue', "rpJobSetDuration('longue')", `Longue · ${RP_JOB_DURATIONS.longue} situations`)}
                </div>
                ${journees.map(x => rpPrepRow(`<button class="rp-scenario-btn" onclick="rpStartDay(${x.i})">${rpEscapeHtml(x.j.label)}</button>`, 'day:' + x.j.id, x.j.label, { type: 'day', index: x.i })).join('')}
                <button class="rp-scenario-btn" onclick="rpStartDay(-1)">🎲 Journée tirée au sort · ${Math.min(size, bank.length)} situations</button>
                <div class="rp-group-title">🎯 Situation isolée</div>
                ${isolated}
                ${Object.keys(data.fiches).length ? `
                <div class="rp-group-title">📋 Fiches réflexes</div>
                <p class="rp-real-hint">Que faire dans chaque situation : les étapes habituelles en entreprise et les phrases pour les dérouler.</p>
                <button class="rp-scenario-btn" onclick="rpShowPlaybooks()">📋 Voir toutes les fiches réflexes</button>` : ''}`;
        }

        function rpJobSetMetier(m) { rpJobMetier = m; if (!state.settings) state.settings = {}; state.settings.jobMetier = m; save(); rpShowJobHome(); }
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
                    ${rpPlaybookDetailsHtml(s.id, '📋 Marche à suivre (essaie d\'abord sans)')}
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
            rpDayState = { label: journee ? journee.label : 'Journée tirée au sort', journeeId: journee ? journee.id : null, situations, index: 0, log: [] };
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

        function rpFillDebriefWords() {
            const el = document.getElementById('rp-debrief-words');
            if (!el) return;
            const html = rpWordsReportHtml();
            el.innerHTML = html ? `<div class="conj-card" style="text-align:left;">${html}</div>` : '';
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
            rpFillDebriefWords();
            const box = document.getElementById('rp-debrief-content');
            const header = `<div class="conj-verb-title">🏁 Bilan — ${rpEscapeHtml(day.label)}</div>`;
            const footer = `${usedSessionHtml()}
                <button class="btn btn-green" style="margin-top:14px;" onclick="tutorOpen('day')">🧑‍🏫 Revoir avec mon tuteur</button>
                <button class="btn btn-gray" style="margin-top:8px;" onclick="rpShowJobHome()">Nouvelle journée</button>
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
                        return `<div class="rp-debrief-item"><b>${i + 1}. ${rpEscapeHtml(rpSitCanal(e.situation).label)}</b> — ${rpEscapeHtml(rpSitTitle(e.situation))}${r && r.resume ? `<div class="rp-debrief-sub">${rpEscapeHtml(r.resume)}</div>` : ''}${rpPlaybookDetailsHtml(e.situation.id, '📋 La marche à suivre recommandée')}</div>`;
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
            { key: 'transporteur', metier: 'logistique', label: '🚚 Choisir un transporteur', sujet: 'choisir entre deux transporteurs (prix, délai, fiabilité)' },
            { key: 'retard', metier: 'logistique', label: '⏰ Retards de livraison', sujet: 'des livraisons en retard chez un client important : que proposer ?' },
            { key: 'stock', metier: 'logistique', label: '📦 Niveau de stock', sujet: 'un stock trop élevé ou des ruptures fréquentes : comment ajuster ?' },
            { key: 'tournee', metier: 'logistique', label: '🗺️ Organiser une tournée', sujet: 'organiser ou réorganiser une tournée de livraison avec des contraintes' },
            { key: 'entrepot', metier: 'logistique', label: '🏭 Coût d\'entrepôt', sujet: 'réduire le coût ou améliorer l\'organisation d\'un entrepôt' },
            { key: 'fournisseur', metier: 'logistique', label: '🤝 Problème fournisseur', sujet: 'un fournisseur qui livre mal ou en retard : garder, renégocier ou changer ?' },
            { key: 'ba_processus', metier: 'business_analyst', label: '🔄 Améliorer un processus', sujet: 'un processus administratif lent (par exemple le traitement des factures) : où se perd le temps et que proposer ?' },
            { key: 'ba_outil', metier: 'business_analyst', label: '🧰 Choisir un outil', sujet: 'choisir entre deux logiciels, ou un développement sur mesure, pour un besoin métier : coût, délai, adoption par les utilisateurs' },
            { key: 'ba_business_case', metier: 'business_analyst', label: '💶 Petit business case', sujet: 'un projet d\'automatisation est-il rentable ? coût du projet contre temps gagné par les équipes' },
            { key: 'ba_priorites', metier: 'business_analyst', label: '📋 Prioriser des demandes', sujet: 'cinq demandes d\'utilisateurs pour une capacité limitée au prochain sprint : lesquelles faire d\'abord, et pourquoi ?' },
            { key: 'ba_chiffres', metier: 'business_analyst', label: '📊 Lire des chiffres', sujet: 'un tableau de bord montre une baisse (ventes, satisfaction ou délais) : quelles questions poser et quelles hypothèses vérifier ?' },
            { key: 'cj_estimation', metier: 'consultant_junior', label: '🔢 Estimation (guesstimate)', sujet: 'une estimation à faire à voix haute (par exemple la taille d\'un marché ou un nombre de clients en Belgique) : le candidat doit découper le problème et poser ses hypothèses ; pas de bonne réponse unique' },
            { key: 'cj_rentabilite', metier: 'consultant_junior', label: '📉 Baisse de bénéfice', sujet: 'un client voit son bénéfice baisser alors que son chiffre d\'affaires augmente : chercher les causes (coûts, prix, mix de produits)' },
            { key: 'cj_croissance', metier: 'consultant_junior', label: '🚀 Croissance', sujet: 'un client veut grandir : nouveau produit, nouvelle région ou nouveaux clients ? choisir et justifier' },
            { key: 'cj_organisation', metier: 'consultant_junior', label: '🏢 Organisation', sujet: 'une équipe ou un service fonctionne mal (délais, erreurs, ambiance) : que regarder en premier et que recommander ?' },
            { key: 'pj_planning', metier: 'projet_junior', label: '📅 Planning qui dérape', sujet: 'un projet prend du retard à cause d\'une tâche bloquante : comment remettre le planning sur les rails ?' },
            { key: 'pj_budget', metier: 'projet_junior', label: '💶 Budget dépassé', sujet: 'le budget d\'un projet sera dépassé : réduire le périmètre, demander plus d\'argent ou décaler ?' },
            { key: 'pj_ressources', metier: 'projet_junior', label: '👥 Manque de personnes', sujet: 'deux personnes de l\'équipe partent en plein projet : comment réorganiser le travail ?' },
            { key: 'pj_priorites', metier: 'projet_junior', label: '⚖️ Deux projets en conflit', sujet: 'deux projets ont besoin des mêmes personnes au même moment : comment choisir et convaincre ?' },
            { key: 'bib_jeunes', metier: 'bibliotheque', label: '🧒 Attirer les jeunes', sujet: 'les 12-18 ans ne viennent presque plus à la bibliothèque : quelles actions proposer avec un petit budget ?' },
            { key: 'bib_activite', metier: 'bibliotheque', label: '🎉 Organiser une activité', sujet: 'organiser une activité (heure du conte, atelier numérique, club de lecture) pour un public précis : public, date, budget, communication' },
            { key: 'bib_budget', metier: 'bibliotheque', label: '💶 Budget d\'achat', sujet: 'un budget d\'achat limité pour l\'année : quels types de documents acheter en priorité (romans, livres pour enfants, livres en néerlandais facile, numérique) et pourquoi ?' },
            { key: 'bib_espace', metier: 'bibliotheque', label: '🪑 Réaménager l\'espace', sujet: 'la bibliothèque manque de place et les étudiants se plaignent du bruit : comment réorganiser l\'espace ?' },
            { key: 'da_baisse', metier: 'data_analyst', label: '📉 Expliquer une baisse', sujet: 'les ventes d\'un produit baissent depuis trois mois : quelles données regarder, dans quel ordre, et quelles hypothèses tester ?' },
            { key: 'da_kpi', metier: 'data_analyst', label: '🎯 Choisir des indicateurs', sujet: 'un service veut un tableau de bord : quels 3 à 5 indicateurs proposer, et pourquoi ?' },
            { key: 'da_qualite', metier: 'data_analyst', label: '🧹 Données douteuses', sujet: 'un fichier client contient des doublons, des valeurs vides et des dates incohérentes : comment s\'y prendre avant toute analyse ?' },
            { key: 'da_test', metier: 'data_analyst', label: '🧪 Tester une action', sujet: 'le marketing veut savoir si une réduction fait vraiment revenir les clients : comment le mesurer correctement ?' },
            { key: 'pmo_tableau', metier: 'pmo', label: '📋 Suivre 10 projets', sujet: 'la direction veut voir d\'un coup d\'œil l\'état de dix projets : quelles informations demander aux chefs de projet et comment les présenter ?' },
            { key: 'pmo_retards', metier: 'pmo', label: '⏰ Rapports toujours en retard', sujet: 'chaque mois, la moitié des chefs de projet rendent leur rapport en retard : que mettre en place ?' },
            { key: 'pmo_arbitrage', metier: 'pmo', label: '⚖️ Arbitrer des ressources', sujet: 'trois projets veulent les mêmes experts le même mois : comment préparer la décision du comité ?' },
            { key: 'pmo_budget', metier: 'pmo', label: '💶 Budget à mi-parcours', sujet: 'un projet a dépensé 80 % de son budget à mi-parcours : quelles questions poser et que proposer au comité ?' },
            { key: 'cf_standard', metier: 'consultant_fonctionnel', label: '⚙️ Standard ou sur-mesure', sujet: 'un client veut un développement sur mesure ; le logiciel standard fait presque la même chose : que conseiller (coût, mises à jour, habitudes des utilisateurs) ?' },
            { key: 'cf_adoption', metier: 'consultant_fonctionnel', label: '🙋 Faire adopter le logiciel', sujet: 'trois mois après le démarrage, les employés continuent d\'utiliser leurs fichiers Excel : pourquoi, et que faire ?' },
            { key: 'cf_demarrage', metier: 'consultant_fonctionnel', label: '🚦 Démarrer ou reporter ?', sujet: 'la date de démarrage approche mais les tests ne sont pas finis : démarrer quand même, démarrer en partie, ou reporter ?' },
            { key: 'cf_processus', metier: 'consultant_fonctionnel', label: '🔄 Simplifier un processus', sujet: 'le processus de commande du client a beaucoup d\'étapes manuelles : que peut-on simplifier avec le logiciel ?' }
        ];
        let rpCaseMetier = 'logistique';
        const rpCaseThemesOf = m => RP_CASE_THEMES.filter(t => t.metier === m);
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
                <div class="rp-job-canal">Métier</div>
                <div class="conj-filter-chips-row" style="width:100%; max-width:520px;">
                    ${[...new Set(RP_CASE_THEMES.map(t => t.metier))].map(m => chip(rpCaseMetier === m, `rpCaseSet('metier','${m}')`, RP_JOB_METIERS[m] || m)).join('')}
                </div>
                <div class="rp-job-canal">Thème</div>
                <div class="conj-filter-chips-row" style="width:100%; max-width:520px;">
                    ${chip(rpCaseTheme === 'hasard', "rpCaseSet('theme','hasard')", '🎲 Au hasard')}
                    ${rpCaseThemesOf(rpCaseMetier).map(t => chip(rpCaseTheme === t.key, `rpCaseSet('theme','${t.key}')`, t.label)).join('')}
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
            if (what === 'metier') { rpCaseMetier = value; rpCaseTheme = 'hasard'; }
            else if (what === 'theme') rpCaseTheme = value; else rpCaseLevel = value;
            rpShowCaseHome();
        }

        // Invente le cas. Entreprises et personnes toujours fictives et génériques.
        async function rpCaseGenerate(theme, levelKey) {
            const raw = await GeminiService.generate(
                'Invente une courte étude de cas pour un entretien d\'embauche en ' + RP_METIERS[theme.metier].domaine + ' en Belgique. Thème : ' + theme.sujet + '.\n' +
                RP_CASE_LEVELS[levelKey].consigne + '\n' +
                'Donne aux entreprises des noms inventés et crédibles, jamais ceux d\'entreprises réelles (par exemple ' + RP_METIERS[theme.metier].noms + '), et utilise des chiffres ronds et cohérents entre eux. Prévois 2 ou 3 informations supplémentaires que le recruteur ne donnera que si le candidat les demande.\n\n' +
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
            return 'Tu es un recruteur belge néerlandophone qui fait passer une courte étude de cas à un candidat pour un poste en ' + RP_METIERS[rpCaseMetier].domaine + '.\n\n' +
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
                ? rpCaseThemesOf(rpCaseMetier)[Math.floor(Math.random() * rpCaseThemesOf(rpCaseMetier).length)]
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
            rpFillDebriefWords();
            const box = document.getElementById('rp-debrief-content');
            const header = `<div class="conj-verb-title">🏁 Bilan — ${rpEscapeHtml(st.cas.titre_fr || 'Étude de cas')}</div>`;
            const footer = `${usedSessionHtml()}
                <button class="btn btn-green" style="margin-top:14px;" onclick="tutorOpen('case')">🧑‍🏫 Revoir avec mon tuteur</button>
                <button class="btn btn-gray" style="margin-top:8px;" onclick="rpShowCaseHome()">Nouvelle étude de cas</button>
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

        // ===== Cours particulier (mode professeur) =====
        // Une séance de 15 ou 30 minutes comme avec un prof particulier, en 4 phases : échauffement
        // (conversation), point ciblé (explication + mini-exercices oraux), mise en pratique (jeu de
        // rôle, texte ou débat) et bilan. La TRAME vient de l'app (notions et mots du niveau, points
        // faibles, portrait, séance précédente) ; Gemini ne fait que la mettre en scène, donc chaque
        // séance est différente. Prompts séparés, jamais mélangés : prof (profConvPrompt),
        // correcteur (profCorrectPrompt, ne voit qu'une phrase), générateur du point ciblé
        // (profTargetPrompt), juge des exercices (profJudgePrompt), générateur de la tâche
        // (profTaskPrompt), bilan (profDebriefPrompt). L'apprenant peut parler en français à tout
        // moment (bouton 🇫🇷) : le prof répond en français puis reprend en néerlandais.
        // Historique : state.profLessons (id → bilan), relu par la séance suivante.
        const PROF_PLAN = { 15: { warm: 4, ex: 4, task: 8 }, 30: { warm: 7, ex: 8, task: 14 } };
        const PROF_PHASES = ['Échauffement', 'Point ciblé', 'Mise en pratique', 'Bilan'];
        const PROF_LEVEL_DESC = {
            A1: 'débutant (A1) : phrases très courtes (5 à 8 mots), présent surtout, vocabulaire très courant',
            A2: 'élémentaire (A2) : phrases simples, présent, passé composé (perfectum), futur avec gaan',
            B1: 'intermédiaire (B1) : phrases complètes avec subordonnées, passé, donner son avis simplement',
            B2: 'avancé (B2) : langue naturelle et nuancée, argumentation, expressions idiomatiques courantes'
        };
        const PROF_RATE = { A1: 0.8, A2: 0.88, B1: 0.95, B2: 1 };
        const PROF_GOALS = {
            travail: { label: '💼 Travail', desc: 'contexte professionnel en général (réunions, appels, e-mails, clients, collègues, entretiens), sans secteur imposé' },
            quotidien: { label: '🏠 Quotidien', desc: 'vie quotidienne en Flandre / à Bruxelles (administration, voisins, commerces, rendez-vous, santé)' },
            aisance: { label: '💬 Aisance', desc: 'conversation générale : raconter, donner son avis, argumenter, nuancer, hésiter moins' }
        };
        const PROF_TASK_TYPES = { travail: ['jeu_de_role', 'jeu_de_role', 'debat', 'texte'], quotidien: ['jeu_de_role', 'jeu_de_role', 'texte', 'debat'], aisance: ['debat', 'texte', 'jeu_de_role'] };
        const PROF_WORDS_LIST = '🎓 Mon cours';
        const PROF_GOAL_FILES = {
            travail: f => /^THEME_/.test(f) || f === 'KITS_JEU_DE_ROLE',
            quotidien: f => ['VERBES_NL', 'NOMS_NL', 'ADJECTIFS_NL', 'ADVERBES_NL', 'EXPRESSIONS_NL'].includes(f),
            aisance: f => ['EXPRESSIONS_NL', 'LOCUTIONS_NL', 'ADVERBES_NL', 'MOTS_OUTILS_NL', 'VERBES_NL'].includes(f)
        };
        let prof = null;      // séance en cours
        let profRec = null;   // reconnaissance vocale en cours

        function profSettings() {
            if (!state.settings) state.settings = {};
            const s = state.settings.prof || {};
            const lvl = ['A1', 'A2', 'B1', 'B2'];
            state.settings.prof = {
                level: lvl.includes(s.level) ? s.level : (curriculumLoaded && lvl.includes(getCurriculumLevel().level) ? getCurriculumLevel().level : 'A1'),
                dur: s.dur === 30 ? 30 : 15,
                goal: PROF_GOALS[s.goal] ? s.goal : 'travail',
                handsfree: s.handsfree !== false,
                // 5 s par défaut (3 s coupait les pauses de réflexion) ; anciens réglages remis à 5 s.
                silence: s.silenceV2 && [3000, 5000, 8000, 0].includes(s.silence) ? s.silence : 5000,
                silenceV2: true,
                notion: s.notion || ''
            };
            return state.settings.prof;
        }
        function profSet(key, value) {
            const s = profSettings();
            s[key] = value;
            if (key === 'level') s.notion = '';
            save();
            profRenderSetup();
        }

        function profLessonsSorted() {
            return Object.entries(state.profLessons || {}).map(([id, l]) => Object.assign({ id }, l)).sort((a, b) => (b.at || 0) - (a.at || 0));
        }

        function profNotionsOfLevel(level) {
            if (!curriculumLoaded) return [];
            return Object.keys(curriculumNotions).filter(id => curriculumNotions[id].level === level && curriculumNotions[id].status === 'pret');
        }

        // Le point ciblé proposé : une faiblesse du niveau d'abord, puis une notion entamée, puis la
        // prochaine jamais étudiée ; on évite celle de la séance précédente.
        function profProposeNotion(level) {
            const ids = profNotionsOfLevel(level);
            if (!ids.length) return '';
            const last = profLessonsSorted()[0];
            const avoid = last && last.notion;
            const weak = getWeaknesses().map(w => w.id).filter(id => ids.includes(id) && id !== avoid);
            if (weak.length) return weak[0];
            const started = ids.filter(id => id !== avoid && ['decouverte', 'en_cours', 'entrainee', 'a_pratiquer', 'presque_maitrisee'].includes(getNotionStatus(id)));
            if (started.length) return started[Math.floor(Math.random() * Math.min(3, started.length))];
            const fresh = ids.filter(id => id !== avoid && getNotionStatus(id) === 'jamais_etudiee');
            return fresh[0] || ids[0];
        }

        // Mots du jour : ceux à revoir d'abord, puis des mots courants du niveau, pris un peu au
        // hasard parmi les plus fréquents pour que deux séances ne se ressemblent pas. Les mots
        // métier (thèmes, kits) n'ont pas de niveau : pour l'objectif travail, moitié mots métier,
        // moitié mots courants du niveau.
        function profPickWords(level, goal, n) {
            const usable = i => i.nl && i.fr && i.nl.length >= 4 && i.file !== 'PHRASES_LABO' && i.nl.split(' ').length <= 3 && !/^(ik|je|we|wij|hallo|dag|nee|ja)\b/i.test(i.nl);
            const pick = (pool, k, taken) => {
                pool = pool.filter(i => !taken.includes(i));
                const review = pool.filter(i => wordStatus(i.id) === 'review').slice(0, Math.ceil(k / 3));
                const rest = byFrequencyDesc(pool.filter(i => !review.includes(i) && !isTrueMastered(i.id))).slice(0, 60).sort(() => Math.random() - 0.5);
                return review.concat(rest).slice(0, k);
            };
            const ofLevel = fullDb.filter(i => usable(i) && i.niveauCECR === level);
            if (goal === 'travail') {
                const metier = fullDb.filter(i => usable(i) && /^THEME_/.test(i.file) && !['THEME_BASE', 'THEME_LOGISTIQUE', 'THEME_SUPPLYCHAIN'].includes(i.file));
                const a = pick(metier, Math.ceil(n / 2), []);
                return a.concat(pick(ofLevel, n - a.length, a));
            }
            const pool = ofLevel.filter(i => PROF_GOAL_FILES[goal](i.file));
            return pick(pool.length >= 15 ? pool : ofLevel, n, []);
        }

        function profConjToRecycle() {
            return Object.entries(state.conjStats || {})
                .filter(([, s]) => s.ko > 0 && s.ko >= s.ok)
                .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
                .slice(0, 4)
                .map(([k]) => { const [inf, temps, pr] = k.split('|'); return `${inf} (${temps}, ${pr})`; });
        }

        function profPortrait() {
            try { return MODRP_IDS.flatMap(id => modRpSentences(id)).map(s => s.fr).slice(0, 14); } catch (e) { return []; }
        }

        function showProf() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('prof-view').classList.add('active');
            setActiveNav('nav-apprendre');
            if (prof && !prof.ended) { profRenderSession(); return; }
            profRenderSetup();
        }

        function profRenderSetup() {
            const box = document.getElementById('prof-content');
            if (!box) return;
            const s = profSettings();
            const chip = (active, onclick, label) => `<button type="button" class="conj-filter-chip${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;
            const ids = profNotionsOfLevel(s.level);
            if (!s.notion || !ids.includes(s.notion)) { s.notion = profProposeNotion(s.level); }
            const proposed = profProposeNotion(s.level);
            const history = profLessonsSorted().slice(0, 5);
            const plan = PROF_PLAN[s.dur];
            box.innerHTML = `
                <h2 style="margin-bottom:4px;">🎓 Cours particulier</h2>
                <p class="section-subtitle" style="margin-top:0;">Comme avec un prof : on discute, on travaille un point précis, on le met en pratique, puis le bilan. Le contenu change à chaque séance.</p>
                ${GeminiService.isAvailable() ? '' : `<div class="prof-warn">Il faut une clé Gemini (gratuite) : Profil 👤 → 🤖 Intelligence IA.</div>`}
                <div class="conj-card conj-audio">
                    <div class="conj-audio-label">Niveau</div>
                    <div class="conj-audio-chips">${['A1', 'A2', 'B1', 'B2'].map(l => chip(s.level === l, `profSet('level','${l}')`, l)).join('')}</div>
                    <div class="conj-audio-label">Durée</div>
                    <div class="conj-audio-chips">${chip(s.dur === 15, "profSet('dur',15)", '⏱️ 15 min')}${chip(s.dur === 30, "profSet('dur',30)", '⏱️ 30 min')}</div>
                    <div class="conj-audio-label">Objectif</div>
                    <div class="conj-audio-chips">${Object.entries(PROF_GOALS).map(([k, g]) => chip(s.goal === k, `profSet('goal','${k}')`, g.label)).join('')}</div>
                    <div class="conj-audio-label">Point ciblé</div>
                    <select id="prof-notion" class="prof-select" onchange="profSettings().notion=this.value; save();">
                        ${ids.map(id => `<option value="${id}" ${id === s.notion ? 'selected' : ''}>${rpEscapeHtml(curriculumNotions[id].content.titre || id)}${id === proposed ? ' (proposé)' : ''} · ${getNotionStatusLabel(getNotionStatus(id))}</option>`).join('')}
                    </select>
                    <div class="conj-audio-label">Mode</div>
                    <div class="conj-audio-chips">${chip(s.handsfree, "profSet('handsfree',true)", '🗣️ Mains libres')}${chip(!s.handsfree, "profSet('handsfree',false)", '👆 Je touche 🎤 pour parler')}</div>
                    <div class="conj-audio-label">Envoi de ma réponse</div>
                    <div class="conj-audio-chips">${PROF_SILENCES.map(ms => chip(s.silence === ms, `profSet('silence',${ms})`, ms ? `après ${String(ms / 1000).replace('.', ',')} s de silence` : '👆 quand je touche le micro')).join('')}</div>
                    <p class="conj-audio-hint">${s.dur} min : échauffement (${plan.warm} échanges) · point ciblé (${plan.ex} exercices) · mise en pratique (${plan.task} répliques) · bilan. Tu peux parler 🇫🇷 en français à tout moment pour poser une question.</p>
                    <button class="btn btn-green" style="margin-top:8px;" onclick="profStart()" ${GeminiService.isAvailable() && ids.length ? '' : 'disabled'}>▶️ Commencer le cours</button>
                </div>
                ${history.length ? `<div class="section-title">🗂️ Séances précédentes</div>${history.map(l => `
                    <details class="profil-section">
                        <summary>${new Date(l.at).toLocaleDateString('fr-FR')} · ${l.level} · ${rpEscapeHtml(l.taskTitle || '')}</summary>
                        ${profDebriefHtml(l)}
                    </details>`).join('')}` : ''}`;
        }

        function profStart() {
            const s = profSettings();
            const sel = document.getElementById('prof-notion');
            if (sel) s.notion = sel.value;
            save();
            const notion = curriculumNotions[s.notion];
            if (!notion) return;
            profStopAudio();
            prof = {
                id: 'L' + Date.now(), at: Date.now(), level: s.level, dur: s.dur, goal: s.goal, handsfree: s.handsfree,
                notionId: s.notion, notion, plan: PROF_PLAN[s.dur],
                words: profPickWords(s.level, s.goal, s.dur === 30 ? 14 : 10),
                conj: profConjToRecycle(), portrait: profPortrait(), last: profLessonsSorted()[0] || null,
                phase: 0, turns: 0, history: [], learner: [], errors: [], exResults: [],
                target: null, exIdx: 0, task: null, busy: false, ended: false, awaitNext: false, log: []
            };
            profRenderSession();
            profEnterPhase(0);
        }

        function profRenderSession() {
            const box = document.getElementById('prof-content');
            box.innerHTML = `
                <div class="prof-top">
                    <div class="prof-phases" id="prof-phases"></div>
                    <div class="prof-top-actions">
                        <button type="button" class="rp-coach-btn" onclick="profNextPhase()">⏭ Phase suivante</button>
                        <button type="button" class="rp-coach-btn" onclick="profEndEarly()">⏹ Terminer</button>
                    </div>
                </div>
                <div id="prof-chat" class="prof-chat"></div>
                <div id="prof-next" class="prof-next"></div>
                <div class="prof-input-row" id="prof-input-row">
                    <input type="text" id="prof-input" placeholder="Réponds en néerlandais…" onkeydown="if(event.key==='Enter') profSendTyped()">
                    <button type="button" class="btn btn-green prof-send" onclick="profSendTyped()">➤</button>
                </div>
                <div class="prof-mic-row">
                    <button type="button" class="btn btn-green" id="prof-mic" onclick="profMic('nl')">🎤 Parler</button>
                    <button type="button" class="btn btn-gray" id="prof-hold" style="display:none;" onclick="profHold()">✋ Je réfléchis</button>
                    <button type="button" class="btn btn-gray" id="prof-mic-fr" onclick="profMic('fr')">🇫🇷 En français</button>
                    <button type="button" class="btn btn-gray prof-hint-btn" onclick="profHint()" title="Je ne sais pas quoi dire">💡</button>
                </div>`;
            profRenderPhases();
            (prof.log || []).forEach(m => profAppend(m, true));
        }

        function profRenderPhases() {
            const el = document.getElementById('prof-phases');
            if (!el || !prof) return;
            el.innerHTML = PROF_PHASES.map((p, i) => `<span class="prof-phase${i === prof.phase ? ' active' : ''}${i < prof.phase ? ' done' : ''}">${i + 1}. ${p}</span>`).join('');
        }

        // Message du chat. who : 'prof' | 'moi' | 'info'. Gardé dans prof.log pour redessiner.
        function profAppend(m, replay) {
            if (!replay) prof.log.push(m);
            const chat = document.getElementById('prof-chat');
            if (!chat) return null;
            const div = document.createElement('div');
            div.className = 'prof-msg ' + m.who;
            if (m.who === 'prof') {
                div.innerHTML = `${m.fr ? `<div class="prof-fr">🇫🇷 ${rpEscapeHtml(m.fr)}</div>` : ''}${m.nl ? `<div class="prof-nl">${rpEscapeHtml(m.nl)} ${speakBtnHtml(m.nl)}</div>` : ''}${m.nl_fr ? `<details class="prof-trad"><summary>Traduction</summary>${rpEscapeHtml(m.nl_fr)}</details>` : ''}`;
            } else if (m.who === 'moi') {
                div.innerHTML = `${m.isFr ? '🇫🇷 ' : ''}${rpEscapeHtml(m.text)}<div class="prof-corr"></div>`;
                if (m.corr) profShowCorrection(div, m.corr);
            } else {
                div.innerHTML = m.html;
            }
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            return div;
        }

        function profShowCorrection(div, c) {
            const el = div.querySelector('.prof-corr');
            if (!el || !c || c.fr) return;
            if (c.ok) { el.innerHTML = '<span class="prof-ok">✓</span>'; return; }
            el.innerHTML = `<details ${c.bloquant || (c.francais || []).length ? 'open' : ''}><summary>✏️ ${rpEscapeHtml(c.corrige || 'Correction')}</summary>${(c.francais || []).map(x => `<div class="lc-fr">🇫🇷 ${rpEscapeHtml(x.fr)} → <b>${rpEscapeHtml(x.nl)}</b></div>`).join('')}${(c.erreurs || []).map(e => `<div>${rpEscapeHtml(e.faux)} → <b>${rpEscapeHtml(e.correct)}</b> : ${rpEscapeHtml(e.pourquoi || '')}</div>`).join('')}</details>`;
        }

        function profThinking(on) {
            if (!prof) return;
            prof.busy = on;
            const chat = document.getElementById('prof-chat');
            const old = document.getElementById('prof-thinking');
            if (old) old.remove();
            if (on && chat) {
                const d = document.createElement('div');
                d.id = 'prof-thinking';
                d.className = 'prof-msg info';
                d.innerText = '…';
                chat.appendChild(d);
                chat.scrollTop = chat.scrollHeight;
            }
        }

        function profActive() { return !!(prof && !prof.ended && document.getElementById('prof-view').classList.contains('active')); }

        function profStopAudio() {
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            if (profRec) profMicFinish(profRec, false);
            profMicState(null);
        }

        // Le prof parle : d'abord le français (s'il y en a), puis le néerlandais, à la vitesse du niveau.
        async function profSpeak(fr, nl, nlFirst) {
            const parts = nlFirst ? [[nl, 'nl'], [fr, 'fr']] : [[fr, 'fr'], [nl, 'nl']];
            for (const [t, lang] of parts) {
                if (!t || !profActive()) continue;
                if (lang === 'fr') await conjAudioSpeakMixed(t, 1, PROF_RATE[prof.level], profActive);
                else await conjAudioSpeak(t, lang, PROF_RATE[prof.level]);
            }
        }

        // Après une réplique du prof : en mains libres, le micro s'ouvre tout seul.
        function profAwaitAnswer() {
            if (!profActive()) return;
            if (prof.handsfree && window.SpeechRecognition) profMic('nl');
        }

        // countdown : secondes avant l'envoi automatique (affichées dans le bouton), hold : envoi
        // automatique suspendu par « ✋ Je réfléchis ».
        function profMicState(lang, countdown, hold) {
            const nl = document.getElementById('prof-mic'), fr = document.getElementById('prof-mic-fr'), wait = document.getElementById('prof-hold');
            const manual = profSettings().silence === 0 || hold;
            const label = countdown ? `📤 Envoi dans ${countdown}… (touche pour envoyer)` : (manual ? '🎙️ J\'écoute… touche pour envoyer' : '🎙️ J\'écoute… (touche pour envoyer)');
            if (nl) nl.innerText = lang === 'nl' ? label : '🎤 Parler';
            if (fr) fr.innerText = lang === 'fr' ? label.replace('J\'écoute', 'J\'écoute en français') : '🇫🇷 En français';
            if (wait) wait.style.display = lang && !manual ? '' : 'none';
        }

        function profHold() {
            if (profRec) profRec.pause();
        }

        // Micro du cours : écoute CONTINUE, relancée si le navigateur la coupe (Android le fait
        // après chaque phrase), et envoi seulement après un silence réglable (state.settings.prof.
        // silence, en ms ; 0 = on touche le bouton pour envoyer). Avant la première parole, on
        // laisse 10 secondes pour réfléchir. Si la phrase s'arrête visiblement en plein milieu
        // (« omdat », « de », « euh »…), on attend deux fois plus longtemps. Les 2 dernières
        // secondes s'affichent ; « ✋ Je réfléchis » suspend l'envoi automatique pour cette réponse.
        const PROF_SILENCES = [3000, 5000, 8000, 0];
        const PROF_UNFINISHED = /\b(de|het|een|en|of|maar|want|omdat|dat|die|als|om|te|ik|je|jij|we|wij|zij|hij|ze|met|van|in|op|voor|naar|aan|bij|uit|over|is|ben|bent|heb|hebt|heeft|wil|kan|moet|ga|zal|euh|eh|uh|uhm|ehm|dus|toen|wanneer|hoewel|zodat|doordat|terwijl|nadat|voordat|le|la|les|un|une|et|mais|que|qui|parce|pour|avec|dans|est|suis|ai|euh)$/i;
        // Écoute longue commune (cours particulier, session guidée). o = { lang, input, silence,
        // isActive(), onState(st, countdown), onEnd(st), onSubmit(text, st) }. Renvoie st, avec
        // st.finish(envoyer) et st.pause() (« ✋ Je réfléchis »).
        // Une voix de l'app est-elle en train de parler ? (sur Android, la fin de lecture est parfois
        // annoncée trop tôt : on se fie aussi à speaking / pending.)
        // Garde-fou : si l'indicateur reste bloqué (certains Android), on l'ignore après 25 s.
        let ttsBusySince = 0;
        function ttsBusy() {
            const busy = !!(window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending));
            if (!busy) { ttsBusySince = 0; return false; }
            if (!ttsBusySince) ttsBusySince = Date.now();
            return Date.now() - ttsBusySince < 25000;
        }

        function longListen(o) {
            const input = o.input;
            const silence = o.silence;
            const st = { lang: o.lang, committed: '', session: '', rec: null, done: false, heard: false, hold: false, lastAt: Date.now(), startAt: Date.now(), timer: null, cd: 0 };
            const show = interim => { if (input) input.value = [st.committed, st.session, interim].filter(Boolean).join(' ').trim(); };
            st.finish = submit => {
                if (st.done) return;
                st.done = true;
                clearInterval(st.timer);
                try { st.rec && st.rec.abort(); } catch (e) {}
                if (o.onEnd) o.onEnd(st);
                const text = input ? input.value.trim() : '';
                if (submit && text && o.isActive()) { input.value = ''; o.onSubmit(text, st); }
            };
            st.pause = () => { st.hold = true; if (o.onState) o.onState(st, 0); };
            const startSession = () => {
                if (st.done) return;
                // Pas d'écoute pendant qu'une voix de l'app parle : sinon le micro l'enregistre.
                if (ttsBusy()) { setTimeout(startSession, 300); return; }
                const rec = new window.SpeechRecognition();
                rec.lang = o.lang === 'fr' ? 'fr-FR' : 'nl-NL';
                rec.continuous = true;
                rec.interimResults = true;
                rec.onresult = e => {
                    if (rec !== st.rec) return; // session coupée (voix de l'app) : résultats ignorés
                    // Les phrases finales de la session ; Android renvoie parfois chaque phrase
                    // complétée de la précédente : on ne garde que la plus longue d'une même suite.
                    const finals = [];
                    let interim = '';
                    for (let i = 0; i < e.results.length; i++) {
                        const t = e.results[i][0].transcript.trim();
                        if (!e.results[i].isFinal) { interim += ' ' + t; continue; }
                        const prev = finals[finals.length - 1];
                        if (prev && normalize(t).startsWith(normalize(prev))) finals[finals.length - 1] = t;
                        else if (t) finals.push(t);
                    }
                    st.session = finals.join(' ');
                    // Android renvoie parfois, dans la nouvelle session, le texte déjà retenu.
                    if (st.committed && normalize(st.session).startsWith(normalize(st.committed))) st.committed = '';
                    st.heard = true;
                    st.lastAt = Date.now();
                    show(interim.trim());
                };
                rec.onerror = e => {
                    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { alert('Micro refusé : autorise le micro pour ce site.'); st.finish(false); }
                };
                rec.onend = () => {
                    if (st.done || (st.rec && st.rec !== rec)) return;
                    st.committed = [st.committed, st.session].filter(Boolean).join(' ');
                    st.session = '';
                    setTimeout(startSession, 120);
                };
                st.rec = rec;
                try { rec.start(); } catch (e) { setTimeout(startSession, 300); }
            };
            st.timer = setInterval(() => {
                if (st.done) return;
                if (!o.isActive()) { st.finish(false); return; }
                const now = Date.now();
                // Une voix de l'app parle : on coupe la session en cours (ce qui a été dit avant est
                // gardé), on ne compte pas ce temps comme du silence, et on reprend après.
                if (ttsBusy()) {
                    if (st.rec) {
                        st.committed = [st.committed, st.session].filter(Boolean).join(' ');
                        st.session = '';
                        const r = st.rec;
                        st.rec = null;
                        try { r.abort(); } catch (e) {}
                        setTimeout(startSession, 300);
                    }
                    st.lastAt = now;
                    st.startAt = Math.max(st.startAt, now - 5000);
                    return;
                }
                if (now - st.startAt > 120000) { st.finish(true); return; }
                if (!silence || st.hold) return;
                if (!st.heard) { if (now - st.startAt > 10000) st.finish(true); return; }
                const text = input ? input.value.trim() : '';
                const limit = PROF_UNFINISHED.test(text) ? silence * 2 : silence;
                const left = limit - (now - st.lastAt);
                if (left <= 0) { st.finish(true); return; }
                const cd = left <= 2000 ? Math.ceil(left / 1000) : 0;
                if (cd !== st.cd) { st.cd = cd; if (o.onState) o.onState(st, cd); }
            }, 200);
            if (input) input.value = '';
            if (o.onState) o.onState(st, 0);
            startSession();
            return st;
        }

        function profMic(lang) {
            if (!prof || prof.ended) return;
            if (profRec) { profRec.finish(true); return; }
            if (!window.SpeechRecognition) { alert("Ton navigateur ne supporte pas la reconnaissance vocale : écris ta réponse, ou utilise Google Chrome."); return; }
            if (prof.busy) return;
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            profRec = longListen({
                lang, input: document.getElementById('prof-input'), silence: profSettings().silence,
                isActive: profActive,
                onState: (st, cd) => profMicState(lang, cd, st.hold),
                onEnd: st => { if (profRec === st) profRec = null; profMicState(null); },
                onSubmit: text => profSubmit(text, lang === 'fr')
            });
        }

        function profMicFinish(st, submit) {
            st.finish(submit);
        }

        function profSendTyped() {
            const input = document.getElementById('prof-input');
            const text = input ? input.value.trim() : '';
            if (!text || !prof || prof.busy) return;
            input.value = '';
            // Texte tapé : français détecté à quelques mots courants.
            const isFr = /(\bcomment\b|\bpourquoi\b|est-ce|c'est|qu'est|veut dire|\bje ne\b|\bje comprends\b|\bon dit\b|ça|\bquoi\b|\bque\b|\bles\b)/i.test(text);
            profSubmit(text, isFr);
        }

        async function profGemini(prompt) {
            try { return rpHelpParseJson(await GeminiService.generate(prompt)); }
            catch (e) { return { error: e.message }; }
        }

        // ----- Phases -----
        async function profEnterPhase(i) {
            prof.phase = i;
            prof.turns = 0;
            prof.history = [];
            prof.awaitNext = false;
            document.getElementById('prof-next').innerHTML = '';
            profRenderPhases();
            profAppend({ who: 'info', html: `<div class="prof-phase-title">${i + 1}. ${PROF_PHASES[i]}</div>` });
            if (i === 0) await profConvTurn();
            else if (i === 1) await profStartTarget();
            else if (i === 2) await profStartTask();
            else await profDebrief();
        }

        function profNextPhase() {
            if (!prof || prof.ended || prof.busy) return;
            profStopAudio();
            if (prof.phase < 3) profEnterPhase(prof.phase + 1);
        }

        function profEndEarly() {
            if (!prof || prof.ended) return;
            profStopAudio();
            if (!prof.learner.length) { prof = null; profRenderSetup(); return; }
            if (prof.busy) return;
            profEnterPhase(3);
        }

        function profOfferNext(label) {
            prof.awaitNext = true;
            const el = document.getElementById('prof-next');
            el.innerHTML = `<button class="btn btn-green" onclick="profNextPhase()">➡️ ${label}</button>`;
            if (prof.handsfree) {
                const phase = prof.phase;
                setTimeout(() => { if (prof && prof.phase === phase && prof.awaitNext && profActive() && !prof.busy) profNextPhase(); }, 2500);
            }
        }

        function profContextLines() {
            const lines = [];
            lines.push(`Niveau de l'apprenant : ${PROF_LEVEL_DESC[prof.level]}.`);
            lines.push(`Objectif de l'apprenant : ${PROF_GOALS[prof.goal].desc}.`);
            if (prof.portrait.length) lines.push(`Ce que tu sais de lui (il l'a dit dans ses leçons) : ${prof.portrait.join(' ')}`);
            if (prof.last) lines.push(`Séance précédente (${new Date(prof.last.at).toLocaleDateString('fr-FR')}) : ${prof.last.resume || ''}${prof.last.defi ? ' Défi donné : ' + prof.last.defi : ''}`);
            lines.push(`Point de grammaire du jour : ${prof.notion.content.titre}.`);
            lines.push(`Mots du jour à lui faire employer naturellement, si l'occasion se présente (ils ne doivent PAS décider du sujet) : ${prof.words.map(w => w.nl).join(', ')}.`);
            lines.push(`Ne lui prête pas de métier ni de secteur (logistique ou autre) : pars uniquement de ce qu'il te dit lui-même ; s'il n'a rien dit, reste général ou pose-lui la question.`);
            const said = prof.phase > 0 ? prof.learner.slice(0, 10) : [];
            if (said.length) lines.push(`Ce qu'il a dit plus tôt dans la séance : ${said.join(' / ')}`);
            return lines.join('\n');
        }

        // Prompt du PROF pour les phases de conversation (échauffement et mise en pratique).
        function profConvPrompt(isLast) {
            const phaseTxt = prof.phase === 0
                ? `Phase actuelle : ÉCHAUFFEMENT (quelques minutes). Discussion informelle et chaleureuse pour faire basculer l'apprenant en néerlandais : sa semaine, son travail, ses projets, en lien avec son objectif. Pose UNE question à la fois et rebondis sur ce qu'il dit. Ne corrige que les fautes qui empêchent de comprendre, en reformulant correctement sa phrase dans ta réponse, sans faire de leçon.${prof.last ? ' Tu peux faire allusion à la séance précédente au début.' : ''}`
                : `Phase actuelle : MISE EN PRATIQUE, le cœur du cours. Tâche : ${prof.task.titre}. ${prof.task.role_prof}${prof.task.situation_fr ? '\nSituation (l\'apprenant a cette fiche sous les yeux) : ' + prof.task.situation_fr : ''}${Array.isArray(prof.task.infos_fr) && prof.task.infos_fr.length ? '\nCe que l\'apprenant sait : ' + prof.task.infos_fr.join(' ; ') : ''}${Array.isArray(prof.task.a_dire_fr) && prof.task.a_dire_fr.length ? '\nCe qu\'il doit dire ou obtenir : ' + prof.task.a_dire_fr.join(' ; ') : ''}\nNe fais jamais allusion à quelque chose que l\'apprenant n\'a pas dit ; pose des questions simples auxquelles il peut répondre avec sa fiche.${prof.task.texte_nl ? '\nTexte étudié (l\'apprenant l\'a sous les yeux) : ' + prof.task.texte_nl : ''}\nCe qu'on attend de l'apprenant : ${prof.task.objectif_fr}. Reste dans ton rôle. Fais-le parler le plus possible : demande-lui de préciser, d'expliquer pourquoi, de donner un exemple, de nuancer.`;
            const hist = prof.history.map(h => h.who === 'prof' ? 'Prof : ' + h.nl + (h.fr ? ' [en français : ' + h.fr + ']' : '') : 'Apprenant' + (h.isFr ? ' (EN FRANÇAIS)' : '') + ' : ' + h.text).join('\n');
            return `Tu es un professeur particulier de néerlandais (néerlandais standard, comme en Flandre) qui donne un cours en tête-à-tête, à l'oral, à un apprenant francophone.
${profContextLines()}
${phaseTxt}

Règles :
- 1 à 3 phrases en néerlandais, adaptées au niveau. Pas d'emojis, pas de mise en forme.
- Si l'apprenant parle ou écrit en FRANÇAIS (une question, « comment on dit… ? », « je ne comprends pas », un mot qui lui manque), réponds-lui d'abord en français dans "fr" : réponse claire et courte (2 ou 3 phrases), avec la formulation néerlandaise utile ; puis, dans "nl", relance en néerlandais (par exemple en l'invitant à redire sa phrase avec cette formulation). Sinon "fr" reste vide.
- Ne redéfinis jamais le niveau de l'apprenant.
${isLast ? '- C\'est ta DERNIÈRE réplique de cette phase : réagis à ce qu\'il vient de dire et conclus en une phrase, sans poser de nouvelle question.' : ''}
${hist ? 'Conversation jusqu\'ici :\n' + hist : (prof.phase === 0 ? 'Commence le cours : salue-le et pose ta première question.' : 'Commence la mise en pratique : présente brièvement la situation dans ton rôle et lance l\'échange.')}

Réponds UNIQUEMENT en JSON : {"fr": "", "nl": "ce que tu dis en néerlandais", "nl_fr": "traduction française de nl"}`;
        }

        async function profConvTurn(isLast) {
            profThinking(true);
            const r = await profGemini(profConvPrompt(isLast));
            profThinking(false);
            if (!profActive()) return;
            if (!r || r.error || !r.nl) {
                profAppend({ who: 'info', html: `⚠️ Le prof n'a pas répondu (${rpEscapeHtml((r && r.error) || 'réponse illisible')}). <button class="rp-coach-btn" onclick="profConvTurn(${!!isLast})">Réessayer</button>` });
                return;
            }
            prof.history.push({ who: 'prof', nl: r.nl, fr: r.fr || '' });
            profAppend({ who: 'prof', fr: r.fr || '', nl: r.nl, nl_fr: r.nl_fr || '' });
            await profSpeak(r.fr, r.nl);
            if (isLast) { profOfferNext(prof.phase === 0 ? 'Passer au point ciblé' : 'Voir le bilan'); return; }
            profAwaitAnswer();
        }

        // Prompt du CORRECTEUR : ne voit qu'une phrase de l'apprenant.
        function profCorrectPrompt(sentence) {
            return `Tu es correcteur de néerlandais. Voici UNE phrase dite à l'oral (reconnaissance vocale : ignore ponctuation, majuscules et petites erreurs de transcription évidentes) ou écrite par un apprenant francophone de niveau ${prof.level}. Corrige seulement les vraies fautes (grammaire, ordre des mots, conjugaison, de/het, mot faux ou inexistant), pas le style.
${LIVE_MIX_RULES}
Si la phrase est ENTIÈREMENT en français, réponds {"fr": true}.
Phrase : "${sentence.replace(/"/g, "'")}"
Réponds UNIQUEMENT en JSON : {"fr": false, "ok": true, "corrige": "la phrase corrigée complète, entièrement en néerlandais", "erreurs": [{"faux": "", "correct": "", "pourquoi": "très court, en français"}], "francais": [{"fr": "ce qu'il a dit en français", "nl": "l'équivalent néerlandais"}], "bloquant": false}
("ok" = aucune faute ; "bloquant" = on ne comprend pas ce qu'il veut dire)`;
        }

        async function profCorrect(text, msg, div) {
            const c = await profGemini(profCorrectPrompt(text));
            if (!c || c.error) { usedWordsRecord(text); return; }
            usedWordsRecord(text, c);
            msg.corr = c;
            c.francais = (Array.isArray(c.francais) ? c.francais : []).filter(x => x && x.fr && x.nl);
            if (c.francais.length) { c.ok = false; liveSaveWords(c.francais); }
            if (!c.ok && !c.fr) (c.erreurs || []).forEach(e => prof && prof.errors.push(e));
            if (div) profShowCorrection(div, c);
        }

        async function profSubmit(text, isFr) {
            if (!prof || prof.ended || prof.busy) return;
            if (prof.phase === 1) return profAnswerExercise(text, isFr);
            if (prof.phase === 3 || prof.awaitNext) return;
            const msg = { who: 'moi', text, isFr };
            const div = profAppend(msg);
            prof.history.push({ who: 'moi', text, isFr });
            if (!isFr) {
                prof.learner.push(text);
                prof.turns++;
                profCorrect(text, msg, div);
            }
            const limit = prof.phase === 0 ? prof.plan.warm : prof.plan.task;
            await profConvTurn(!isFr && prof.turns >= limit);
        }

        // ----- Point ciblé -----
        function profTargetPrompt() {
            const n = prof.plan.ex;
            const c = prof.notion.content;
            const lastErr = prof.last && prof.last.erreurs ? prof.last.erreurs.map(e => `${e.faux} → ${e.correct}`).join(' ; ') : '';
            return `Tu es professeur particulier de néerlandais pour un francophone. ${profContextLines()}
Prépare le POINT CIBLÉ de la séance, sur la notion « ${c.titre} ».
Objectif : ${c.objectif || ''}
Règle (résumé du cours) : ${String(c.comprendre || '').slice(0, 1400)}
${lastErr ? 'Erreurs de la séance précédente, à recycler si elles sont liées : ' + lastErr : ''}
${prof.conj.length ? 'Formes de conjugaison qu\'il rate souvent (à glisser si ça s\'y prête) : ' + prof.conj.join(', ') : ''}
Produis :
- "explication_fr" : l'explication orale en français, 3 ou 4 phrases simples et concrètes, comme un prof qui parle.
- "exemples" : 2 ou 3 phrases néerlandaises courtes avec leur traduction, dans le contexte de son objectif.
- "exercices" : exactement ${n} mini-exercices ORAUX variés (transformer une phrase, compléter une phrase à trou ___, traduire une phrase française, répondre à une question en appliquant la règle), chacun avec UNE réponse courte (une phrase au maximum).
  RÈGLE ABSOLUE : l'apprenant ne doit JAMAIS avoir à inventer du contenu. L'exercice teste la grammaire, pas l'imagination : toute information nécessaire (la raison, le fait, le moment, le chiffre…) est donnée dans la consigne ou l'énoncé. Exemple correct pour « répondre avec doordat » : consigne « Réponds avec doordat. Raison : la signature manque. », énoncé « Waarom is het document afgekeurd? », réponse « Het document is afgekeurd doordat de handtekening ontbreekt. ». Si l'exercice demande d'utiliser un mot précis (omdat, doordat…), la réponse attendue l'utilise. Pour les A1/A2, n'utilise que des mots très courants.
  Champs : "consigne_fr" (courte, en français), "enonce" (ce que l'apprenant entend : phrase néerlandaise à transformer ou à compléter, ou phrase française à traduire), "langue_enonce" ("nl" ou "fr"), "reponse" (réponse attendue complète, en néerlandais), "alternatives" (autres réponses correctes), "astuce_fr".
Réponds UNIQUEMENT en JSON : {"explication_fr": "", "exemples": [{"nl": "", "fr": ""}], "exercices": []}`;
        }

        async function profStartTarget() {
            profThinking(true);
            const r = await profGemini(profTargetPrompt());
            profThinking(false);
            if (!profActive()) return;
            if (!r || r.error || !Array.isArray(r.exercices) || !r.exercices.length) {
                profAppend({ who: 'info', html: `⚠️ Le point ciblé n'a pas pu être préparé (${rpEscapeHtml((r && r.error) || 'réponse illisible')}). <button class="rp-coach-btn" onclick="profStartTarget()">Réessayer</button>` });
                return;
            }
            prof.target = r;
            prof.exIdx = 0;
            const ex = (r.exemples || []).map(e => `<div class="prof-example">${rpEscapeHtml(e.nl)} ${speakBtnHtml(e.nl)}<br><small>${rpEscapeHtml(e.fr)}</small></div>`).join('');
            profAppend({ who: 'info', html: `<div class="prof-target-title">📌 ${rpEscapeHtml(prof.notion.content.titre)}</div><div class="prof-fr">${rpEscapeHtml(r.explication_fr || '')}</div>${ex}` });
            await profSpeak(r.explication_fr, '');
            for (const e of (r.exemples || [])) { if (!profActive()) return; await conjAudioSpeak(e.nl, 'nl', PROF_RATE[prof.level]); }
            profAskExercise();
        }

        async function profAskExercise() {
            const ex = prof.target.exercices[prof.exIdx];
            prof.exTries = 0;
            profAppend({ who: 'info', html: `<div class="prof-ex"><small>Exercice ${prof.exIdx + 1} / ${prof.target.exercices.length}</small><div>${rpEscapeHtml(ex.consigne_fr || '')}</div><div class="prof-ex-enonce">${rpEscapeHtml(ex.enonce || '')}</div></div>` });
            await profSpeak(ex.consigne_fr, ex.langue_enonce === 'fr' ? '' : ex.enonce);
            if (ex.langue_enonce === 'fr' && profActive()) await conjAudioSpeak(ex.enonce, 'fr', 1);
            profAwaitAnswer();
        }

        function profNormAnswer(s) { return normalize(String(s || '')).replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim(); }

        // Prompt du JUGE : un exercice, une réponse ; jugement sur le fond, jamais mot pour mot.
        function profJudgePrompt(ex, given, isFr) {
            return `Tu juges la réponse d'un apprenant francophone de niveau ${prof.level} à un mini-exercice oral de néerlandais (reconnaissance vocale : ignore ponctuation, majuscules et petites erreurs de transcription évidentes).
Notion : ${prof.notion.content.titre}
Consigne : ${ex.consigne_fr}
Énoncé : ${ex.enonce}
Réponse attendue : ${ex.reponse}${(ex.alternatives || []).length ? ' (aussi acceptées : ' + ex.alternatives.join(' / ') + ')' : ''}
Réponse de l'apprenant${isFr ? ' (dite EN FRANÇAIS)' : ''} : "${given.replace(/"/g, "'")}"
Juge sur le fond : correct si la règle est bien appliquée et le sens juste, même si ce n'est pas mot pour mot la réponse attendue. Si la consigne impose un mot (omdat, doordat…), vérifie qu'il est utilisé correctement ; une autre raison plausible que celle de l'exemple est acceptée si la grammaire est juste. Si l'apprenant parle en français, pose une question ou dit qu'il ne sait pas, mets "question": true et réponds-lui dans "explication_fr" (sans donner directement la réponse s'il pose juste une question, sauf s'il dit qu'il ne sait pas).
Réponds UNIQUEMENT en JSON : {"correct": false, "question": false, "explication_fr": "1 ou 2 phrases en français", "correction": "la bonne réponse en néerlandais"}`;
        }

        async function profAnswerExercise(text, isFr) {
            if (!prof.target || prof.awaitNext) return;
            const ex = prof.target.exercices[prof.exIdx];
            profAppend({ who: 'moi', text, isFr });
            const accepted = [ex.reponse].concat(ex.alternatives || []).map(profNormAnswer);
            let r;
            if (!isFr && accepted.includes(profNormAnswer(text))) r = { correct: true, explication_fr: '', correction: ex.reponse };
            else {
                profThinking(true);
                r = await profGemini(profJudgePrompt(ex, text, isFr));
                profThinking(false);
                if (!profActive()) return;
                if (!r || r.error) { r = { correct: false, explication_fr: 'Je n\'ai pas pu vérifier ta réponse.', correction: ex.reponse }; }
            }
            if (r.question) {
                profAppend({ who: 'prof', fr: r.explication_fr || '', nl: '' });
                await profSpeak(r.explication_fr, '');
                profAwaitAnswer();
                return;
            }
            if (!isFr) prof.learner.push(text);
            prof.exResults.push({ enonce: ex.enonce, attendu: ex.reponse, donne: text, ok: !!r.correct });
            recordNotionAttempt(prof.notionId, !!r.correct);
            save();
            const good = ['Juist!', 'Heel goed!', 'Perfect!', 'Goed zo!'][Math.floor(Math.random() * 4)];
            profAppend({ who: 'info', html: r.correct
                ? `<div class="prof-good">✅ ${good}${r.explication_fr ? ' <small>' + rpEscapeHtml(r.explication_fr) + '</small>' : ''}</div>`
                : `<div class="prof-bad">❌ <b>${rpEscapeHtml(r.correction || ex.reponse)}</b> ${speakBtnHtml(r.correction || ex.reponse)}<br><small>${rpEscapeHtml(r.explication_fr || ex.astuce_fr || '')}</small></div>` });
            if (r.correct) await conjAudioSpeak(good, 'nl', 1);
            else { await profSpeak(r.explication_fr || ex.astuce_fr, ''); if (profActive()) await conjAudioSpeak(r.correction || ex.reponse, 'nl', PROF_RATE[prof.level]); }
            if (!profActive()) return;
            prof.exIdx++;
            if (prof.exIdx < prof.target.exercices.length) { profAskExercise(); return; }
            const ok = prof.exResults.filter(x => x.ok).length;
            profAppend({ who: 'info', html: `<div class="prof-target-title">${ok} / ${prof.exResults.length} du premier coup</div>` });
            profOfferNext('Passer à la mise en pratique');
        }

        // ----- Mise en pratique -----
        function profTaskPrompt(type) {
            const n = prof.plan.task;
            const past = profLessonsSorted().slice(0, 5).map(l => l.taskTitle).filter(Boolean);
            return `Tu prépares la MISE EN PRATIQUE (cœur d'un cours particulier de néerlandais, environ ${n} répliques de l'apprenant). ${profContextLines()}
Type imposé : ${type}.
- jeu_de_role : une situation réaliste liée à son objectif ; tu joues un personnage (collègue, client, employé, voisin…), l'apprenant joue son propre rôle. Si pendant l'échauffement il a parlé de son métier ou de ses projets, la situation peut s'y rattacher ; sinon, choisis une situation courante, sans secteur particulier.
- texte : un court texte néerlandais (${prof.level === 'A1' ? '40 à 60' : prof.level === 'A2' ? '60 à 90' : '90 à 140'} mots, adapté au niveau) sur un thème lié à son objectif ou de société, puis discussion : compréhension, puis son avis.
- debat : un sujet sur lequel il doit donner et défendre son avis, avec des nuances ; tu joues un contradicteur bienveillant.
Fais-y apparaître la notion du jour et des mots du jour quand c'est naturel.
${past.length ? 'Évite les sujets des séances précédentes : ' + past.join(' ; ') + '.' : ''}
Aucun nom de marque, d'entreprise ou de personne réelle (invente-les).
TRÈS IMPORTANT : l'apprenant doit savoir quoi dire sans rien inventer de compliqué. Donne-lui une FICHE concrète :
- "situation_fr" : 2 ou 3 phrases simples qui posent le décor (qui, où, quoi, pourquoi maintenant) ;
- "infos_fr" : 3 à 5 faits précis qu'il connaît et peut utiliser (chiffres, dates, problème, son avis à défendre…), en français ;
- "a_dire_fr" : 2 ou 3 choses concrètes qu'il doit dire ou obtenir pendant l'échange, en français.
Le personnage ne connaît que ce qui est dans la fiche et ce que l'apprenant dit : il ne fait JAMAIS allusion à quelque chose que l'apprenant n'a pas dit.
Réponds UNIQUEMENT en JSON : {"titre": "titre court en français", "consigne_fr": "ce que l'apprenant doit faire, 1 phrase en français", "situation_fr": "", "infos_fr": [""], "a_dire_fr": [""], "role_prof": "qui tu joues et comment (pour toi, en français)", "objectif_fr": "ce qu'on attend de lui", "texte_nl": "", "texte_fr": ""}`;
        }

        async function profStartTask() {
            let types = PROF_TASK_TYPES[prof.goal];
            if (prof.level === 'A1') types = types.filter(t => t !== 'debat');
            const type = types[Math.floor(Math.random() * types.length)];
            profThinking(true);
            const r = await profGemini(profTaskPrompt(type));
            profThinking(false);
            if (!profActive()) return;
            if (!r || r.error || !r.titre) {
                profAppend({ who: 'info', html: `⚠️ La mise en pratique n'a pas pu être préparée (${rpEscapeHtml((r && r.error) || 'réponse illisible')}). <button class="rp-coach-btn" onclick="profStartTask()">Réessayer</button>` });
                return;
            }
            prof.task = r;
            const list = a => (Array.isArray(a) ? a : []).filter(Boolean);
            const fiche = `${r.situation_fr ? `<div class="prof-fr">${rpEscapeHtml(r.situation_fr)}</div>` : ''}
                ${list(r.infos_fr).length ? `<div class="prof-deb-sec">📋 Ce que tu sais</div><ul class="prof-fiche">${list(r.infos_fr).map(x => `<li>${rpEscapeHtml(x)}</li>`).join('')}</ul>` : ''}
                ${list(r.a_dire_fr).length ? `<div class="prof-deb-sec">🎯 Ce que tu dois dire</div><ul class="prof-fiche">${list(r.a_dire_fr).map(x => `<li>${rpEscapeHtml(x)}</li>`).join('')}</ul>` : ''}`;
            profAppend({ who: 'info', html: `<div class="prof-target-title">🎬 ${rpEscapeHtml(r.titre)}</div><div class="prof-fr">${rpEscapeHtml(r.consigne_fr || '')}</div>${fiche}${r.texte_nl ? `<div class="prof-text">${rpEscapeHtml(r.texte_nl)} ${speakBtnHtml(r.texte_nl)}${r.texte_fr ? `<details class="prof-trad"><summary>Traduction</summary>${rpEscapeHtml(r.texte_fr)}</details>` : ''}</div>` : ''}` });
            await profSpeak([r.consigne_fr, r.situation_fr].filter(Boolean).join(' '), r.texte_nl || '');
            if (!profActive()) return;
            await profConvTurn();
        }

        // ----- Souffleur : « 💡 Je ne sais pas quoi dire » -----
        // Prompt séparé : propose 3 réponses possibles à la dernière réplique du prof, au niveau
        // de l'apprenant ; un clic place la phrase dans la zone de texte, sans jamais l'envoyer.
        async function profHint() {
            if (!prof || prof.ended || prof.busy) return;
            const lastProf = [...prof.log].reverse().find(m => m.who === 'prof' && m.nl);
            const ex = prof.phase === 1 && prof.target ? prof.target.exercices[prof.exIdx] : null;
            const ctx = ex ? `Exercice en cours — consigne : ${ex.consigne_fr} ; énoncé : ${ex.enonce}. Donne des PISTES (début de phrase, mot clé), pas la réponse complète.`
                : (prof.phase === 2 && prof.task ? `Mise en pratique : ${prof.task.titre}. Fiche de l'apprenant : ${prof.task.situation_fr || ''} ${(prof.task.infos_fr || []).join(' ; ')} ; à dire : ${(prof.task.a_dire_fr || []).join(' ; ')}` : 'Échauffement : conversation libre sur sa semaine, son travail, ses projets.');
            profThinking(true);
            const r = await profGemini(`Tu aides un apprenant francophone de néerlandais (niveau ${prof.level}) qui ne sait pas quoi répondre pendant un cours.
${ctx}
${lastProf ? 'Dernière réplique du prof : « ' + lastProf.nl + ' »' : ''}
Ce que l'apprenant sait de lui : ${prof.portrait.join(' ') || '(rien de particulier)'}
Propose 3 réponses courtes et naturelles qu'il pourrait dire, adaptées à son niveau (phrases simples pour A1/A2), variées (par exemple : une réponse directe, une avec une raison, une qui pose une question en retour).
Réponds UNIQUEMENT en JSON : [{"nl": "", "fr": ""}]`);
            profThinking(false);
            if (!prof || prof.ended) return;
            const list = Array.isArray(r) ? r.filter(x => x && x.nl) : [];
            if (!list.length) { profAppend({ who: 'info', html: '⚠️ Pas de suggestion pour l\'instant, réessaie.' }); return; }
            profAppend({ who: 'info', html: `<div class="prof-deb-sec">💡 Tu pourrais dire :</div>${list.map(x => `<button type="button" class="prof-hint" data-nl="${rpEscapeHtml(x.nl)}" onclick="profHintUse(this)"><b>${rpEscapeHtml(x.nl)}</b><br><small>${rpEscapeHtml(x.fr || '')}</small></button>`).join('')}<div class="report-meta">Touche une phrase pour la mettre dans la zone de texte, adapte-la si tu veux, puis envoie-la ou dis-la au micro.</div>` });
        }

        function profHintUse(btn) {
            const input = document.getElementById('prof-input');
            if (input) { input.value = btn.dataset.nl; input.focus(); }
            conjAudioSpeak(btn.dataset.nl, 'nl', PROF_RATE[prof.level]);
        }

        // ----- Bilan -----
        function profDebriefPrompt() {
            const errs = prof.errors.slice(0, 30).map(e => `- ${e.faux} → ${e.correct} (${e.pourquoi || ''})`).join('\n');
            const exs = prof.exResults.map(x => `- ${x.enonce} — attendu : ${x.attendu} — donné : ${x.donne} — ${x.ok ? 'juste' : 'faux'}`).join('\n');
            return `Tu es le professeur particulier de néerlandais. Fais le BILAN de la séance (niveau ${prof.level}, ${prof.dur} minutes, objectif : ${PROF_GOALS[prof.goal].desc}).
Point ciblé : ${prof.notion.content.titre}. Mise en pratique : ${prof.task ? prof.task.titre : 'non faite'}.
Phrases de l'apprenant, dans l'ordre :
${prof.learner.map(t => '- ' + t).join('\n') || '(aucune)'}
Erreurs relevées par le correcteur :
${errs || '(aucune)'}
Exercices :
${exs || '(aucun)'}
Mots du jour proposés : ${prof.words.map(w => w.nl).join(', ')}
Écris en français, ton chaleureux, concret, en t'appuyant sur ce qu'il a vraiment dit.
Réponds UNIQUEMENT en JSON : {"forces": ["2 ou 3 points forts précis, avec un exemple tiré de ses phrases"], "erreurs": [{"faux": "", "correct": "", "explication": ""}], "mots": [{"nl": "", "fr": ""}], "defi": "un petit défi concret pour la prochaine fois", "resume": "une ou deux phrases qui résument la séance (sujets abordés, ce qu'il a raconté) pour s'en souvenir la prochaine fois", "fluidite": 6}
("erreurs" : les 3 à 5 plus importantes ou récurrentes ; "mots" : 5 à 8 mots ou tournures utiles apparus ou qui lui ont manqué, avec de/het pour les noms ; "fluidite" : note de 1 à 10)`;
        }

        async function profDebrief() {
            profThinking(true);
            const r = await profGemini(profDebriefPrompt());
            profThinking(false);
            if (!prof || prof.ended) return;
            if (!r || r.error || !Array.isArray(r.forces)) {
                profAppend({ who: 'info', html: `⚠️ Le bilan n'a pas pu être fait (${rpEscapeHtml((r && r.error) || 'réponse illisible')}). <button class="rp-coach-btn" onclick="profDebrief()">Réessayer</button>` });
                return;
            }
            const ok = prof.exResults.filter(x => x.ok).length;
            const lesson = {
                at: prof.at, level: prof.level, dur: prof.dur, goal: prof.goal, notion: prof.notionId,
                notionTitle: prof.notion.content.titre, taskTitle: prof.task ? prof.task.titre : '',
                exOk: ok, exTotal: prof.exResults.length, forces: r.forces.slice(0, 4),
                erreurs: (r.erreurs || []).slice(0, 6), mots: (r.mots || []).slice(0, 10),
                defi: r.defi || '', resume: r.resume || '', fluidite: r.fluidite || 0
            };
            if (!state.profLessons) state.profLessons = {};
            state.profLessons[prof.id] = lesson;
            Object.keys(state.profLessons).sort().slice(0, -20).forEach(k => delete state.profLessons[k]);
            lesson.added = profAddWords(lesson.mots);
            save();
            prof.ended = true;
            profStopAudio();
            document.getElementById('prof-input-row').style.display = 'none';
            document.querySelector('#prof-content .prof-mic-row').style.display = 'none';
            document.querySelector('#prof-content .prof-top-actions').style.display = 'none';
            profAppend({ who: 'info', html: profDebriefHtml(lesson) + usedSessionHtml() + `
                <div class="prof-actions">
                    <button class="btn btn-green" onclick="prof = null; profRenderSetup();">🔁 Nouveau cours</button>
                    ${lesson.added ? `<button class="btn btn-gray" onclick="vocabOpenCat('list', PROF_WORDS_LIST)">📋 Revoir « ${PROF_WORDS_LIST} »</button>` : ''}
                </div>` });
            await conjAudioSpeakMixed((r.forces[0] || '') + ' ' + (r.defi ? 'Ton défi : ' + r.defi : ''), 1);
        }

        // Les mots du bilan rejoignent la liste « 🎓 Mon cours » (inconnus du vocabulaire : ajoutés
        // comme les mots repérés en jeu de rôle).
        function profAddWords(mots) {
            if (!state.customLists[PROF_WORDS_LIST]) state.customLists[PROF_WORDS_LIST] = [];
            const ids = state.customLists[PROF_WORDS_LIST];
            let n = 0;
            (mots || []).forEach(m => {
                if (!m || !m.nl || !m.fr) return;
                const base = String(m.nl).trim();
                const existing = rpWordLookup(base.replace(/^(de|het|een) /i, ''));
                let id = existing && existing.id;
                if (!id) {
                    const k = rpKitNorm(base);
                    if (!k) return;
                    if (!state.rpWords) state.rpWords = {};
                    if (!state.rpWords[k]) state.rpWords[k] = { nl: base, fr: m.fr, at: Date.now() };
                    rpWordsInject();
                    id = 'RPW:' + k;
                }
                if (!ids.includes(id)) { ids.push(id); n++; }
            });
            renderCustomListsHome();
            return n;
        }

        function profDebriefHtml(l) {
            return `<div class="prof-debrief">
                <div class="prof-target-title">📝 Bilan · ${rpEscapeHtml(l.notionTitle || '')}${l.exTotal ? ` · exercices ${l.exOk}/${l.exTotal}` : ''}${l.fluidite ? ` · fluidité ${l.fluidite}/10` : ''}</div>
                ${(l.forces || []).length ? `<div class="prof-deb-sec">💪 Tes forces</div><ul>${l.forces.map(f => `<li>${rpEscapeHtml(f)}</li>`).join('')}</ul>` : ''}
                ${(l.erreurs || []).length ? `<div class="prof-deb-sec">✏️ À corriger</div><ul>${l.erreurs.map(e => `<li>${rpEscapeHtml(e.faux)} → <b>${rpEscapeHtml(e.correct)}</b><br><small>${rpEscapeHtml(e.explication || '')}</small></li>`).join('')}</ul>` : ''}
                ${(l.mots || []).length ? `<div class="prof-deb-sec">📖 Mots à retenir${l.added ? ` (ajoutés à « ${PROF_WORDS_LIST} »)` : ''}</div><ul>${l.mots.map(m => `<li><b>${rpEscapeHtml(m.nl)}</b> ${speakBtnHtml(m.nl)} = ${rpEscapeHtml(m.fr)}</li>`).join('')}</ul>` : ''}
                ${l.defi ? `<div class="prof-deb-sec">🎯 Défi pour la prochaine fois</div><p>${rpEscapeHtml(l.defi)}</p>` : ''}
            </div>`;
        }

        // ===== Session guidée des modules =====
        // Un module se fait d'une traite, comme avec un tuteur : « Continuer » reprend là où on
        // s'est arrêté, et le guide enchaîne tout seul, étape après étape : mise en situation,
        // portrait (questions en néerlandais + français, pour les modules qui en ont un), mots,
        // écoute du dialogue, « à toi de jouer », règle, exercices (on refait les ratés jusqu'à
        // 70 %), petit jeu de rôle avec Gemini, puis l'étape suivante et enfin l'examen, joué dans
        // la même conversation. Le contenu est celui des fichiers data/modules_rp (aucun appel
        // Gemini hors jeux de rôle et avis de l'examinateur). Position mémorisée dans
        // state.modRp[id].guide = { e: n° d'étape, b: n° de temps dans l'étape }.
        const GUIDE_BEATS = ['scene', 'portrait', 'vocab', 'ecoute', 'jouer', 'regle', 'exercices', 'jeu'];
        const GUIDE_BEAT_LABELS = { scene: 'Mise en situation', portrait: 'Toi', vocab: 'Les mots', ecoute: 'Écoute', jouer: 'À toi de jouer', regle: 'La règle', exercices: 'Exercices', jeu: 'Jeu de rôle' };
        const GUIDE_PORTRAIT_Q = {
            identite: [
                { key: 'naam', nl: 'Hoe heet je?', fr: "Comment tu t'appelles ?", type: 'text', ph: 'Ton prénom' },
                { key: 'leeftijd', nl: 'Hoe oud ben je?', fr: 'Quel âge as-tu ?', type: 'num' },
                { key: 'land', nl: 'Waar kom je vandaan?', fr: "D'où viens-tu ?", type: 'select', list: P => P.pays.map(x => x.fr) },
                { key: 'stad', nl: 'Waar woon je?', fr: 'Dans quelle ville habites-tu ?', type: 'text', ph: 'ex. Gent, Brussel' }
            ],
            famille: [
                { key: 'relatie', nl: 'Ben je getrouwd?', fr: 'Tu es marié(e), en couple, célibataire ?', type: 'choice', options: [['alleenstaand', 'célibataire'], ['relatie', 'en couple'], ['samenwonend', 'cohabitant'], ['getrouwd', 'marié(e)']] },
                { key: 'kinderen', nl: 'Heb je kinderen?', fr: 'Tu as des enfants ? Combien ?', type: 'num' },
                { key: 'broers', nl: 'Heb je broers?', fr: 'Tu as des frères ? Combien ?', type: 'num' },
                { key: 'zussen', nl: 'En zussen?', fr: 'Et des sœurs ?', type: 'num' }
            ],
            travail: [
                { key: 'situatie', nl: 'Werk je?', fr: 'Tu travailles, tu cherches du travail ou tu étudies ?', type: 'choice', options: [['werk', 'je travaille'], ['werkzoekend', 'je cherche du travail'], ['student', 'je suis étudiant(e)']] },
                { key: 'beroep', nl: 'Wat is je beroep?', fr: 'Quel est ton métier (actuel ou recherché) ?', type: 'select', list: P => P.metiers.map(x => x.fr) }
            ],
            loisirs: [
                { key: 'talen', nl: 'Welke talen spreek je?', fr: 'Quelles langues parles-tu ?', type: 'multi', list: P => P.langues.map(x => x.fr) },
                { key: 'hobbies', nl: 'Wat doe je graag?', fr: "Qu'est-ce que tu aimes faire ?", type: 'multi', list: P => P.loisirs.map(x => x.fr) }
            ]
        };
        let guide = null; // { id, m, run, token, resolver, rec, skipBeat }

        function guidePos() {
            const g = modRpState(guide.id).guide;
            return g && typeof g.e === 'number' ? { e: g.e, b: g.b || 0 } : { e: 0, b: 0 };
        }
        function guideSetPos(e, b) {
            modRpState(guide.id).guide = { e, b };
            save();
        }
        function guideAlive(token) {
            return !!(guide && guide.token === token && guide.run && !guide.run.stop && conjAudioRun === guide.run && document.getElementById('modguide-view').classList.contains('active'));
        }
        function guideActive() { return !!(guide && guide.run && !guide.run.stop && document.getElementById('modguide-view').classList.contains('active')); }

        function guideStart(id) {
            const m = modRpData[id];
            if (!m) { alert('Module en cours de chargement, réessaie dans un instant.'); return; }
            conjAudioStop();
            guideStopListen();
            modRpCurrent = id;
            modRpEx = null;
            const mc = document.getElementById('modrp-content');
            if (mc) mc.innerHTML = ''; // pas d'identifiants d'exercice en double
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('modguide-view').classList.add('active');
            setActiveNav('nav-apprendre');
            const run = { stop: false, paused: false, skip: false, wakeLock: null, viewId: 'modguide-view' };
            conjAudioRun = run;
            try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { run.wakeLock = w; }).catch(() => {}); } catch (e) { /* pas grave */ }
            guide = { id, m, run, token: Date.now() + Math.random(), resolver: null, rec: null, skipBeat: false };
            document.getElementById('guide-content').innerHTML = `
                <div class="guide-head">
                    <div class="guide-title"><span class="conj-niveau-badge">${m.niveau}</span> ${m.icone || '🎭'} ${rpEscapeHtml(m.titre)}</div>
                    <div class="cat-bar"><div class="cat-bar-fill" id="guide-bar" style="width:0%"></div></div>
                    <div class="guide-where" id="guide-where"></div>
                    <div class="guide-controls">
                        <button type="button" class="rp-coach-btn" data-audio-pause onclick="conjAudioTogglePause()">⏸ Pause</button>
                        <button type="button" class="rp-coach-btn" onclick="guideSkip()">⏭ Passer</button>
                        <button type="button" class="rp-coach-btn" onclick="guideQuit(); showModuleRp('${id}')">📋 Sommaire</button>
                    </div>
                </div>
                <div id="guide-chat" class="prof-chat guide-chat"></div>
                <div id="guide-actions" class="guide-actions"></div>
                <div id="guide-input-row" style="display:none;">
                    <div class="prof-input-row">
                        <input type="text" id="guide-input" placeholder="Réponds en néerlandais…" onkeydown="if(event.key==='Enter') guideSendTyped()">
                        <button type="button" class="btn btn-green prof-send" onclick="guideSendTyped()">➤</button>
                    </div>
                    <div class="prof-mic-row">
                        <button type="button" class="btn btn-green" id="guide-mic" onclick="guideMic('nl')">🎤 Parler</button>
                        <button type="button" class="btn btn-gray" id="guide-hold" style="display:none;" onclick="guide && guide.rec && guide.rec.pause()">✋ Je réfléchis</button>
                        <button type="button" class="btn btn-gray" id="guide-mic-fr" onclick="guideMic('fr')">🇫🇷 En français</button>
                    </div>
                    <div class="lc-row">${liveCorrectToggleHtml()}</div>
                    <div id="guide-conv-extra"></div>
                </div>`;
            const st = modRpState(id);
            const pos = guidePos();
            if (pos.e >= m.etapes.length && st.finalResult && st.finalResult.passed) { guideOfferPassed(); return; }
            if (pos.e > 0 || pos.b > 0) {
                const e = m.etapes[pos.e];
                guideBubble('info', `<div class="prof-phase-title">On reprend : ${e ? `étape ${pos.e + 1} · ${rpEscapeHtml(e.titre)}` : "l'examen"}</div>`);
            }
            guideLoop(guide.token);
        }

        function guideQuit() {
            if (!guide) return;
            guide.run.stop = true;
            guideStopListen();
            if (conjAudioRun === guide.run) conjAudioStop();
            if (guide.resolver) { const r = guide.resolver; guide.resolver = null; r(null); }
        }

        function guideSkip() {
            if (!guide) return;
            guide.skipBeat = true;
            guide.run.skip = true;
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            guideStopListen();
            if (guide.resolver) { const r = guide.resolver; guide.resolver = null; r('__skip__'); }
        }

        function guideWaitFor() {
            return new Promise(resolve => { guide.resolver = resolve; });
        }
        function guideResolve(v) {
            if (!guide || !guide.resolver) return;
            const r = guide.resolver;
            guide.resolver = null;
            document.getElementById('guide-actions').innerHTML = '';
            r(v);
        }
        // Boutons sous le chat ; la promesse rend la valeur du bouton touché.
        function guideButtons(buttons) {
            document.getElementById('guide-actions').innerHTML = buttons.map(([v, label, cls]) =>
                `<button class="btn ${cls || 'btn-green'}" onclick="guideResolve('${v}')">${label}</button>`).join('');
            return guideWaitFor();
        }

        function guideBubble(who, html) {
            const chat = document.getElementById('guide-chat');
            if (!chat) return null;
            const div = document.createElement('div');
            div.className = 'prof-msg ' + who;
            div.innerHTML = html;
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            return div;
        }
        // Le guide parle (français).
        async function gSay(fr) {
            guideBubble('prof guide-voice', `<div>${rpEscapeHtml(fr)}</div>`);
            await conjAudioSayMixed(fr, 1);
        }
        // Une phrase néerlandaise (avec sa traduction) dite par la voix néerlandaise.
        async function gSayNl(nl, fr, speaker) {
            guideBubble('prof', `<div class="prof-nl">${rpEscapeHtml(nl)} ${speakBtnHtml(nl)}</div>${fr ? `<div class="prof-fr">${rpEscapeHtml(fr)}</div>` : ''}`);
            await conjAudioSay(nl, 'nl', 0.9, speaker !== undefined ? { speaker } : undefined);
        }

        function guideRenderTop() {
            const m = guide.m, pos = guidePos();
            const total = m.etapes.length * GUIDE_BEATS.length + 1;
            const done = Math.min(total, pos.e * GUIDE_BEATS.length + pos.b);
            const bar = document.getElementById('guide-bar');
            if (bar) bar.style.width = Math.round(done / total * 100) + '%';
            const where = document.getElementById('guide-where');
            if (where) where.innerText = pos.e >= m.etapes.length ? '🏆 Examen du module' : `Étape ${pos.e + 1}/${m.etapes.length} · ${m.etapes[pos.e].titre} · ${GUIDE_BEAT_LABELS[GUIDE_BEATS[pos.b]] || ''}`;
        }

        async function guideLoop(token) {
            while (guideAlive(token)) {
                const m = guide.m, pos = guidePos();
                guide.run.skip = false;
                guide.skipBeat = false;
                guideRenderTop();
                if (pos.e >= m.etapes.length) { await guideExam(token); return; }
                const beat = GUIDE_BEATS[pos.b];
                if (!beat) { guideSetPos(pos.e + 1, 0); continue; }
                const e = m.etapes[pos.e];
                const res = await GUIDE_FN[beat](e, token, pos);
                if (!guideAlive(token)) return;
                if (res && res.goto) { guideSetPos(res.goto.e, res.goto.b); continue; }
                if (res === 'again') continue;
                guideSetPos(pos.e, pos.b + 1);
            }
        }

        const GUIDE_FN = {
            async scene(e, token, pos) {
                const m = guide.m;
                if (pos.e === 0) {
                    await gSay(`On commence le module « ${m.titre} ». ${m.objectif} Je te guide pas à pas : écoute, répète, et réponds quand c'est ton tour.`);
                    if (!guideAlive(token)) return;
                }
                guideBubble('info', `<div class="prof-phase-title">Étape ${pos.e + 1} / ${m.etapes.length} · ${rpEscapeHtml(e.titre)}</div>`);
                await gSay(e.intro);
                if (guideAlive(token) && e.roles && e.roles.A) await gSay(`Dans cette scène, tu vas parler avec ${e.roles.A}.`);
            },

            async portrait(e, token) {
                const m = guide.m, P = m.portrait;
                if (!P || !e.portrait || !GUIDE_PORTRAIT_Q[e.id]) return;
                const p = modRpState(guide.id).portrait;
                const filled = k => p[k] !== undefined && p[k] !== '' && !(Array.isArray(p[k]) && !p[k].length);
                const qs = GUIDE_PORTRAIT_Q[e.id].filter(q => !filled(q.key));
                if (qs.length) {
                    await gSay("Avant d'apprendre, parle-moi un peu de toi. Je te pose la question en néerlandais, tu réponds en touchant ou en écrivant.");
                    for (const q of qs) {
                        if (!guideAlive(token) || guide.skipBeat) return;
                        await gSayNl(q.nl, q.fr);
                        if (!guideAlive(token)) return;
                        const v = await guideAskPortrait(q, P);
                        if (v === null || v === '__skip__') { if (!guideAlive(token) || guide.skipBeat) return; continue; }
                        if (v !== '__pass__') p[q.key] = v;
                        modRpInjectPerso(guide.id);
                        save();
                    }
                }
                const sentences = modRpSentences(guide.id).filter(s => s.etape === e.id);
                if (!sentences.length || !guideAlive(token) || guide.skipBeat) return;
                await gSay(qs.length ? 'Voilà comment tu le dis en néerlandais. Répète après moi :' : 'Tes phrases pour cette étape, répète après moi :');
                for (const s of sentences) {
                    if (!guideAlive(token) || guide.skipBeat) return;
                    await gSayNl(s.nl, s.fr);
                    await conjAudioWait(2200);
                }
            },

            async vocab(e, token) {
                const verbFr = v => { const c = conjugationData.find(x => x.infinitief === v); return c ? c.fr : ''; };
                const items = e.vocab.verbes.map(v => ({ nl: v, fr: verbFr(v) })).concat(e.vocab.mots, e.vocab.phrases || []);
                await gSay('Voici les mots dont tu vas avoir besoin. Écoute-les une fois :');
                if (!guideAlive(token)) return;
                guideBubble('info', `<div class="guide-vocab">${items.map(x => `<div class="prep-row"><span class="prep-nl">${rpEscapeHtml(x.nl)}</span><span class="prep-fr">${rpEscapeHtml(x.fr || '')}</span><span class="prep-actions">${speakBtnHtml(x.nl)}</span></div>`).join('')}</div>`);
                for (const x of items) {
                    if (!guideAlive(token) || guide.skipBeat) break;
                    await conjAudioSay(x.nl, 'nl', 0.85);
                    if (x.fr) await conjAudioSay(x.fr.replace(/\s*\/\s*/g, ', '), 'fr', 1.1);
                    await conjAudioWait(350);
                }
                if (!guideAlive(token) || guide.skipBeat) return;
                await guideButtons([['ok', "➡️ C'est bon, on continue"]]);
            },

            async ecoute(e, token) {
                if (!(e.dialogue || []).length) return;
                const A = (e.roles && e.roles.A) || 'A', B = (e.roles && e.roles.B) || 'Toi';
                await gSay(`Écoute d'abord la conversation.`);
                await guideDialogue(e, false, token, A, B);
            },

            async jouer(e, token) {
                if (!(e.dialogue || []).length) return;
                const A = (e.roles && e.roles.A) || 'A', B = (e.roles && e.roles.B) || 'Toi';
                const canListen = !!window.SpeechRecognition;
                await gSay(canListen
                    ? `À toi maintenant. Je fais ${A}. Quand c'est ton tour, je te montre ta phrase en français : dis-la en néerlandais.`
                    : `À toi maintenant. Je fais ${A}. Quand c'est ton tour, lis ta réplique à voix haute.`);
                if (!guideAlive(token)) return;
                const r = await guideDialogue(e, canListen, token, A, B);
                if (!guideAlive(token) || guide.skipBeat || !r || !r.asked) return;
                await gSay(r.ok === r.asked ? `Parfait, ${r.ok} sur ${r.asked} du premier coup !` : `${r.ok} sur ${r.asked} du premier coup. Ce n'est pas grave : on retravaille tout ça juste après.`);
            },

            async regle(e, token) {
                guideBubble('info', `<div class="conj-card modrp-rule" style="margin:0;"><div class="section-title" style="margin-top:0;">💡 ${rpEscapeHtml(e.regle.titre)}</div><p>${rpEscapeHtml(e.regle.explication)}</p>${e.regle.exemples.map(x => `<div class="prep-row"><span class="prep-nl">${rpEscapeHtml(x.nl)}</span><span class="prep-fr">${rpEscapeHtml(x.fr)}</span><span class="prep-actions">${speakBtnHtml(x.nl)}</span></div>`).join('')}</div>`);
                await conjAudioSayMixed('La règle : ' + e.regle.titre + '. ' + e.regle.explication, 1);
                for (const x of e.regle.exemples) {
                    if (!guideAlive(token) || guide.skipBeat) break;
                    await conjAudioSay(x.nl, 'nl', 0.85);
                    await conjAudioWait(300);
                }
                if (!guideAlive(token) || guide.skipBeat) return;
                await guideButtons([['ok', '➡️ Compris, aux exercices']]);
            },

            async exercices(e, token) {
                const id = guide.id;
                const all = modRpExercises(id, e);
                const need = Math.ceil(0.7 * all.length);
                await gSay(`Maintenant, ${all.length} petits exercices. Il en faut ${need} de justes pour valider l'étape.`);
                if (!guideAlive(token)) return;
                let r = await guideRunExercises(e, all, token);
                if (!r) return;
                let score = r.score, round = 0;
                let missed = all.filter((q, i) => !r.results[i]);
                while (score < need && round < 2 && guideAlive(token) && !guide.skipBeat) {
                    round++;
                    await gSay(`${score} sur ${all.length}. Il en faut ${need}. Je te rappelle la règle, et on refait celles que tu as ratées.`);
                    if (!guideAlive(token)) return;
                    await conjAudioSayMixed(e.regle.titre + '. ' + e.regle.explication, 1);
                    const r2 = await guideRunExercises(e, missed, token);
                    if (!r2) return;
                    score += r2.score;
                    missed = missed.filter((q, i) => !r2.results[i]);
                }
                const st = modRpState(id).etapes[e.id] || (modRpState(id).etapes[e.id] = {});
                st.best = Math.max(st.best || 0, Math.min(score, all.length));
                save();
                if (!guideAlive(token) || guide.skipBeat) return;
                if (score >= need) { await gSay(`Bravo, ${Math.min(score, all.length)} sur ${all.length} : c'est validé !`); return; }
                await gSay("Ce n'est pas encore tout à fait ça. Tu peux tout refaire, ou continuer et y revenir plus tard.");
                const v = await guideButtons([['again', '🔁 Refaire tous les exercices'], ['go', '➡️ Continuer quand même', 'btn-gray']]);
                if (v === 'again') return 'again';
            },

            async jeu(e, token) {
                const id = guide.id;
                const st = modRpState(id).etapes[e.id] || (modRpState(id).etapes[e.id] = {});
                if (!GeminiService.getKey()) {
                    st.played = true;
                    save();
                    await gSay("Le petit jeu de rôle demande une clé Gemini. Tu as déjà joué le dialogue : on passe à la suite.");
                } else {
                    await gSay(`Petit jeu de rôle pour finir l'étape. ${e.jeu.consigne}`);
                    if (!guideAlive(token)) return;
                    const conv = await guideConversation('etape', e.id, token, 4);
                    if (!conv) return;
                    st.played = true;
                    save();
                }
                if (!guideAlive(token)) return;
                const isLast = guidePos().e === guide.m.etapes.length - 1;
                await gSay(modRpEtapeDone(id, e)
                    ? `Étape « ${e.titre} » terminée !${isLast ? " Il ne reste plus que l'examen." : ' On passe à la suivante.'}`
                    : `Étape « ${e.titre} » vue. Les exercices ne sont pas encore à 70 % : tu pourras la refaire depuis le sommaire.`);
            }
        };

        function guideAskPortrait(q, P) {
            let html = '';
            if (q.type === 'text') html = `<div class="prof-input-row"><input type="text" id="guide-pf" placeholder="${rpEscapeHtml(q.ph || '')}" autocomplete="off"><button class="btn btn-green prof-send" onclick="guidePortraitOk('text')">OK</button></div>`;
            else if (q.type === 'num') html = `<div class="conj-audio-chips">${[0, 1, 2, 3, 4, 5].map(n => `<button class="conj-filter-chip" onclick="guideResolve('${n}')">${n === 5 ? '5+' : n}</button>`).join('')}</div>` +
                (q.key === 'leeftijd' ? '' : '');
            else if (q.type === 'select') html = `<div class="prof-input-row"><select id="guide-pf" class="prof-select"><option value="">—</option>${q.list(P).map(x => `<option value="${rpEscapeHtml(x)}">${rpEscapeHtml(x)}</option>`).join('')}</select><button class="btn btn-green prof-send" onclick="guidePortraitOk('text')">OK</button></div>`;
            else if (q.type === 'choice') html = `<div class="conj-audio-chips">${q.options.map(([v, l]) => `<button class="conj-filter-chip" onclick="guideResolve('${v}')">${rpEscapeHtml(l)}</button>`).join('')}</div>`;
            else if (q.type === 'multi') html = `<div class="conj-audio-chips" id="guide-pf-multi">${q.list(P).map(x => `<button type="button" class="conj-filter-chip" data-v="${rpEscapeHtml(x)}" onclick="this.classList.toggle('active')">${rpEscapeHtml(x)}</button>`).join('')}</div><button class="btn btn-green" onclick="guidePortraitOk('multi')">OK</button>`;
            if (q.key === 'leeftijd') html = `<div class="prof-input-row"><input type="number" min="1" max="120" id="guide-pf" placeholder="Ton âge"><button class="btn btn-green prof-send" onclick="guidePortraitOk('text')">OK</button></div>`;
            document.getElementById('guide-actions').innerHTML = `<div class="guide-portrait">${html}<button class="btn btn-gray" onclick="guideResolve('__pass__')">Je préfère ne pas répondre</button></div>`;
            return guideWaitFor();
        }
        function guidePortraitOk(kind) {
            if (kind === 'multi') {
                const v = [...document.querySelectorAll('#guide-pf-multi .active')].map(b => b.dataset.v);
                guideResolve(v);
                return;
            }
            const el = document.getElementById('guide-pf');
            const v = el ? el.value.trim() : '';
            if (!v) return;
            guideResolve(v);
        }

        // Dialogue modèle dans le chat : écoute seule, ou l'apprenant joue le rôle B (micro court).
        async function guideDialogue(e, play, token, A, B) {
            const pre = 'gl-' + Math.floor(Math.random() * 1e9) + '-';
            guideBubble('info', `<div class="guide-dialog">${e.dialogue.map((l, i) => `<div class="modrp-line modrp-${l.qui}" id="${pre}${i}"><b>${rpEscapeHtml(l.qui === 'A' ? A : B)}</b> : <span class="modrp-line-nl${play && l.qui === 'B' ? ' hidden' : ''}">${rpEscapeHtml(l.nl)}</span> <small>${rpEscapeHtml(l.fr)}</small></div>`).join('')}</div>`);
            let ok = 0, asked = 0;
            for (let i = 0; i < e.dialogue.length; i++) {
                if (!guideAlive(token) || guide.skipBeat) break;
                const l = e.dialogue[i], el = document.getElementById(pre + i);
                if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
                if (play && l.qui === 'B') {
                    asked++;
                    let heard = await conjAudioListen();
                    if (!guideAlive(token)) break;
                    let good = !!heard && heard.some(h => rpSpeechMatch(h, l.nl));
                    if (good) ok++;
                    else if (!guide.skipBeat) {
                        await conjAudioSay(l.nl, 'nl', 0.85);
                        heard = await conjAudioListen();
                        good = !!heard && heard.some(h => rpSpeechMatch(h, l.nl));
                    }
                    if (el) { el.querySelector('.modrp-line-nl').classList.remove('hidden'); el.classList.add(good ? 'good' : 'bad'); }
                    if (!good) await conjAudioSay(l.nl, 'nl', 0.85);
                } else {
                    await conjAudioSay(l.nl, 'nl', 0.9, { speaker: l.qui === 'A' ? 0 : 1 });
                    await conjAudioWait(250);
                }
                if (el) el.classList.remove('active');
            }
            return { ok, asked };
        }

        // Une série d'exercices dans le chat (moteur des exercices de module) ; rend { score, results }.
        async function guideRunExercises(e, list, token) {
            const boxId = 'guide-ex-' + Math.floor(Math.random() * 1e9);
            guideBubble('info', `<div id="${boxId}"></div>`);
            const done = guideWaitFor();
            modRpEx = {
                etapeId: e.id, list, i: 0, score: 0, built: [], results: [], boxId,
                onDone: ex => guideResolve(ex),
                onRender: q => guideExerciseVoice(q, token),
                onCheck: (ok, expected) => {
                    if (!guideAlive(token)) return;
                    if (ok) conjAudioSpeak(['Goed!', 'Juist!', 'Prima!'][Math.floor(Math.random() * 3)], 'nl', 1);
                    else conjAudioSpeak(expected, 'nl', 0.85);
                }
            };
            modRpRenderEx();
            const chat = document.getElementById('guide-chat');
            chat.scrollTop = chat.scrollHeight;
            const ex = await done;
            const box = document.getElementById(boxId);
            if (box) { box.removeAttribute('id'); box.innerHTML = ex && ex !== '__skip__' ? `<div class="report-meta">Exercices : ${ex.score}/${list.length}</div>` : ''; }
            if (!ex || ex === '__skip__') { modRpEx = null; return null; }
            modRpEx = null;
            return { score: ex.score, results: ex.results || [] };
        }

        // Lecture de la consigne et micro automatique pour les exercices oraux.
        async function guideExerciseVoice(q, token) {
            const chat = document.getElementById('guide-chat');
            if (chat) chat.scrollTop = chat.scrollHeight;
            if (!guideAlive(token)) return;
            const ex = modRpEx;
            if (q.type === 'ecoute') await conjAudioSpeak(q.nl, 'nl', 0.85);
            else if (q.type === 'repondre') await conjAudioSpeak(q.question, 'nl', 0.9);
            else if (q.type === 'dire' || q.type === 'traduire') await conjAudioSpeakMixed(q.fr, 1, 0.85, () => guideAlive(token));
            if (!guideAlive(token) || modRpEx !== ex || !window.SpeechRecognition) return;
            if (['dire', 'repondre', 'traduire', 'ecoute'].includes(q.type) && ex.list[ex.i] === q) modRpMic();
        }

        // ----- Conversation (jeu de rôle d'étape ou examen) dans le chat -----
        // Prompt du personnage = celui des modules (modRpRolePrompt) + réponse en JSON avec un champ
        // « fr » quand l'apprenant parle français. Sans Gemini (examen seulement), le guide relance.
        function guideStopListen() {
            if (guide && guide.rec) { const r = guide.rec; guide.rec = null; r.finish(false); }
        }
        function guideMicState(lang, cd, hold) {
            const nl = document.getElementById('guide-mic'), fr = document.getElementById('guide-mic-fr'), wait = document.getElementById('guide-hold');
            const manual = profSettings().silence === 0 || hold;
            const label = cd ? `📤 Envoi dans ${cd}… (touche pour envoyer)` : (manual ? '🎙️ J\'écoute… touche pour envoyer' : '🎙️ J\'écoute… (touche pour envoyer)');
            if (nl) nl.innerText = lang === 'nl' ? label : '🎤 Parler';
            if (fr) fr.innerText = lang === 'fr' ? label : '🇫🇷 En français';
            if (wait) wait.style.display = lang && !manual ? '' : 'none';
        }
        function guideMic(lang) {
            if (!guide) return;
            if (guide.rec) { guide.rec.finish(true); return; }
            if (!window.SpeechRecognition) { alert("Ton navigateur ne supporte pas la reconnaissance vocale : écris ta réponse, ou utilise Google Chrome."); return; }
            if (!guide.conv || guide.conv.busy) return;
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            guide.rec = longListen({
                lang, input: document.getElementById('guide-input'), silence: profSettings().silence,
                isActive: guideActive,
                onState: (st, cd) => guideMicState(lang, cd, st.hold),
                onEnd: st => { if (guide && guide.rec === st) guide.rec = null; guideMicState(null); },
                onSubmit: text => guideConvSubmit(text, lang === 'fr')
            });
        }
        function guideSendTyped() {
            const input = document.getElementById('guide-input');
            const text = input ? input.value.trim() : '';
            if (!text) return;
            input.value = '';
            guideConvSubmit(text, /(\bcomment\b|\bpourquoi\b|est-ce|c'est|qu'est|veut dire|\bje ne\b|\bje comprends\b|\bon dit\b|ça|\bquoi\b|\bque\b|\bles\b)/i.test(text));
        }
        function guideConvSubmit(text, isFr) {
            if (!guide || !guide.conv || guide.conv.busy || !guide.resolver) return;
            guideResolve({ text, isFr });
        }

        async function guideConversation(kind, etapeId, token, maxTurns) {
            const id = guide.id;
            const { jeu, prompt } = modRpRolePrompt(id, etapeId);
            const conv = { busy: false, history: [{ who: 'them', nl: jeu.welcome }], userLines: [] };
            guide.conv = conv;
            const row = document.getElementById('guide-input-row');
            row.style.display = '';
            document.getElementById('guide-conv-extra').innerHTML = kind === 'exam'
                ? `<button class="btn btn-gray" style="margin-top:8px;" onclick="guideResolve('__fin__')">🏁 J'ai fini : évaluer ma présentation</button>` : '';
            const themSay = async (nl, fr, nlFr) => {
                guideBubble('prof', `${fr ? `<div class="prof-fr">🇫🇷 ${rpEscapeHtml(fr)}</div>` : ''}<div class="prof-nl">${rpEscapeHtml(nl)} ${speakBtnHtml(nl)}</div>${nlFr ? `<details class="prof-trad"><summary>Traduction</summary>${rpEscapeHtml(nlFr)}</details>` : ''}`);
                if (fr) await conjAudioSayMixed(fr, 1);
                await conjAudioSay(nl, 'nl', 0.9, { speaker: 0 });
            };
            await themSay(jeu.welcome, '', '');
            const fallback = ['Oké. En verder?', 'Goed. Vertel nog iets.', 'Interessant! En wat nog meer?'];
            let turns = 0, finished = false;
            while (guideAlive(token) && !finished) {
                if (window.SpeechRecognition && !guide.rec) guideMic('nl');
                const ans = await guideWaitFor();
                guideStopListen();
                if (!guideAlive(token) || ans === null || ans === '__skip__') break;
                if (ans === '__fin__') break;
                const meDiv = guideBubble('moi', `${ans.isFr ? '🇫🇷 ' : ''}${rpEscapeHtml(ans.text)}`);
                if (!ans.isFr) { const lastThem = [...conv.history].reverse().find(h => h.who === 'them'); const said = ans.text; (liveCorrectOn() ? liveCorrectUnder(meDiv, said, null, lastThem ? lastThem.nl : '') : Promise.resolve(null)).then(c => usedWordsRecord(said, c)); }
                conv.history.push({ who: 'me', text: ans.text, isFr: ans.isFr });
                if (!ans.isFr) { conv.userLines.push(ans.text); turns++; }
                const closing = !!maxTurns && turns >= maxTurns;
                conv.busy = true;
                let reply = null;
                if (GeminiService.getKey()) {
                    const hist = conv.history.map(h => h.who === 'them' ? 'Toi (personnage) : ' + h.nl : 'Apprenant' + (h.isFr ? ' (EN FRANÇAIS)' : '') + ' : ' + h.text).join('\n');
                    try {
                        reply = rpHelpParseJson(await GeminiService.generate(prompt +
                            '\n\nRègles en plus :\n- Si l\'apprenant parle FRANÇAIS (une question, un mot qui lui manque), réponds-lui d\'abord en français dans "fr" (1 ou 2 phrases simples, avec la formule néerlandaise utile), puis relance en néerlandais dans "nl" en restant dans ton rôle. Sinon "fr" reste vide.\n- 1 ou 2 phrases courtes en néerlandais.' +
                            (closing ? '\n- C\'est ta DERNIÈRE réplique : réagis et conclus gentiment, sans nouvelle question.' : '') +
                            '\n\nConversation :\n' + hist + '\n\nRéponds UNIQUEMENT en JSON : {"fr": "", "nl": "", "nl_fr": "traduction française de nl"}'));
                    } catch (e) { reply = null; }
                }
                if (!reply || !reply.nl) reply = { nl: fallback[turns % fallback.length], fr: '', nl_fr: '' };
                conv.busy = false;
                if (!guideAlive(token)) break;
                conv.history.push({ who: 'them', nl: reply.nl });
                await themSay(reply.nl, reply.fr, reply.nl_fr);
                if (closing) finished = true;
                if (kind === 'exam' && turns >= 14) finished = true;
            }
            guideStopListen();
            row.style.display = 'none';
            guide.conv = null;
            if (!guideAlive(token)) return null;
            return conv;
        }

        // ----- Examen -----
        async function guideExam(token) {
            const id = guide.id, m = guide.m;
            const st = modRpState(id);
            guideBubble('info', `<div class="prof-phase-title">🏆 Examen du module</div>`);
            await gSay(`Dernière ligne droite : l'examen. ${m.final.consigne} Quand tu as tout dit, touche « J'ai fini ».`);
            if (!guideAlive(token)) return;
            const conv = await guideConversation('exam', 'final', token, 0);
            if (!conv) return;
            st.final = true;
            save();
            if (!conv.userLines.length) {
                await gSay("Tu n'as encore rien dit en néerlandais. On recommence l'examen quand tu veux.");
                const v = await guideButtons([['again', "🔁 Recommencer l'examen"]]);
                if (v === 'again' && guideAlive(token)) guideExam(token);
                return;
            }
            const { checks, covered, coverageOk } = modRpExamChecks(id, conv.userLines);
            guideBubble('info', '<div class="report-meta" id="guide-judging">L\'examinateur écoute ta présentation…</div>');
            const transcript = conv.history.map(h => (h.who === 'me' ? 'APPRENANT : ' : 'INTERLOCUTEUR : ') + (h.text || h.nl)).join('\n');
            const judge = await modRpExamJudge(id, transcript);
            const wait = document.getElementById('guide-judging');
            if (wait) wait.parentElement.remove();
            if (!guideAlive(token)) return;
            const score = judge && typeof judge.note === 'number' ? judge.note : null;
            const passed = coverageOk && (score === null || score >= 6);
            st.finalResult = { passed: passed || !!(st.finalResult && st.finalResult.passed), lastScore: score, lastCovered: covered, at: Date.now() };
            save();
            if (passed) modRpValidateNotions(id); else modRpFlagMissing(id, checks.filter(c => !c.ok).map(c => c.etape));
            const arr = x => Array.isArray(x) ? x : [];
            guideBubble('info', `<div class="prof-debrief">
                <div class="prof-target-title">${passed ? '✅ Module réussi !' : '🔁 Presque : encore un essai'}</div>
                <div class="prof-deb-sec">📋 Sujets abordés (${covered}/${checks.length})</div>
                ${checks.map(c => `<div class="modrp-check ${c.ok ? 'ok' : 'ko'}">${c.ok ? '✓' : '✗'} ${rpEscapeHtml(c.label)}</div>`).join('')}
                ${judge ? `<div class="prof-deb-sec">🗣️ Communication : ${score !== null ? score + '/10' : '—'}</div>
                    ${judge.resume ? `<p>${rpEscapeHtml(judge.resume)}</p>` : ''}
                    ${arr(judge.points_forts).length ? `<div class="prof-deb-sec">👍 Points forts</div><ul>${arr(judge.points_forts).map(x => `<li>${rpEscapeHtml(x)}</li>`).join('')}</ul>` : ''}
                    ${arr(judge.corrections).length ? `<div class="prof-deb-sec">✍️ À corriger</div><ul>${arr(judge.corrections).map(c => `<li>« ${rpEscapeHtml(c.phrase || '')} » → <b>${rpEscapeHtml(c.correction || '')}</b> ${c.correction ? speakBtnHtml(c.correction) : ''}<br><small>${rpEscapeHtml(c.explication || '')}</small></li>`).join('')}</ul>` : ''}
                    ${judge.conseil ? `<div class="prof-deb-sec">💡 Conseil</div><p>${rpEscapeHtml(judge.conseil)}</p>` : ''}` : ''}
            </div>`);
            if (passed) {
                await gSay(`Bravo, le module « ${m.titre} » est réussi !`);
                guideOfferPassed(true);
                return;
            }
            const missing = checks.filter(c => !c.ok);
            const toReview = [...new Set(missing.map(c => c.etape))].map(eid => m.etapes.findIndex(e => e.id === eid)).filter(i => i >= 0);
            await gSay(missing.length
                ? `Il te manque : ${missing.map(c => c.label).join(', ')}. ${toReview.length ? 'Je te propose de revoir ' + (toReview.length > 1 ? 'ces étapes' : 'cette étape') + ', ou de retenter directement.' : 'Retente quand tu veux.'}`
                : 'Tu as parlé de tout, mais il faut être un peu plus clair. Retente quand tu veux.');
            const v = await guideButtons(toReview.map(i => ['e' + i, `📖 Revoir : ${rpEscapeHtml(m.etapes[i].titre)}`, 'btn-gray']).concat([['again', "🔁 Repasser l'examen"]]));
            if (!guideAlive(token) || !v) return;
            if (v === 'again') { guideExam(token); return; }
            if (v[0] === 'e') { guideSetPos(parseInt(v.slice(1), 10), GUIDE_BEATS.indexOf('vocab')); guideLoop(token); }
        }

        // Examen direct (« j'ai déjà des bases ») : on saute les étapes.
        function guideExamDirect(id) {
            const m = modRpData[id];
            if (!m) return;
            if (!GeminiService.isAvailable() && !confirm("Sans clé Gemini, l'examen est jugé seulement sur les sujets abordés, sans avis détaillé. Continuer ?")) return;
            modRpState(id).guide = { e: m.etapes.length, b: 0 };
            save();
            guideStart(id);
        }

        // Module déjà réussi : module suivant, ou le refaire.
        async function guideOfferPassed(justNow) {
            const id = guide.id, token = guide.token;
            const next = MODRP_IDS.slice(MODRP_IDS.indexOf(id) + 1).map(x => modRpData[x]).find(Boolean);
            if (!justNow) await gSay(`Tu as déjà réussi le module « ${guide.m.titre} ».`);
            const v = await guideButtons((next ? [['next', `▶️ Module suivant : ${rpEscapeHtml(next.titre)}`]] : []).concat([['restart', '🔁 Refaire le module depuis le début', 'btn-gray'], ['exam', "🏆 Repasser l'examen", 'btn-gray']]));
            if (!guide || guide.token !== token || !v) return;
            if (v === 'next') { guideStart(next.id); return; }
            if (v === 'restart') { guideSetPos(0, 0); guideLoop(token); return; }
            if (v === 'exam') { guideSetPos(guide.m.etapes.length, 0); guideExam(token); }
        }

        // ===== Discuter (conversation libre, inspirée des apps de type « partenaire IA ») =====
        // Deux partenaires, Svetlana et John. Deux façons de parler : « de tout et de rien » (en
        // ami, sur un sujet) ou « une situation » de la vie courante (pharmacie, logement, soirée… :
        // les situations « quotidien » de situations_library.json, rangées par famille), où le
        // partenaire joue le rôle décrit. Pensé pour la fluidité : UN seul appel Gemini par tour renvoie la réplique,
        // la correction douce de la dernière phrase de l'apprenant et 3 suggestions de réponse
        // (exception assumée à la séparation des prompts : ici, pas d'examen ni de note).
        // Micro mains libres (longListen), mots touchables, mémoire des conversations par
        // partenaire et petit objectif quotidien (state.talk).
        const TALK_PARTNERS = {
            svetlana: { name: 'Svetlana', emoji: '👩🏼', speaker: 0, desc: 'Curieuse et chaleureuse : elle rebondit sur chaque détail et adore les histoires.',
                base: "Tu es Svetlana, une femme d'une trentaine d'années qui vit en Flandre depuis longtemps : chaleureuse, curieuse, tu rebondis sur les détails et tu partages volontiers tes propres anecdotes." },
            john: { name: 'John', emoji: '👨🏽', speaker: 1, desc: 'Détendu et blagueur : il donne son avis sur tout et aime les bons plans.',
                base: "Tu es John, un homme d'une quarantaine d'années, détendu, avec de l'humour ; tu aimes le sport, la musique et les bons plans, et tu donnes volontiers ton avis." }
        };
        const TALK_FAMILIES_FALLBACK = { demarches: '🏛️ Démarches', logement: '🏠 Logement', sante: '🩺 Santé et urgences', courses: '🛒 Courses et services', sorties: '🍽️ Sorties', social: '🤝 Vie sociale', telephone: '☎️ Au téléphone', transport: '🚆 Transports' };
        function talkFamilies() { return (rpLibData && rpLibData.familles) || TALK_FAMILIES_FALLBACK; }
        function talkSituations() { return rpLibAll().filter(e => e.theme === 'quotidien'); }
        const TALK_TOPICS = {
            libre: '🗨️ Libre', weekend: '🌤️ Mon week-end', travail: '💼 Le travail', voyages: '✈️ Les voyages',
            cuisine: '🍝 La cuisine', series: '🎬 Films et séries', sport: '⚽ Le sport', projets: '🚀 Mes projets'
        };
        const TALK_GOAL = 10; // échanges par jour
        let talk = null;      // conversation en cours
        let talkRec = null;   // écoute en cours

        function talkSettings() {
            if (!state.settings) state.settings = {};
            const s = state.settings.talk || {};
            const lvl = ['A1', 'A2', 'B1', 'B2'];
            state.settings.talk = {
                partner: TALK_PARTNERS[s.partner] ? s.partner : 'svetlana',
                mode: s.mode === 'situation' ? 'situation' : 'libre',
                topic: TALK_TOPICS[s.topic] || s.topic === 'surprise' ? s.topic : 'libre',
                level: lvl.includes(s.level) ? s.level : (curriculumLoaded && lvl.includes(getCurriculumLevel().level) ? getCurriculumLevel().level : 'A1'),
                handsfree: s.handsfree !== false
            };
            return state.settings.talk;
        }
        function talkSet(k, v) { talkSettings()[k] = v; save(); talkRenderSetup(); }

        function talkState() {
            if (!state.talk) state.talk = {};
            if (!state.talk.memory) state.talk.memory = {};
            if (!state.talk.days) state.talk.days = {};
            return state.talk;
        }
        function talkToday() { return new Date().toISOString().slice(0, 10); }
        function talkTodayCount() { return talkState().days[talkToday()] || 0; }
        function talkStreak() {
            const days = talkState().days;
            let n = 0;
            const d = new Date();
            if (!days[talkToday()]) d.setDate(d.getDate() - 1); // la série tient tant qu'on n'a pas raté hier
            while (days[d.toISOString().slice(0, 10)]) { n++; d.setDate(d.getDate() - 1); }
            return n;
        }
        function talkRingHtml(size) {
            const pct = Math.min(1, talkTodayCount() / TALK_GOAL);
            const r = 16, c = 2 * Math.PI * r;
            return `<svg class="talk-ring" width="${size}" height="${size}" viewBox="0 0 40 40"><circle cx="20" cy="20" r="${r}" class="talk-ring-bg"/><circle cx="20" cy="20" r="${r}" class="talk-ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/><text x="20" y="24" text-anchor="middle">${Math.min(talkTodayCount(), 99)}</text></svg>`;
        }

        async function showTalk() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('talk-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            if (talk && !talk.ended) { talkRenderChat(); return; }
            await rpLoadLibrary();
            talkRenderSetup();
        }

        // Situation de la vie courante, ouverte depuis Discuter, le kit 📚 ou le compagnon.
        async function talkOpenSituation(id) {
            await rpLoadLibrary();
            const e = rpLibFind(id);
            if (!e) return showTalk();
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('talk-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            if (!GeminiService.isAvailable()) { talkRenderSetup(); return; }
            talkStart(e.id);
        }

        function talkRenderSetup() {
            const s = talkSettings();
            const chip = (on, click, label) => `<button type="button" class="conj-filter-chip${on ? ' active' : ''}" onclick="${click}">${label}</button>`;
            const streak = talkStreak();
            document.getElementById('talk-content').innerHTML = `
                <div class="talk-goal">${talkRingHtml(46)}<div><b>${talkTodayCount()} / ${TALK_GOAL} échanges aujourd'hui</b><br><small>${streak > 1 ? '🔥 ' + streak + ' jours de suite' : 'Un peu chaque jour, c\'est ce qui compte.'}</small></div></div>
                ${GeminiService.isAvailable() ? '' : '<div class="prof-warn">Il faut une clé Gemini : Profil 👤 → 🤖 Intelligence IA.</div>'}
                <div class="talk-partners">${Object.entries(TALK_PARTNERS).map(([k, p]) => `
                    <button type="button" class="talk-partner${s.partner === k ? ' active' : ''}" onclick="talkSet('partner','${k}')">
                        <span class="talk-avatar">${p.emoji}</span><b>${p.name}</b><small>${p.desc}</small>
                        ${talkState().memory[k] ? '<small class="talk-remember">💭 se souvient de vous</small>' : ''}
                    </button>`).join('')}</div>
                <div class="talk-modes">
                    <button type="button" class="talk-mode${s.mode === 'libre' ? ' active' : ''}" onclick="talkSet('mode','libre')">🗨️ De tout et de rien</button>
                    <button type="button" class="talk-mode${s.mode === 'situation' ? ' active' : ''}" onclick="talkSet('mode','situation')">🎭 Une situation</button>
                </div>
                ${s.mode === 'libre' ? `
                <div class="conj-audio-chips">${Object.entries(TALK_TOPICS).map(([k, t]) => chip(s.topic === k, `talkSet('topic','${k}')`, t)).join('')}${chip(s.topic === 'surprise', "talkSet('topic','surprise')", '🎲 Surprends-moi')}</div>
                <button class="btn btn-green talk-start" onclick="talkStart()" ${GeminiService.isAvailable() ? '' : 'disabled'}>💬 Parler avec ${TALK_PARTNERS[s.partner].name}</button>` : talkSituationListHtml()}
                <details class="talk-settings"><summary>⚙️ Réglages</summary>
                    <div class="conj-audio-label">Ton niveau</div>
                    <div class="conj-audio-chips">${['A1', 'A2', 'B1', 'B2'].map(l => chip(s.level === l, `talkSet('level','${l}')`, l)).join('')}</div>
                    <div class="conj-audio-chips" style="margin-top:8px;">${chip(s.handsfree, "talkSet('handsfree',true)", '🗣️ Mains libres')}${chip(!s.handsfree, "talkSet('handsfree',false)", '👆 Je touche le micro')}</div>
                </details>`;
        }

        // Les situations par famille ; 📚 prépare les mots, 👂 fait écouter une scène.
        function talkSituationListHtml() {
            const all = talkSituations();
            const fams = talkFamilies();
            const p = TALK_PARTNERS[talkSettings().partner];
            const row = e => rpPrepRow(`<button class="rp-scenario-btn" onclick="talkStart('${e.id}')" ${GeminiService.isAvailable() ? '' : 'disabled'}>${rpEscapeHtml(e.label)}${e.generated ? ' <span class="wl-badge unseen">🎲</span>' : ''}</button>`, 'lib:' + e.id, e.label, { type: 'lib', id: e.id });
            const keys = Object.keys(fams).concat([...new Set(all.map(e => e.famille || 'autres'))].filter(k => !fams[k]));
            return `<p class="rp-real-hint">${p.name} joue le rôle (pharmacien, propriétaire, voisine…) et t'aide comme d'habitude : suggestions, corrections, et ton tuteur à la fin.</p>
                <button class="btn btn-green talk-start" style="margin-top:4px;" onclick="talkStart('__random')" ${GeminiService.isAvailable() ? '' : 'disabled'}>🎲 Une situation au hasard</button>
                ${keys.map(k => { const list = all.filter(e => (e.famille || 'autres') === k); return list.length ? `<details class="talk-family"><summary>${rpEscapeHtml(fams[k] || '✨ Autres')} <small>(${list.length})</small></summary>${list.map(row).join('')}</details>` : ''; }).join('')}`;
        }

        function talkActive() { return !!(talk && !talk.ended && document.getElementById('talk-view').classList.contains('active')); }

        // sitId : id d'une situation de la vie courante, '__random' pour en tirer une, sinon conversation libre.
        function talkStart(sitId) {
            const s = talkSettings();
            const pick = o => { const k = Object.keys(o); return k[Math.floor(Math.random() * k.length)]; };
            let sit = null;
            if (sitId === '__random') { const all = talkSituations(); sit = all[Math.floor(Math.random() * all.length)] || null; }
            else if (sitId) sit = rpLibFind(sitId);
            const topic = s.topic === 'surprise' ? pick(TALK_TOPICS) : s.topic;
            talk = { partner: s.partner, p: TALK_PARTNERS[s.partner], sit, topic, level: s.level, handsfree: s.handsfree, history: [], log: [], suggestions: [], busy: false, ended: false, userCount: 0 };
            talkRenderChat();
            if (sit) talkAppend({ who: 'info', html: `<div class="talk-sit-card"><b>🎭 ${rpEscapeHtml(sit.label)}</b><div>${rpEscapeHtml(sit.contexte)}</div>
                ${(sit.kit && sit.kit.phrases || []).length ? `<details><summary>💬 Phrases utiles</summary>${sit.kit.phrases.map(x => `<div class="talk-sit-ph">${rpEscapeHtml(x.nl)} ${speakBtnHtml(x.nl)}<br><small>${rpEscapeHtml(x.fr)}</small></div>`).join('')}</details>` : ''}
                ${(sit.kit && sit.kit.mots || []).length ? `<details><summary>📖 Mots utiles</summary>${sit.kit.mots.map(x => `<span class="talk-sit-word"><b>${rpEscapeHtml(x.nl)}</b> ${rpEscapeHtml(x.fr)}</span>`).join(' · ')}</details>` : ''}</div>` });
            talkTurn();
        }

        function talkRenderChat() {
            const p = talk.p;
            document.getElementById('talk-content').innerHTML = `
                <div class="talk-head">
                    <span class="talk-avatar small">${p.emoji}</span>
                    <div class="talk-head-txt"><b>${p.name}</b><small>${talk.point ? '🧑‍🏫 On fait connaissance' : talk.sit ? '🎭 ' + rpEscapeHtml(talk.sit.label) : TALK_TOPICS[talk.topic]}</small></div>
                    ${liveCorrectToggleHtml()}
                    <span id="talk-ring-small">${talkRingHtml(34)}</span>
                    <button type="button" class="rp-coach-btn" onclick="talkEnd()">Terminer</button>
                </div>
                <div id="talk-chat" class="talk-chat"></div>
                <div id="talk-sugg" class="talk-sugg"></div>
                <div id="talk-text-row" class="prof-input-row" style="display:none;">
                    <input type="text" id="talk-input" placeholder="Écris en néerlandais…" onkeydown="if(event.key==='Enter') talkSendTyped()">
                    <button type="button" class="btn btn-green prof-send" onclick="talkSendTyped()">➤</button>
                </div>
                <div class="talk-bar">
                    <button type="button" class="talk-side" id="talk-fr" onclick="talkMic('fr')" title="Parler en français">🇫🇷</button>
                    <button type="button" class="talk-mic" id="talk-mic" onclick="talkMic('nl')">🎤</button>
                    <button type="button" class="talk-side" onclick="talkToggleText()" title="Écrire">⌨️</button>
                </div>
                <div id="talk-mic-hint" class="talk-mic-hint">Touche le micro pour parler</div>`;
            talk.log.forEach(m => talkAppend(m, true));
            talkRenderSugg();
        }

        function talkAppend(m, replay) {
            if (!replay) talk.log.push(m);
            const chat = document.getElementById('talk-chat');
            if (!chat) return null;
            const div = document.createElement('div');
            if (m.who === 'them') {
                div.className = 'talk-msg them';
                const words = rpAnnotateText(m.nl).replace(/rpWordTap\(this\)/g, 'talkWordTap(this)');
                div.innerHTML = `${m.help ? `<div class="talk-help">🇫🇷 ${rpEscapeHtml(m.help)}</div>` : ''}<div class="talk-nl">${words}</div>
                    <div class="talk-tools"><button type="button" onclick="talkReplay(this)" data-nl="${rpEscapeHtml(m.nl)}">🔁</button><button type="button" onclick="this.closest('.talk-msg').querySelector('.talk-fr').classList.toggle('show')">🇫🇷</button></div>
                    <div class="talk-fr">${rpEscapeHtml(m.fr || '')}</div><div class="talk-word"></div>`;
            } else if (m.who === 'me') {
                div.className = 'talk-msg me';
                div.innerHTML = `${m.isFr ? '🇫🇷 ' : ''}${rpEscapeHtml(m.text)}${m.corr ? talkCorrHtml(m.corr) : ''}`;
            } else {
                div.className = 'talk-msg info';
                div.innerHTML = m.html;
            }
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            return div;
        }

        function talkCorrHtml(c) {
            const fr = (c.francais || []).map(x => `<div class="lc-fr">🇫🇷 ${rpEscapeHtml(x.fr)} → <b>${rpEscapeHtml(x.nl)}</b></div>`).join('');
            const off = c.a_cote ? `<div class="lc-offq">❓ <b>Tu as répondu à côté</b>${c.comprehension_fr ? ' : ' + rpEscapeHtml(c.comprehension_fr) : ''}</div>` : '';
            return `<details class="talk-corr"${fr || off ? ' open' : ''}><summary>${off ? '❓ Réponse à côté' : '✨ Plus naturel'}</summary>${off}${c.natural ? `<b>${rpEscapeHtml(c.natural)}</b> ${speakBtnHtml(c.natural)}` : ''}${fr}${c.note_fr ? `<br><small>${rpEscapeHtml(c.note_fr)}</small>` : ''}</details>`;
        }

        function talkRenderSugg() {
            const el = document.getElementById('talk-sugg');
            if (!el || !talk) return;
            el.innerHTML = (talk.suggestions || []).map((s, i) => `<button type="button" class="talk-chip" onclick="talkUseSugg(${i})" title="${rpEscapeHtml(s.fr || '')}">${rpEscapeHtml(s.nl)}</button>`).join('');
        }

        function talkUseSugg(i) {
            const s = talk && talk.suggestions[i];
            if (!s) return;
            talkToggleText(true);
            const input = document.getElementById('talk-input');
            input.value = s.nl;
            document.getElementById('talk-mic-hint').innerText = '🇫🇷 ' + (s.fr || '') + ' · dis-la au micro ou envoie-la ➤';
            conjAudioSpeak(s.nl, 'nl', PROF_RATE[talk.level]);
        }

        function talkToggleText(force) {
            const row = document.getElementById('talk-text-row');
            if (!row) return;
            row.style.display = force === true || row.style.display === 'none' ? '' : 'none';
        }

        function talkReplay(btn) { conjAudioSpeak(btn.dataset.nl, 'nl', PROF_RATE[talk.level], { speaker: talk.p.speaker }); }

        // Mot touché : traduction tirée du vocabulaire de l'app (pas d'appel Gemini).
        function talkWordTap(el) {
            const box = el.closest('.talk-msg').querySelector('.talk-word');
            const token = el.textContent;
            const item = rpWordLookup(token);
            speakNL(token);
            if (!item) { box.innerHTML = `<b>${rpEscapeHtml(token)}</b> : pas encore dans ton vocabulaire (touche 🇫🇷 pour la phrase traduite).`; return; }
            const inList = item.id && rpWordsListIds().includes(item.id);
            box.innerHTML = `<b>${rpEscapeHtml(item.nl)}</b> = ${rpEscapeHtml(item.fr)} ${item.id && !inList ? `<button type="button" class="rp-coach-btn" style="margin:0 0 0 6px;" onclick="rpWordAddToList('${item.id}'); this.outerHTML='✅'">➕ À apprendre</button>` : (inList ? '✅' : '')}`;
        }

        function talkPrompt() {
            const p = talk.p, mem = talkState().memory[talk.partner];
            const portrait = typeof profPortrait === 'function' ? profPortrait() : [];
            const hist = talk.history.slice(-16).map(h => h.who === 'them' ? p.name + ' : ' + h.nl : 'Apprenant' + (h.isFr ? ' (EN FRANÇAIS)' : '') + ' : ' + h.text).join('\n');
            return `${p.base} Tu parles avec un(e) apprenant(e) francophone de néerlandais, niveau ${PROF_LEVEL_DESC[talk.level]}.
${talk.point ? talkPointPrompt() : talk.sit ? `Aujourd'hui, vous jouez une SITUATION de la vie courante en Flandre. Tu restes ${p.name} (même voix, même caractère), mais tu joues ce rôle : ${talk.sit.role}
La situation, vue par l'apprenant : ${talk.sit.contexte}
Registre : vouvoiement (u) avec un client, un patient ou un usager ; tutoiement (jij) entre amis, voisins ou collègues. Reste dans ton rôle, fais avancer la situation jusqu'à ce qu'elle soit réglée, puis conclus naturellement. Emploie naturellement certains de ces mots : ${(talk.sit.kit && talk.sit.kit.mots || []).map(m => m.nl).concat(talk.sit.kit && talk.sit.kit.verbes || []).join(', ')}.` : `Aujourd'hui, tu lui parles en ami(e) : conversation détendue, tutoiement (jij). Sujet de départ : ${TALK_TOPICS[talk.topic].replace(/^\S+\s/, '')} (si c'est « Libre », choisis un sujet simple du quotidien).`}
Ce dont tu te souviens de vos conversations précédentes : ${mem || "rien, c'est votre première conversation"}.
${portrait.length ? "Ce que tu sais de l'apprenant : " + portrait.join(' ') : ''}
Règles :
- Une vraie conversation, vivante, comme entre deux personnes : réagis à ce qu'il dit, raconte aussi un peu de toi, pose UNE question à la fois. 1 à 3 phrases courtes, adaptées à son niveau (A1 : phrases très simples et mots très courants).
- Néerlandais standard, comme en Flandre. Pas d'emojis.
- Ne corrige jamais dans "reply_nl" : la correction va seulement dans "correction".
- S'il parle FRANÇAIS (question, mot qui manque), réponds-lui brièvement en français dans "fr_help" avec la formule néerlandaise utile, puis continue en néerlandais dans "reply_nl". Sinon "fr_help" est vide.
- ${LIVE_MIX_RULES}
- ${LIVE_OFFTOPIC_RULE} S'il a répondu À CÔTÉ de ta question, ne rebondis pas comme si de rien n'était : dans "reply_nl", reformule gentiment ta question plus simplement ; et mets "a_cote": true dans "correction", avec "comprehension_fr" (ce que tu lui demandais, en une phrase).
- "correction" : seulement si sa DERNIÈRE phrase en néerlandais contient une faute, un passage en français, ou se dirait nettement plus naturellement : {"natural": "la phrase corrigée ou plus naturelle, entièrement en néerlandais", "note_fr": "explication très courte en français", "francais": [{"fr": "ce qu'il a dit en français", "nl": "l'équivalent néerlandais"}]} ; sinon null.
- ${talk.point ? `FIN : quand tu connais son plafond (ou qu'il a montré le niveau B2), au plus tard vers 25 échanges (il en a fait ${talk.userCount}), annonce gentiment que tu vas faire le point : "reply_nl" sans question et "fin": true ; sinon "fin": false.` : `FIN NATURELLE (l'apprenant a déjà fait ${talk.userCount} échange${talk.userCount > 1 ? 's' : ''}${talk.extra ? `, dont ${talk.userCount - talk.extra} depuis qu'il a voulu continuer` : ''}) : une vraie conversation a une fin. ${talk.sit ? `Ici, la situation se termine quand elle est réglée (achat fait, rendez-vous fixé, problème résolu…) : conclus alors poliment, comme dans la vraie vie.` : `Avant ${8 + (talk.extra || 0)} échanges, fais vivre la conversation. Vers ${10 + (talk.extra || 0)} à ${12 + (talk.extra || 0)}, cherche une sortie naturelle (tu dois y aller, ton train, un rendez-vous…). Au plus tard à ${16 + (talk.extra || 0)}, conclus.`} Si la conversation tourne en rond, relance UNE fois sur un autre sujet ; si ça ne prend pas, conclus. S'il dit au revoir (« ik moet gaan », « tot later »…), dis-lui au revoir chaleureusement au lieu de relancer. Quand tu conclus : "reply_nl" = une réplique de fin, SANS question, et "fin": true ; sinon "fin": false.`}
- "suggestions" : 3 réponses courtes QU'IL pourrait te dire maintenant, à son niveau et variées (répondre, donner une raison ou un détail, te poser une question en retour), avec leur traduction.
${hist ? "Conversation jusqu'ici :\n" + hist : (talk.sit ? `Commence la situation par cette réplique, telle quelle ou presque : « ${talk.sit.welcome} »` : "Commence la conversation : salue-le naturellement et pose une première question simple sur le sujet.")}
Réponds UNIQUEMENT en JSON : {"reply_nl": "", "reply_fr": "traduction française de reply_nl", "fr_help": "", "correction": null, "suggestions": [{"nl": "", "fr": ""}], "fin": false}`;
        }

        function talkThinking(on) {
            talk.busy = on;
            const old = document.getElementById('talk-typing');
            if (old) old.remove();
            const chat = document.getElementById('talk-chat');
            if (on && chat) {
                const d = document.createElement('div');
                d.id = 'talk-typing';
                d.className = 'talk-msg them typing';
                d.innerHTML = '<span></span><span></span><span></span>';
                chat.appendChild(d);
                chat.scrollTop = chat.scrollHeight;
            }
        }

        async function talkTurn(lastMsg, lastDiv) {
            talkThinking(true);
            let r = null;
            try { r = rpHelpParseJson(await GeminiService.generate(talkPrompt())); } catch (e) { r = { error: e.message }; }
            if (talk && !talk.ended && (!r || r.error || !r.reply_nl)) {
                try { r = rpHelpParseJson(await GeminiService.generate(talkPrompt())); } catch (e) { r = { error: e.message }; }
            }
            if (!talk || talk.ended) return;
            talkThinking(false);
            if (!r || r.error || !r.reply_nl) {
                talkAppend({ who: 'info', html: `⚠️ Pas de réponse (${rpEscapeHtml((r && r.error) || 'réponse illisible')}). <button class="rp-coach-btn" onclick="talkTurn()">Réessayer</button>${talk.point && talk.userCount ? ' <button class="rp-coach-btn" onclick="talkEnd()">🏁 Terminer et faire le point</button>' : ''}` });
                return;
            }
            if (lastMsg && liveCorrectOn() && r.correction && ((r.correction.natural && normalize(r.correction.natural) !== normalize(lastMsg.text)) || r.correction.a_cote)) {
                r.correction.francais = (Array.isArray(r.correction.francais) ? r.correction.francais : []).filter(x => x && x.fr && x.nl);
                if (r.correction.francais.length) liveSaveWords(r.correction.francais);
                lastMsg.corr = r.correction;
                if (lastDiv) lastDiv.insertAdjacentHTML('beforeend', talkCorrHtml(r.correction));
            }
            if (lastMsg) { const ids = usedWordsRecord(lastMsg.text, r.correction && r.correction.natural ? r.correction : null); if (talk.point && Array.isArray(ids)) ids.forEach(id => talk.point.words.add(id)); }
            talk.history.push({ who: 'them', nl: r.reply_nl });
            talk.suggestions = (Array.isArray(r.suggestions) ? r.suggestions : []).filter(s => s && s.nl).slice(0, 3);
            talkAppend({ who: 'them', nl: r.reply_nl, fr: r.reply_fr || '', help: r.fr_help || '' });
            talkRenderSugg();
            if (!talkActive()) return;
            if (r.fr_help) await conjAudioSpeakMixed(r.fr_help, 1, PROF_RATE[talk.level], talkActive);
            if (talkActive()) await conjAudioSpeak(r.reply_nl, 'nl', PROF_RATE[talk.level], { speaker: talk.p.speaker });
            // Le partenaire a conclu : le récap s'enchaîne tout seul (on peut encore continuer).
            if (r.fin === true && talk.userCount > 0 && talkActive()) { talkEnd(); return; }
            if (talkActive() && talk.handsfree && window.SpeechRecognition && !talkRec) talkMic('nl');
        }

        function talkSubmit(text, isFr) {
            if (!talk || talk.ended || talk.busy) return;
            const msg = { who: 'me', text, isFr };
            const div = talkAppend(msg);
            talk.history.push({ who: 'me', text, isFr });
            document.getElementById('talk-mic-hint').innerText = 'Touche le micro pour parler';
            if (!isFr) {
                talk.userCount++;
                const d = talkState().days;
                d[talkToday()] = (d[talkToday()] || 0) + 1;
                save();
                const ring = document.getElementById('talk-ring-small');
                if (ring) ring.innerHTML = talkRingHtml(34);
                if (talkTodayCount() === TALK_GOAL) talkAppend({ who: 'info', html: `🎉 Objectif du jour atteint : ${TALK_GOAL} échanges !` });
            }
            talkTurn(isFr ? null : msg, div);
        }

        function talkSendTyped() {
            const input = document.getElementById('talk-input');
            const text = input ? input.value.trim() : '';
            if (!text) return;
            input.value = '';
            talkSubmit(text, /(\bcomment\b|\bpourquoi\b|est-ce|c'est|qu'est|veut dire|\bje ne\b|\bon dit\b|ça|\bquoi\b|\bque\b|\bles\b)/i.test(text));
        }

        function talkMicState(lang, cd, hold) {
            const mic = document.getElementById('talk-mic'), fr = document.getElementById('talk-fr'), hint = document.getElementById('talk-mic-hint');
            if (mic) mic.classList.toggle('listening', lang === 'nl');
            if (fr) fr.classList.toggle('listening', lang === 'fr');
            if (hint && lang) hint.innerText = cd ? `Envoi dans ${cd}… (touche le micro pour envoyer)` : (lang === 'fr' ? 'J\'écoute en français…' : (hold ? 'J\'écoute… touche le micro pour envoyer' : 'J\'écoute… (touche le micro pour envoyer)'));
            if (hint && !lang && hint.innerText.startsWith('J\'écoute')) hint.innerText = 'Touche le micro pour parler';
        }

        function talkMic(lang) {
            if (!talk || talk.ended) return;
            if (talkRec) { talkRec.finish(true); return; }
            if (!window.SpeechRecognition) { talkToggleText(true); alert("La reconnaissance vocale n'est pas disponible dans ce navigateur : écris ta réponse (⌨️), ou utilise Chrome."); return; }
            if (talk.busy) return;
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            talkToggleText(true);
            talkRec = longListen({
                lang, input: document.getElementById('talk-input'), silence: profSettings().silence,
                isActive: talkActive,
                onState: (st, cd) => talkMicState(lang, cd, st.hold),
                onEnd: st => { if (talkRec === st) talkRec = null; talkMicState(null); },
                onSubmit: text => talkSubmit(text, lang === 'fr')
            });
        }

        function talkStop() {
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            if (talkRec) { const r = talkRec; talkRec = null; r.finish(false); }
        }

        // Fin : mise à jour de la mémoire du partenaire + 3 mots et une tournure à garder.
        async function talkEnd() {
            if (!talk || talk.ended) return;
            talkStop();
            const t = talk;
            t.ended = true;
            if (!t.userCount) { talk = null; talkRenderSetup(); return; }
            if (t.point && !t.point.done) { t.point.done = true; await talkPointEvaluate(t); }
            const box = document.getElementById('talk-chat');
            talkAppend({ who: 'info', html: '<div class="report-meta" id="talk-recap-wait">Petit récap…</div>' });
            const mem = talkState().memory[t.partner] || '';
            const hist = t.history.map(h => h.who === 'them' ? t.p.name + ' : ' + h.nl : 'Apprenant : ' + h.text).join('\n');
            let r = null;
            try {
                r = rpHelpParseJson(await GeminiService.generate(`Voici une conversation en néerlandais entre ${t.p.name} et un apprenant francophone (niveau ${t.level}).
${hist}
Mémoire actuelle de ${t.p.name} sur l'apprenant : ${mem || '(vide)'}
Produis en JSON :
- "memoire" : la mémoire mise à jour, en français, 5 phrases maximum : ce que l'apprenant a raconté de lui (faits, projets, goûts) et les sujets déjà abordés, pour que ${t.p.name} puisse y revenir la prochaine fois ;
- "mots" : 3 mots ou tournures néerlandais utiles apparus ou qui lui ont manqué, avec de/het pour les noms, et leur traduction ;
- "tournure" : une phrase néerlandaise utile à retenir de cette conversation, avec sa traduction.
Réponds UNIQUEMENT en JSON : {"memoire": "", "mots": [{"nl": "", "fr": ""}], "tournure": {"nl": "", "fr": ""}}`));
            } catch (e) { r = null; }
            const wait = document.getElementById('talk-recap-wait');
            if (wait) wait.parentElement.remove();
            if (r && r.memoire) { talkState().memory[t.partner] = String(r.memoire).slice(0, 900); save(); }
            const mots = r && Array.isArray(r.mots) ? r.mots.filter(m => m && m.nl) : [];
            const added = mots.length ? talkAddWords(mots) : 0;
            if (box) talkAppend({ who: 'info', html: `<div class="prof-debrief">
                <div class="prof-target-title">👋 Fin de la conversation · ${t.userCount} échange${t.userCount > 1 ? 's' : ''}</div>
                ${mots.length ? `<div class="prof-deb-sec">📖 À garder${added ? ' (ajoutés à « 💬 Mes discussions »)' : ''}</div><ul>${mots.map(m => `<li><b>${rpEscapeHtml(m.nl)}</b> ${speakBtnHtml(m.nl)} = ${rpEscapeHtml(m.fr || '')}</li>`).join('')}</ul>` : ''}
                ${r && r.tournure && r.tournure.nl ? `<div class="prof-deb-sec">💬 Tournure du jour</div><p><b>${rpEscapeHtml(r.tournure.nl)}</b> ${speakBtnHtml(r.tournure.nl)}<br><small>${rpEscapeHtml(r.tournure.fr || '')}</small></p>` : ''}
                ${usedSessionHtml()}
                <div class="prof-actions"><button class="btn btn-green" onclick="tutorOpen('talk')">🧑‍🏫 Revoir avec mon tuteur</button><button class="btn btn-gray" onclick="talk = null; talkRenderSetup();">💬 Nouvelle conversation</button><button class="btn btn-gray" onclick="talkResume()">🔁 On continue encore un peu</button></div>
            </div>` });
            const bar = document.querySelector('#talk-content .talk-bar');
            if (bar) bar.style.display = 'none';
            const sugg = document.getElementById('talk-sugg');
            if (sugg) sugg.innerHTML = '';
        }

        // Reprendre après la fin : les repères de fin repartent de là où on en est (talk.extra).
        function talkResume() {
            const t = talk;
            if (!t || !t.ended) return;
            t.ended = false;
            t.extra = t.userCount;
            const bar = document.querySelector('#talk-content .talk-bar');
            if (bar) bar.style.display = '';
            talkAppend({ who: 'info', html: `🔁 On continue ! Réponds à ${rpEscapeHtml(t.p.name)} quand tu veux.` });
            if (t.handsfree && window.SpeechRecognition && !talkRec) talkMic('nl');
        }

        const TALK_WORDS_LIST = '💬 Mes discussions';
        function talkAddWords(mots) {
            if (!state.customLists[TALK_WORDS_LIST]) state.customLists[TALK_WORDS_LIST] = [];
            const ids = state.customLists[TALK_WORDS_LIST];
            let n = 0;
            mots.forEach(m => {
                if (!m.fr) return;
                const base = String(m.nl).trim();
                const existing = rpWordLookup(base.replace(/^(de|het|een) /i, ''));
                let id = existing && existing.id;
                if (!id) {
                    const k = rpKitNorm(base);
                    if (!k) return;
                    if (!state.rpWords) state.rpWords = {};
                    if (!state.rpWords[k]) state.rpWords[k] = { nl: base, fr: m.fr, at: Date.now() };
                    rpWordsInject();
                    id = 'RPW:' + k;
                }
                if (!ids.includes(id)) { ids.push(id); n++; }
            });
            save();
            renderCustomListsHome();
            return n;
        }

        // ===== Rejouer un vrai entretien tel quel =====
        // Les répliques des recruteurs sont dites EXACTEMENT comme dans la transcription
        // (scripted_dialogues.json, nl_original), à leur débit réel (wpm du scénario : l'app mesure
        // le débit de la voix et ajuste la vitesse pour s'en approcher). Après chaque réplique, une
        // idée de réponse en français (suggestion_fr) ; l'apprenant répond ce qu'il veut, à l'oral.
        // Le recruteur réagit et relance (Gemini, réglage replay.react, voir rpReplayReactPrompt) ;
        // les questions du script, elles, ne passent jamais par Gemini. Correcteur séparé.
        const REPLAY_SPEEDS = { lent: { label: '🐢 Plus lent', f: 0.8 }, reel: { label: '🎯 Vitesse réelle', f: 1 }, rapide: { label: '🐇 Plus rapide', f: 1.2 } };
        const REPLAY_VOICES = [{ speaker: 0 }, { speaker: 1 }, { speaker: 0, pitch: 1.25 }, { speaker: 1, pitch: 0.8 }];
        let rpReplay = null;
        let rpReplayRec = null;

        function replaySettings() {
            const s = state.settings.replay || {};
            state.settings.replay = {
                speed: REPLAY_SPEEDS[s.speed] ? s.speed : 'reel',
                handsfree: s.handsfree !== false,
                showSugg: s.showSugg !== false,
                react: s.react !== false,
                rate: typeof s.rate === 'number' && s.rate > 0.4 && s.rate < 2 ? s.rate : 1
            };
            return state.settings.replay;
        }

        function replayActive() { return !!(rpReplay && !rpReplay.ended && document.getElementById('replay-view').classList.contains('active')); }

        async function rpShowReplayList() {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('replay-view').classList.add('active');
            setActiveNav('nav-pratiquer');
            const box = document.getElementById('replay-content');
            box.innerHTML = '<p class="report-meta">Chargement…</p>';
            const { dialogues } = await rpLoadRealData();
            const list = dialogues.map((d, i) => ({ d, i })).filter(x => (x.d.turns || []).length);
            box.innerHTML = `
                <h2 style="margin-bottom:4px;">🎬 Rejouer un vrai entretien</h2>
                <p class="section-subtitle" style="margin-top:0;">Les vraies questions des recruteurs, mot pour mot et à leur vitesse. Tu réponds ce que tu veux : le recruteur réagit, relance comme s'il avait ton CV sous les yeux, et une idée de réponse t'aide si tu bloques.</p>
                ${list.map(x => `<button class="rp-scenario-btn" onclick="rpReplaySetup(${x.i})">${rpEscapeHtml(x.d.label)} <small style="color:var(--text-secondary);">· ${x.d.turns.length} répliques${x.d.turns.some(t => t.suggestion_fr) ? '' : ' · sans idées de réponse'}</small></button>`).join('')}`;
        }

        function rpReplaySetup(index) {
            const d = rpRealData.dialogues[index];
            const s = replaySettings();
            const chip = (on, click, label) => `<button type="button" class="conj-filter-chip${on ? ' active' : ''}" onclick="${click}">${label}</button>`;
            const set = (k, v) => `replaySettings()['${k}']=${JSON.stringify(v).replace(/"/g, "'")}; save(); rpReplaySetup(${index})`;
            document.getElementById('replay-content').innerHTML = `
                <button class="back-btn" onclick="rpShowReplayList()">← Entretiens réels</button>
                <h2 style="margin-bottom:4px;">${rpEscapeHtml(d.label)}</h2>
                ${d.contexte ? `<p class="section-subtitle" style="margin-top:0;">${rpEscapeHtml(d.contexte)}</p>` : ''}
                <div class="conj-card conj-audio">
                    <div class="conj-audio-label">Vitesse${d.wpm ? ` (réelle : environ ${d.wpm} mots par minute)` : ''}</div>
                    <div class="conj-audio-chips">${Object.entries(REPLAY_SPEEDS).map(([k, v]) => chip(s.speed === k, set('speed', k), v.label)).join('')}</div>
                    <div class="conj-audio-label">Le recruteur</div>
                    <div class="conj-audio-chips">${chip(s.react, set('react', true), '🎙️ Réagit à mes réponses')}${chip(!s.react, set('react', false), '📜 Script pur')}</div>
                    <div class="conj-audio-label">Idées de réponse en français</div>
                    <div class="conj-audio-chips">${chip(s.showSugg, set('showSugg', true), '👀 Affichées')}${chip(!s.showSugg, set('showSugg', false), '🙈 Sur demande')}</div>
                    <div class="conj-audio-label">Micro</div>
                    <div class="conj-audio-chips">${chip(s.handsfree, set('handsfree', true), '🗣️ Mains libres')}${chip(!s.handsfree, set('handsfree', false), '👆 Je touche le micro')}</div>
                    <button class="btn btn-green" style="margin-top:10px;" onclick="rpReplayStart(${index})">▶️ Commencer</button>
                </div>`;
        }

        function rpReplayStart(index) {
            const d = rpRealData.dialogues[index];
            const s = replaySettings();
            const speakers = [...new Set(d.turns.map(t => t.speaker || 'Le recruteur'))];
            rpReplay = { index, d, i: 0, answers: [], ended: false, busy: false, token: Date.now(), speakers, pending: null, skip: new Set(), log: [],
                target: (d.wpm || 135) * REPLAY_SPEEDS[s.speed].f };
            document.getElementById('replay-content').innerHTML = `
                <div class="talk-head">
                    <div class="talk-head-txt"><b>${rpEscapeHtml(d.label)}</b><small id="replay-progress"></small></div>
                    <button type="button" class="rp-coach-btn" onclick="rpReplayEnd()">Terminer</button>
                </div>
                <div id="replay-chat" class="talk-chat"></div>
                <div id="replay-sugg"></div>
                <div class="prof-input-row">
                    <input type="text" id="replay-input" placeholder="Ta réponse, comme tu veux…" onkeydown="if(event.key==='Enter') rpReplaySendTyped()">
                    <button type="button" class="btn btn-green prof-send" onclick="rpReplaySendTyped()">➤</button>
                </div>
                <div class="talk-bar">
                    <button type="button" class="talk-side" onclick="rpReplaySay()" title="Réécouter">🔁</button>
                    <button type="button" class="talk-mic" id="replay-mic" onclick="rpReplayMic()">🎤</button>
                    <button type="button" class="talk-side" onclick="rpReplaySkip()" title="Passer">⏭</button>
                </div>
                <div id="replay-mic-hint" class="talk-mic-hint">Écoute la question, puis réponds.</div>
                <div class="lc-row">${liveCorrectToggleHtml()}</div>`;
            rpReplayAsk();
        }

        function rpReplayBubble(cls, html) {
            const chat = document.getElementById('replay-chat');
            if (!chat) return null;
            const div = document.createElement('div');
            div.className = 'talk-msg ' + cls;
            div.innerHTML = html;
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            return div;
        }

        // Lit une réplique et ajuste la vitesse de la voix pour viser le débit réel du recruteur.
        async function rpReplaySpeak(text, speakerName) {
            const r = rpReplay, s = replaySettings();
            const voice = REPLAY_VOICES[Math.max(0, r.speakers.indexOf(speakerName)) % REPLAY_VOICES.length];
            const words = (text.match(/[A-Za-zÀ-ÿ']+/g) || []).length;
            const t0 = Date.now(), token = r.token;
            await conjAudioSpeak(text, 'nl', s.rate, voice);
            const dt = (Date.now() - t0) / 1000;
            // Mesure seulement sur une lecture complète (pas interrompue par une réponse, un saut
            // ou un arrêt, ni terminée par le délai de secours).
            if (rpReplay === r && r.token === token && !r.ended && words >= 6 && dt > 1.2 && dt < 2.5 + text.length * 0.18 / s.rate - 0.5) {
                const wpm = words / dt * 60;
                const ideal = s.rate * r.target / wpm;
                s.rate = Math.max(0.6, Math.min(1.8, s.rate * 0.5 + ideal * 0.5));
                save();
            }
        }

        async function rpReplayAsk() {
            const r = rpReplay;
            if (!r || r.ended) return;
            const t = r.d.turns[r.i];
            if (!t) { rpReplayEnd(); return; }
            const s = replaySettings();
            const prog = document.getElementById('replay-progress');
            if (prog) prog.innerText = `Réplique ${r.i + 1} / ${r.d.turns.length}`;
            const words = rpAnnotateText(t.nl_original).replace(/rpWordTap\(this\)/g, 'talkWordTap(this)');
            rpReplayBubble('them', `<div class="replay-who">${rpEscapeHtml(t.speaker || 'Le recruteur')}</div><div class="talk-nl">${words}</div>
                <div class="talk-tools"><button type="button" onclick="this.closest('.talk-msg').querySelector('.talk-fr').classList.toggle('show')">🇫🇷</button></div>
                <div class="talk-fr">${rpEscapeHtml(t.fr_cue || '')}</div><div class="talk-word"></div>`);
            // Idée de réponse : la piste rédigée + ce qui avait été répondu dans le vrai entretien.
            r.idea = (t.suggestion_fr ? `💡 ${rpEscapeHtml(t.suggestion_fr)}` : '') +
                (t.candidate_reply ? `<div class="replay-real">🗣️ Ta vraie réponse : « ${rpEscapeHtml(t.candidate_reply)} » ${speakBtnHtml(t.candidate_reply)}</div>` : '');
            rpReplayRenderIdea();
            const token = r.token;
            await rpReplaySpeak(t.nl_original, t.speaker || 'Le recruteur');
            if (!replayActive() || rpReplay.token !== token || rpReplay.i !== r.i) return;
            if (s.handsfree && window.SpeechRecognition && !rpReplayRec) rpReplayMic();
        }

        function rpReplayRenderIdea(force) {
            const el = document.getElementById('replay-sugg');
            const r = rpReplay;
            if (!el || !r) return;
            el.innerHTML = !r.idea ? '' : (replaySettings().showSugg || force ? `<div class="replay-idea">${r.idea}</div>` : `<button type="button" class="rp-coach-btn" onclick="rpReplayShowIdea()">💡 Idée de réponse</button>`);
        }
        function rpReplayShowIdea() { rpReplayRenderIdea(true); }

        function rpReplaySay() {
            const r = rpReplay;
            if (!r || r.ended) return;
            const t = r.d.turns[r.i];
            if (r.pending) rpReplaySpeak(r.pending.q, r.pending.speaker);
            else if (t) rpReplaySpeak(t.nl_original, t.speaker || 'Le recruteur');
        }

        // ----- Le recruteur réagit (Gemini, appel séparé du correcteur) -----
        // Les questions du script restent lues mot pour mot ; entre deux, le recruteur réagit à la
        // réponse, relance au besoin (réponse courte ou floue, ou point du dossier non mentionné,
        // comme s'il avait le CV sous les yeux) et saute les questions déjà couvertes. Le dossier =
        // le profil privé du candidat + ses vraies réponses dans l'entretien d'origine.
        function rpReplayDossier(d) {
            const profile = (state.candidateProfile || '').trim();
            const real = d.turns.filter(t => t.candidate_reply).map(t => `- « ${t.nl_original.slice(0, 140)} » → « ${t.candidate_reply} »`).join('\n');
            return (profile ? `Profil (CV) du candidat :\n${profile.slice(0, 2500)}\n\n` : '') +
                (real ? `Ce qu'il a répondu lors du vrai entretien (sa situation réelle, que tu connais comme si c'était sur son CV) :\n${real}` : '');
        }

        function rpReplayReactPrompt(r, q, speaker, text, wasRelance) {
            const d = r.d, lang = RP_LANG_NAMES[d.lang || 'nl'] || 'néerlandais';
            const next = [];
            for (let k = r.i + 1; k < d.turns.length - 1 && next.length < 4; k++) if (!r.skip.has(k)) next.push(`${k}: ${d.turns[k].nl_original.slice(0, 160)}`);
            return `Tu joues les recruteurs d'un VRAI entretien d'embauche, rejoué par le candidat pour s'entraîner. ${d.contexte || ''}
Interlocuteurs : ${r.speakers.join(', ')}.
Les questions viennent de la transcription du vrai entretien et l'application les lit telles quelles. Toi, tu ajoutes seulement ce qu'un vrai recruteur dirait ENTRE deux questions, en réagissant à ce que le candidat vient de répondre.

${rpReplayDossier(d)}

Échanges de cette séance :
${r.log.slice(-10).join('\n') || '(début)'}

Question posée (par ${speaker}) : « ${q} »
Réponse du candidat : « ${text} »
${wasRelance ? "C'était déjà ta question de relance : réagis brièvement, SANS nouvelle relance." : ''}
Questions suivantes du script (numéro: question) :
${next.join('\n') || '(aucune)'}

Consignes :
- "reaction" : réaction courte et naturelle en ${lang} (Flandre), par ${speaker}, dans le ton de l'entretien (même tutoiement ou vouvoiement que les questions). Montre que tu as écouté en reprenant un détail de SA réponse. Varie : pas de compliment systématique ; parfois « Oké. » ou « Ah ja, ik zie het. » suffit. Ne corrige jamais sa langue. Le candidat peut avoir glissé des mots français : comprends-les.
- Si sa réponse est À CÔTÉ de la question (il l'a sans doute mal comprise), ne fais pas comme si de rien n'était : "reaction" vide ou très courte, et "relance" = la même question reformulée plus simplement, comme un vrai recruteur (« Ik bedoel eigenlijk… »).
- "relance" : une question de suivi en ${lang}, SEULEMENT si sa réponse est très courte, floue ou hors sujet, OU si son dossier contient un élément important lié à cette question qu'il n'a pas mentionné (demande-le comme un recruteur qui a son CV sous les yeux, par ex. « Ik zie dat je hier al in de productie gewerkt hebt, hoe was dat? »). Sinon "". Environ une fois sur trois au plus. Jamais sur un point qu'une des questions suivantes va aborder.
- "idee_fr" : si tu relances, une idée de réponse pour le candidat, en français, tirée de son dossier (1 ou 2 phrases). Sinon "".
- "sauter" : numéros des questions suivantes auxquelles il a DÉJÀ clairement répondu (souvent []).
Réponds UNIQUEMENT en JSON : {"reaction": "", "reaction_fr": "", "relance": "", "relance_fr": "", "idee_fr": "", "sauter": []}`;
        }

        function rpReplayMicState(on, cd, hold) {
            const mic = document.getElementById('replay-mic'), hint = document.getElementById('replay-mic-hint');
            if (mic) mic.classList.toggle('listening', !!on);
            if (hint) hint.innerText = on ? (cd ? `Envoi dans ${cd}… (touche le micro pour envoyer)` : (hold ? 'J\'écoute… touche le micro pour envoyer' : 'J\'écoute… (touche le micro pour envoyer)')) : 'Écoute la question, puis réponds.';
        }

        function rpReplayMic() {
            if (!rpReplay || rpReplay.ended) return;
            if (rpReplayRec) { rpReplayRec.finish(true); return; }
            if (!window.SpeechRecognition) { alert("La reconnaissance vocale n'est pas disponible ici : écris ta réponse, ou utilise Chrome."); return; }
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            rpReplayRec = longListen({
                lang: 'nl', input: document.getElementById('replay-input'), silence: profSettings().silence,
                isActive: replayActive,
                onState: (st, cd) => rpReplayMicState(true, cd, st.hold),
                onEnd: st => { if (rpReplayRec === st) rpReplayRec = null; rpReplayMicState(false); },
                onSubmit: text => rpReplayAnswer(text)
            });
        }

        function rpReplaySendTyped() {
            const input = document.getElementById('replay-input');
            const text = input ? input.value.trim() : '';
            if (!text) return;
            input.value = '';
            rpReplayAnswer(text);
        }

        function rpReplayStopListen() {
            if (rpReplayRec) { const st = rpReplayRec; rpReplayRec = null; st.finish(false); }
        }

        async function rpReplayAnswer(text) {
            const r = rpReplay;
            if (!r || r.ended || r.busy) return;
            const t = r.d.turns[r.i];
            if (!t) return;
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            const token = r.token = Date.now();
            const speaker = r.pending ? r.pending.speaker : (t.speaker || 'Le recruteur');
            const q = r.pending ? r.pending.q : t.nl_original;
            const wasRelance = !!r.pending;
            r.pending = null;
            const div = rpReplayBubble('me', rpEscapeHtml(text));
            const a = { q, text, corr: null };
            r.answers.push(a);
            rpReplayCorrect(a, div);
            r.log.push(`${speaker} : ${q}`, `Candidat : ${text}`);
            document.getElementById('replay-sugg').innerHTML = '';
            if (replaySettings().react && GeminiService.isAvailable()) {
                r.busy = true;
                const wait = rpReplayBubble('them typing', '<span></span><span></span><span></span>');
                let res = null;
                try { res = rpHelpParseJson(await GeminiService.generate(rpReplayReactPrompt(r, q, speaker, text, wasRelance))); } catch (e) { res = null; }
                if (wait) wait.remove();
                r.busy = false;
                if (!replayActive() || rpReplay !== r || r.token !== token) return;
                if (res && !res.error) {
                    const relance = !wasRelance && res.relance ? String(res.relance).trim() : '';
                    const say = [res.reaction, relance].map(x => String(x || '').trim()).filter(Boolean).join(' ');
                    (Array.isArray(res.sauter) ? res.sauter : []).map(Number).filter(n => n > r.i && n < r.d.turns.length - 1).forEach(n => r.skip.add(n));
                    if (say) {
                        const fr = [res.reaction_fr, relance ? res.relance_fr : ''].filter(Boolean).join(' ');
                        rpReplayBubble('them', `<div class="replay-who">${rpEscapeHtml(speaker)}</div><div class="talk-nl">${rpAnnotateText(say).replace(/rpWordTap\(this\)/g, 'talkWordTap(this)')}</div>
                            <div class="talk-tools"><button type="button" onclick="this.closest('.talk-msg').querySelector('.talk-fr').classList.toggle('show')">🇫🇷</button></div>
                            <div class="talk-fr">${rpEscapeHtml(fr)}</div><div class="talk-word"></div>`);
                        r.log.push(`${speaker} : ${say}`);
                        if (relance) {
                            r.pending = { q: relance, speaker };
                            r.idea = res.idee_fr ? `💡 ${rpEscapeHtml(res.idee_fr)}` : '';
                            rpReplayRenderIdea();
                        }
                        await rpReplaySpeak(say, speaker);
                        if (!replayActive() || rpReplay !== r || r.token !== token) return;
                        if (relance) {
                            if (replaySettings().handsfree && window.SpeechRecognition && !rpReplayRec) rpReplayMic();
                            return;
                        }
                    }
                }
            }
            rpReplayNext(r);
        }

        // Question suivante du script, en sautant celles auxquelles il a déjà répondu.
        function rpReplayNext(r) {
            r.i++;
            while (r.skip.has(r.i)) r.i++;
            document.getElementById('replay-sugg').innerHTML = '';
            setTimeout(() => { if (replayActive() && rpReplay === r) rpReplayAsk(); }, 500);
        }

        function rpReplaySkip() {
            const r = rpReplay;
            if (!r || r.ended) return;
            rpReplayStopListen();
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            r.token = Date.now();
            r.busy = false;
            const typing = document.querySelector('#replay-chat .typing');
            if (typing) typing.remove();
            if (r.pending) { r.pending = null; rpReplayNext(r); return; }
            r.i++;
            while (r.skip.has(r.i)) r.i++;
            document.getElementById('replay-sugg').innerHTML = '';
            rpReplayAsk();
        }

        // Correcteur séparé : il ne voit que la phrase de l'apprenant.
        async function rpReplayCorrect(a, div) {
            const c = await liveCorrectUnder(div, a.text, 'B1', a.q);
            usedWordsRecord(a.text, c);
            if (!c || !c.corrige || ((c.ok || normalize(c.corrige) === normalize(a.text)) && !c.francais.length && !c.a_cote)) return;
            if (c.a_cote && c.piste_nl) { a.corr = { corrige: c.piste_nl, explication: '❓ Réponse à côté : ' + (c.comprehension_fr || c.question_fr || '') }; return; }
            a.corr = { corrige: c.corrige, explication: c.erreurs.map(e => e.pourquoi).filter(Boolean).concat(c.francais.map(f => f.fr + ' → ' + f.nl)).join(' ; ') };
        }

        function rpReplayEnd() {
            const r = rpReplay;
            if (!r || r.ended) return;
            r.ended = true;
            rpReplayStopListen();
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            const corr = r.answers.filter(x => x.corr);
            document.getElementById('replay-sugg').innerHTML = '';
            const bar = document.querySelector('#replay-content .talk-bar');
            if (bar) bar.style.display = 'none';
            rpReplayBubble('info', `<div class="prof-debrief">
                <div class="prof-target-title">🏁 ${r.answers.length} réponse${r.answers.length > 1 ? 's' : ''} sur ${r.d.turns.length} répliques</div>
                ${corr.length ? `<div class="prof-deb-sec">✍️ À retenir</div><ul>${corr.map(x => `<li>« ${rpEscapeHtml(x.text)} »<br><b>${rpEscapeHtml(x.corr.corrige)}</b> ${speakBtnHtml(x.corr.corrige)}<br><small>${rpEscapeHtml(x.corr.explication || '')}</small></li>`).join('')}</ul>` : '<p class="report-meta">Aucune faute relevée' + (GeminiService.isAvailable() ? '.' : ' (corrections indisponibles sans clé Gemini).') + '</p>'}
                ${usedSessionHtml()}
                <div class="prof-actions">
                    <button class="btn btn-green" onclick="tutorOpen('replay')">🧑‍🏫 Revoir avec mon tuteur</button>
                    <button class="btn btn-gray" onclick="rpReplaySetup(${r.index})">🔁 Recommencer</button>
                    <button class="btn btn-gray" onclick="rpShowReplayList()">← Entretiens réels</button>
                </div>
            </div>`);
        }

        function rpReplayStop() {
            if (rpReplay) rpReplay.ended = true;
            rpReplayStopListen();
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        }

        // ===== Faire le point en conversation (placement) =====
        // Au lieu de refaire les cours notion après notion, Svetlana ou John (les profs) font
        // parler l'apprenant, du plus simple (se présenter, épeler, son numéro) au plus difficile
        // (argumenter, hypothèses), en sautant ce qu'il montre déjà. S'il bloque, il le dit en
        // français : le prof lui montre comment le dire et l'invite à essayer. Moteur : Discuter
        // (talk.point), donc mêmes aides, correction et fin naturelle. À la fin, ce qu'il a montré
        // est certifié : modules A1/A2 validés (contrôles d'examen de l'app + avis d'un
        // examinateur Gemini séparé, talkPointJudgePrompt), notions B1/B2 acquises, mots bien
        // employés pendant la séance comptés actifs d'office, portrait rempli, niveau du cours
        // particulier et de Discuter réglé. Résultat gardé dans state.coursPoint.
        async function talkStartPoint(partner) {
            await rpLoadLibrary();
            if (typeof modRpLoadAll === 'function') await modRpLoadAll();
            const s = talkSettings();
            if (TALK_PARTNERS[partner]) s.partner = partner;
            s.mode = 'libre';
            save();
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('talk-view').classList.add('active');
            setActiveNav('nav-apprendre');
            if (!GeminiService.isAvailable()) { talkRenderSetup(); alert("Il faut une clé Gemini : Profil 👤 → 🤖 Intelligence IA."); return; }
            talk = { partner: s.partner, p: TALK_PARTNERS[s.partner], sit: null, topic: 'libre', level: s.level, handsfree: s.handsfree, history: [], log: [], suggestions: [], busy: false, ended: false, userCount: 0,
                point: { words: new Set() } };
            talkRenderChat();
            talkAppend({ who: 'info', html: `<div class="talk-sit-card"><b>🧑‍🏫 On fait connaissance</b><div>${rpEscapeHtml(talk.p.name)} va te faire parler, du plus simple au plus difficile, pour voir ce que tu sais déjà. Réponds en néerlandais ; si tu bloques, dis-le en français (🇫🇷) : on te montre comment le dire. Ce que tu montres sera validé, sans refaire les cours.</div></div>` });
            talkTurn();
        }

        function talkPointPrompt() {
            return `Aujourd'hui, tu es SON PROF de néerlandais (tu restes ${talk.p.name}) et vous faites connaissance : une séance pour découvrir ce qu'il sait déjà, sous forme de VRAIE conversation chaleureuse, pas d'interrogatoire. Tutoiement (jij).
Fais-le parler, UNE chose à la fois, du plus simple au plus difficile, en sautant ce qu'il montre déjà :
- A1 : se présenter (prénom, âge, d'où il vient, où il habite), épeler son prénom, donner son numéro de téléphone (il peut l'inventer), sa famille, son travail ou ses études, les langues qu'il parle, ses loisirs, l'heure, un prix.
- A2 : sa journée type, son logement, ce qu'il a fait le week-end dernier (passé composé), ses déplacements, ses courses.
- B1 : son parcours (imparfait), ses projets (zullen, gaan), son avis justifié (omdat, want, daarom), un problème qu'il a réglé.
- B2 : nuancer, argumenter pour et contre, faire des hypothèses (als ik … zou …), un sujet de société.
Adapte-toi : parle simplement au début, puis à son niveau. Si ses réponses sont aisées, monte vite (une ou deux questions suffisent par niveau). S'il bloque deux fois de suite à un niveau, reste à ce niveau et conclus.
S'il répond EN FRANÇAIS ou dit qu'il ne sait pas le dire : dans "fr_help", montre-lui la phrase néerlandaise qui convient, et dans "reply_nl" invite-le gentiment à la dire à son tour. Ce qui compte, c'est ce qu'il dit lui-même.`;
        }

        function talkPointJudgePrompt(t, checks) {
            const mods = MODRP_IDS.map(id => modRpData[id]).filter(Boolean);
            const modLines = mods.map(m => `- ${m.id} — ${m.niveau} — ${m.titre} — compétences : ${((m.examen && m.examen.sujets) || []).map(x => x.label).join(', ')} (l'app a repéré ${checks[m.id].covered}/${checks[m.id].checks.length} de ces sujets)`).join('\n');
            const notions = Object.entries(curriculumNotions).filter(([, n]) => n.level === 'B1' || n.level === 'B2').map(([id, n]) => `- ${id} — ${n.level} — ${(n.content && n.content.titre) || id}`).join('\n');
            const pq = Object.values(GUIDE_PORTRAIT_Q).flat().map(q => `${q.key} (${q.fr}${q.options ? ' ; valeurs : ' + q.options.map(o => o[0]).join(', ') : ''})`).join(' ; ');
            const conv = t.history.map(h => h.who === 'them' ? 'PROF : ' + h.nl : 'APPRENANT' + (h.isFr ? ' (EN FRANÇAIS)' : '') + ' : ' + h.text).join('\n');
            return `Tu es examinateur de néerlandais (CECR) pour francophones. Voici une conversation de placement entre un prof et un apprenant. Les répliques de l'apprenant ont pu être dictées (ignore ponctuation, majuscules et petites erreurs de transcription). Ses répliques EN FRANÇAIS, et celles qui répètent mot pour mot une aide du prof, ne prouvent rien.
${conv}

Modules du programme (id — niveau — titre — compétences) :
${modLines}

Notions B1 et B2 (id — niveau — titre) :
${notions}

Pour chaque module : "acquis" si ses répliques montrent clairement ces compétences, OU si elles sont évidemment impliquées par un niveau nettement supérieur qu'il a démontré (quelqu'un qui raconte son parcours au passé avec aisance sait se présenter et compter) — alors "deduit": true ; "presque" si c'est là mais avec des fautes gênantes ; "non" sinon. Sois juste : en cas de doute, "presque".
Notions B1/B2 : seulement les ids CLAIREMENT acquis, avec une preuve dans ses répliques.
Portrait : remplis seulement ce qu'il a dit de lui (clés : ${pq}).
Réponds UNIQUEMENT en JSON :
{"niveau": "A1|A2|B1|B2", "resume_fr": "2 phrases chaleureuses et honnêtes", "modules": [{"id": "", "verdict": "acquis|presque|non", "deduit": false, "preuve": "courte citation ou raison"}], "notions_acquises": [""], "portrait": {}, "points_forts": [""], "a_travailler": [""]}`;
        }

        // Évaluation de fin de séance et certification. La séance (répliques + mots) est gardée
        // dans state.coursPointPending tant que l'évaluation détaillée (Gemini) n'a pas abouti :
        // si Gemini est surchargé, l'app fait un compte rendu provisoire avec ses propres contrôles
        // (sujets d'examen des modules, mots bien employés) et on peut relancer l'évaluation
        // détaillée plus tard, depuis le bilan ou depuis Cours.
        async function talkPointEvaluate(t) {
            const ses = { at: Date.now(), partner: t.partner, history: t.history.slice(-80).map(h => h.who === 'them' ? { who: 'them', nl: h.nl } : { who: 'me', text: h.text, isFr: !!h.isFr }), words: [...t.point.words] };
            state.coursPointPending = ses;
            save();
            talkAppend({ who: 'info', html: '<div class="report-meta" id="talk-point-wait">🧑‍🏫 Je fais le point sur ce que tu sais…</div>' });
            const html = await talkPointRun(ses);
            const wait = document.getElementById('talk-point-wait');
            if (wait) wait.parentElement.remove();
            talkAppend({ who: 'info', html });
        }

        function talkPointChecks(ses) {
            const userLines = ses.history.filter(h => h.who === 'me' && !h.isFr).map(h => h.text);
            const checks = {};
            MODRP_IDS.forEach(id => { if (modRpData[id]) checks[id] = modRpExamChecks(id, userLines); });
            return checks;
        }

        // Mots bien employés pendant la séance : actifs d'office (une seule fois par séance).
        function talkPointCertify(ses) {
            if (ses.certified !== undefined) return ses.certified;
            let n = 0;
            (ses.words || []).forEach(id => { const u = state.usedWords && state.usedWords[id]; if (u && (u.c || 0) < USED_ACTIVE_CONVS) { u.c = USED_ACTIVE_CONVS; n++; } });
            ses.certified = n;
            return n;
        }

        function talkPointValidateModule(m, deduit) {
            const st = modRpState(m.id);
            if (!(st.finalResult && st.finalResult.passed)) { st.finalResult = { passed: true, placement: true, deduit: !!deduit, at: Date.now() }; modRpValidateNotions(m.id); }
        }

        async function talkPointRun(ses) {
            if (typeof modRpLoadAll === 'function') await modRpLoadAll();
            const checks = talkPointChecks(ses);
            let r = null;
            if (GeminiService.isAvailable()) {
                try { r = rpHelpParseJson(await GeminiService.generate(talkPointJudgePrompt(ses, checks))); } catch (e) { r = { error: e.message }; }
            }
            if (!r || r.error || !Array.isArray(r.modules)) return talkPointLocalHtml(ses, checks, (r && r.error) || 'réponse illisible');
            ses.done = true; // pas null : la fusion entre appareils ferait réapparaître la séance
            return talkPointApplyHtml(ses, r);
        }

        // Compte rendu provisoire, sans Gemini : seuls les contrôles de l'app comptent (la même
        // règle que l'examen d'un module sans Gemini : au moins 75 % des sujets abordés).
        function talkPointLocalHtml(ses, checks, why) {
            const validated = [], partial = [];
            Object.entries(checks).forEach(([id, ch]) => {
                const m = modRpData[id];
                if (ch.coverageOk) { talkPointValidateModule(m, false); validated.push(m); }
                else if (ch.covered > 0) partial.push({ m, ch });
            });
            const certified = talkPointCertify(ses);
            const lvl = validated.some(m => m.niveau === 'A2') ? 'A2' : (validated.length ? 'A1' : null);
            if (!state.coursPoint || !state.coursPoint.detailed) state.coursPoint = { at: Date.now(), niveau: lvl, modules: validated.length, mots: certified, provisoire: true };
            save();
            return `<div class="prof-debrief">
                <div class="prof-target-title">🧑‍🏫 Le point · compte rendu provisoire</div>
                <p class="report-meta">Gemini n'a pas pu faire l'évaluation détaillée (${rpEscapeHtml(why)}). Ta séance est gardée : relance-la quand Gemini sera disponible. En attendant, voici ce que l'app a pu vérifier seule.</p>
                ${validated.length ? `<div class="prof-deb-sec">✅ Validé (${validated.length} module${validated.length > 1 ? 's' : ''})</div><ul>${validated.map(m => `<li>${rpEscapeHtml(m.titre)} <small>(${m.niveau})</small></li>`).join('')}</ul>` : ''}
                ${certified ? `<div class="prof-deb-sec">🗣️ ${certified} mots certifiés</div><p>Tu les as bien employés : ils comptent comme acquis, sans exercices.</p>` : ''}
                ${partial.length ? `<div class="prof-deb-sec">👀 Abordé en partie</div><ul>${partial.map(({ m, ch }) => `<li>${rpEscapeHtml(m.titre)} <small>(${ch.covered}/${ch.checks.length} sujets)</small></li>`).join('')}</ul>` : ''}
                <p class="report-meta">Le niveau B1/B2, les notions et les modules « déduits » ne peuvent être évalués que par l'évaluation détaillée.</p>
                <div class="prof-actions"><button class="btn btn-green" onclick="talkPointRetry(this)">🔁 Relancer l'évaluation détaillée</button><button class="btn btn-gray" onclick="showApprendre()">📚 Voir mes cours</button></div>
            </div>`;
        }

        // Relance depuis le bilan ou depuis Cours : le résultat remplace le bouton.
        async function talkPointRetry(btn) {
            const ses = state.coursPointPending;
            if (!ses || ses.done) return;
            const box = btn.closest('.prof-debrief, .cours-point') || btn.parentElement;
            btn.disabled = true;
            btn.innerText = '🧑‍🏫 Évaluation en cours…';
            const html = await talkPointRun(ses);
            box.outerHTML = html;
        }

        function talkPointApplyHtml(ses, r) {
            const arr = x => Array.isArray(x) ? x : [];
            const lvl = ['A1', 'A2', 'B1', 'B2'].includes(r.niveau) ? r.niveau : null;
            // Modules acquis : validés comme après un examen réussi.
            const validated = [], almost = [];
            arr(r.modules).forEach(x => {
                const m = x && modRpData[x.id];
                if (!m) return;
                if (x.verdict === 'acquis') { talkPointValidateModule(m, x.deduit); validated.push({ m, x }); }
                else if (x.verdict === 'presque') almost.push({ m, x });
            });
            // Notions B1/B2 acquises.
            const notionsOk = arr(r.notions_acquises).filter(id => curriculumNotions[id]);
            notionsOk.forEach(id => { ntProgress(id).validated = true; recordNotionAttempt(id, true); });
            const certified = talkPointCertify(ses);
            // Portrait (sans écraser ce qui est déjà rempli).
            const keys = new Set(Object.values(GUIDE_PORTRAIT_Q).flat().map(q => q.key));
            const portrait = modRpState(MODRP_IDS[0]).portrait;
            Object.entries(r.portrait || {}).forEach(([k, v]) => { if (keys.has(k) && v !== '' && v != null && (portrait[k] === undefined || portrait[k] === '')) portrait[k] = v; });
            if (lvl) { talkSettings().level = lvl; profSettings().level = lvl; }
            state.coursPoint = { at: Date.now(), niveau: lvl, modules: validated.length, notions: notionsOk.length, mots: certified, detailed: true };
            save();
            const names = list => list.map(({ m, x }) => `<li>${rpEscapeHtml(m.titre)} <small>(${m.niveau}${x.deduit ? ', déduit de ton niveau' : ''})</small></li>`).join('');
            return `<div class="prof-debrief">
                <div class="prof-target-title">🧑‍🏫 Le point${lvl ? ` · niveau estimé <span class="conj-niveau-badge">${lvl}</span>` : ''}</div>
                ${r.resume_fr ? `<p>${rpEscapeHtml(r.resume_fr)}</p>` : ''}
                ${validated.length ? `<div class="prof-deb-sec">✅ Validé, pas besoin de le refaire (${validated.length} module${validated.length > 1 ? 's' : ''})</div><ul>${names(validated)}</ul>` : ''}
                ${notionsOk.length ? `<div class="prof-deb-sec">✅ Notions ${lvl === 'B2' ? 'B1/B2' : 'B1'} acquises : ${notionsOk.length}</div>` : ''}
                ${certified ? `<div class="prof-deb-sec">🗣️ ${certified} mots certifiés</div><p>Tu les as bien employés : ils comptent comme acquis, sans exercices.</p>` : ''}
                ${almost.length ? `<div class="prof-deb-sec">🔁 Presque (à consolider)</div><ul>${names(almost)}</ul>` : ''}
                ${arr(r.points_forts).length ? `<div class="prof-deb-sec">👍 Points forts</div><ul>${arr(r.points_forts).map(x => `<li>${rpEscapeHtml(x)}</li>`).join('')}</ul>` : ''}
                ${arr(r.a_travailler).length ? `<div class="prof-deb-sec">🎯 À travailler</div><ul>${arr(r.a_travailler).map(x => `<li>${rpEscapeHtml(x)}</li>`).join('')}</ul>` : ''}
                <div class="prof-actions"><button class="btn btn-green" onclick="showApprendre()">📚 Voir mes cours</button></div>
            </div>`;
        }

        // Encart en tête de Cours.
        function talkPointCardHtml() {
            const pl = state.coursPoint;
            if (state.coursPointPending && !state.coursPointPending.done) return `<div class="cours-point open"><b>🧑‍🏫 Ton point n'est pas terminé</b><p>Ta dernière séance avec ${rpEscapeHtml((TALK_PARTNERS[state.coursPointPending.partner] || TALK_PARTNERS.svetlana).name)} est gardée, mais l'évaluation détaillée n'a pas pu se faire (Gemini surchargé).${pl && pl.provisoire ? ' Un compte rendu provisoire a déjà été fait.' : ''}</p><button class="btn btn-green" style="margin:6px 0 0;" onclick="talkPointRetry(this)">🔁 Relancer l'évaluation détaillée</button></div>`;
            const btns = Object.entries(TALK_PARTNERS).map(([k, p]) => `<button class="btn ${pl ? 'btn-gray' : 'btn-green'}" style="margin:6px 0 0;" onclick="talkStartPoint('${k}')">${p.emoji} Avec ${p.name}</button>`).join('');
            if (pl) return `<details class="cours-point"><summary>🧑‍🏫 Dernier point : ${pl.niveau ? 'niveau ' + pl.niveau + ' · ' : ''}${new Date(pl.at).toLocaleDateString('fr-BE')} · refaire le point</summary><div class="cours-point-btns">${btns}</div></details>`;
            return `<div class="cours-point open"><b>🧑‍🏫 On fait connaissance ?</b><p>Tu as déjà des bases ? Svetlana ou John te font parler (te présenter, ton numéro, ta journée, tes projets…) et valident ce que tu sais déjà : pas besoin de refaire ces cours. Si tu bloques, dis-le en français, ils te montrent comment le dire.</p><div class="cours-point-btns">${btns}</div></div>`;
        }

        // ===== Mots utilisés à l'oral =====
        // Chaque phrase dite (ou écrite) en néerlandais dans une conversation alimente le
        // vocabulaire : les mots reconnus par l'app (rpWordLookup, formes fléchies comprises) sont
        // notés dans state.usedWords[id] = { n: nombre d'emplois, c: nombre de conversations, last }.
        // Seuls les mots bien employés comptent : si une correction existe, un mot absent de la
        // version corrigée est ignoré. Une nouvelle conversation = plus de 30 min depuis le dernier
        // emploi. « 🗣️ Actif » = dit dans au moins USED_ACTIVE_CONVS conversations : compte dans le
        // vocabulaire couvert et sort des paquets d'entraînement. Le niveau CECR n'en dépend PAS
        // (séparation voulue par Joas). Fusion multi-appareil : règle par défaut (max des nombres).
        const USED_ACTIVE_CONVS = 3;
        const USED_CONV_GAP = 30 * 60 * 1000;

        function usedWordInfo(id) { return (state.usedWords && state.usedWords[id]) || null; }
        function isActiveWord(id) { const u = usedWordInfo(id); return !!(u && (u.c || 0) >= USED_ACTIVE_CONVS); }

        // Après un pronom sujet (« ik kom »), une forme conjuguée est un verbe, pas un nom
        // homonyme (« de kom », le bol) : index des formes conjuguées → infinitif.
        const USED_SUBJECTS = new Set(['ik', 'je', 'jij', 'hij', 'zij', 'ze', 'we', 'wij', 'jullie', 'u', 'men', 'het']);
        let usedVerbForms = null;
        function usedVerbLookup(token) {
            if (!usedVerbForms) {
                usedVerbForms = new Map();
                // Verbes simples d'abord, du plus courant au plus rare (« kom » = komen, pas aankomen).
                const isCompound = v => /\s/.test(v.infinitief) || /\s/.test(v.preteritum) || Object.values(v.present || {}).some(f => /\s/.test(f));
                conjugationData.slice().sort((a, b) => (isCompound(a) - isCompound(b)) || ((b.freq || 0) - (a.freq || 0))).forEach(v => [v.preteritum, deriveImperfectumPluriel(v.preteritum)].concat(Object.values(v.present || {}))
                    .forEach(f => { const k = rpKitNorm(String(f || '').split(' ')[0]); if (k && !usedVerbForms.has(k)) usedVerbForms.set(k, v.infinitief); }));
            }
            const inf = usedVerbForms.get(token);
            return inf ? rpWordLookup(inf) : null;
        }

        const usedTokens = s => String(s || '').split(/[^A-Za-zÀ-ÿ'-]+/).map(t => rpKitNorm(t).replace(/^'+|'+$/g, '')).filter(t => t.length > 1);

        // text : la phrase de l'apprenant ; corr : l'objet de correction s'il y en a un
        // ({ corrige } ou { natural }), null sinon.
        // Séance en cours (même règle des 30 min) : ce qui a bougé, montré SEULEMENT à la fin de la
        // conversation (usedSessionHtml) ; rien pendant l'échange, pour ne pas déranger (choix de Joas).
        let usedSession = null; // { at, ids: Set, fresh: Set, activated: Set, n0 : mots couverts au début }
        function usedSessionCurrent() {
            const now = Date.now();
            if (!usedSession || now - usedSession.at > USED_CONV_GAP) usedSession = { at: now, ids: new Set(), fresh: new Set(), activated: new Set(), n0: getVocabProgress().masteredVocab };
            return usedSession;
        }

        function usedWordsRecord(text, corr) {
            if (!text || (corr && (corr.tout_fr || corr.fr === true))) return 0;
            const fixed = corr && (corr.corrige || corr.natural);
            const okSet = fixed ? new Set(usedTokens(fixed)) : null;
            if (!state.usedWords) state.usedWords = {};
            const ses = usedSessionCurrent();
            const now = Date.now();
            const seen = new Set();
            const toks = usedTokens(text);
            // Mot avec majuscule au milieu d'une phrase = nom propre (« Menen », « Frankrijk ») : ignoré.
            const raw = String(text).split(/[^A-Za-zÀ-ÿ'-]+/).filter(w => rpKitNorm(w).replace(/^'+|'+$/g, '').length > 1);
            const proper = new Set(raw.map((w, i) => i > 0 && /^[A-ZÀ-Þ]/.test(w) && !/[.!?]\s*$/.test(String(text).split(w)[0]) ? rpKitNorm(w) : null).filter(Boolean));
            toks.forEach((t, i) => {
                if (okSet && !okSet.has(t)) return;
                if (proper.has(t)) return;
                if (['de', 'het', 'een', "'t", "'n"].includes(t)) return; // articles : comptés avec leur nom
                const item = (i > 0 && USED_SUBJECTS.has(toks[i - 1]) && usedVerbLookup(t)) || rpWordLookup(t);
                if (!item || !item.id || seen.has(item.id)) return;
                seen.add(item.id);
                const isNew = !state.usedWords[item.id];
                const u = state.usedWords[item.id] || { n: 0, c: 0, last: 0 };
                u.n = (u.n || 0) + 1;
                if (!u.last || now - u.last > USED_CONV_GAP) {
                    u.c = (u.c || 0) + 1;
                    if (u.c === USED_ACTIVE_CONVS) ses.activated.add(item.id);
                }
                u.last = now;
                state.usedWords[item.id] = u;
                ses.ids.add(item.id);
                if (isNew) ses.fresh.add(item.id);
            });
            ses.at = now;
            if (seen.size) save();
            return [...seen];
        }

        // Encart de fin de conversation : ce que la séance a apporté au vocabulaire.
        function usedSessionHtml() {
            const s = usedSession;
            if (!s || !s.ids.size) return '';
            const vp = getVocabProgress();
            const list = ids => [...ids].slice(0, 8).map(id => { const i = fullDb.find(x => x.id === id); return i ? `<b>${rpEscapeHtml(i.nl)}</b>` : ''; }).filter(Boolean).join(', ');
            return `<div class="used-recap">
                <div class="prof-deb-sec">🗣️ Ton vocabulaire</div>
                <div>${s.ids.size} mot${s.ids.size > 1 ? 's' : ''} de ton vocabulaire employé${s.ids.size > 1 ? 's' : ''}${s.fresh.size ? `, dont <b>${s.fresh.size} pour la première fois</b> : ${list(s.fresh)}` : ''}.</div>
                ${s.activated.size ? `<div>⭐ ${s.activated.size} devien${s.activated.size > 1 ? 'nent' : 't'} actif${s.activated.size > 1 ? 's' : ''} : ${list(s.activated)}</div>` : ''}
                <div class="used-recap-pct">Mots couverts : ${s.n0} → <b>${vp.masteredVocab}</b>${vp.masteredVocab > s.n0 ? ` (+${vp.masteredVocab - s.n0})` : ''} · ${vp.pct} % du vocabulaire</div>
            </div>`;
        }

        function usedWordsCount(items) {
            const u = state.usedWords || {};
            return (items || fullDb).filter(i => u[i.id]).length;
        }
        function usedBadgeHtml(id) {
            const u = usedWordInfo(id);
            if (!u) return '';
            const active = (u.c || 0) >= USED_ACTIVE_CONVS;
            return `<span class="wl-badge used${active ? ' active' : ''}" title="Dit ${u.n} fois, dans ${u.c} conversation${u.c > 1 ? 's' : ''}">🗣️ ${active ? 'Actif' : 'Utilisé'}</span>`;
        }

        // ===== Correction active =====
        // Un seul interrupteur (state.settings.liveCorrect, activé par défaut) pour toutes les
        // conversations : jeu de rôle, session guidée, Discuter, Rejouer un entretien, compagnon.
        // Après chaque phrase de l'apprenant, une correction s'affiche sous sa bulle sans couper
        // l'échange. L'apprenant peut mélanger français et néerlandais dans une phrase : le
        // correcteur rend la phrase entière en néerlandais et liste ce qu'il a dit en français ;
        // ces mots vont dans la liste « ✍️ Mes corrections ». Correcteur = appel Gemini séparé
        // (liveCorrectPrompt), qui ne voit que la phrase. Discuter garde sa correction intégrée à
        // son appel unique, le cours particulier corrige toujours (c'est son rôle), mais les deux
        // utilisent les mêmes règles de mélange des langues.
        const LIVE_WORDS_LIST = '✍️ Mes corrections';
        function liveCorrectOn() { return !(state.settings && state.settings.liveCorrect === false); }
        function liveCorrectToggle() {
            if (!state.settings) state.settings = {};
            state.settings.liveCorrect = !liveCorrectOn();
            save();
            document.querySelectorAll('.lc-toggle').forEach(b => { b.outerHTML = liveCorrectToggleHtml(); });
        }
        function liveCorrectToggleHtml() {
            const on = liveCorrectOn();
            return `<button type="button" class="lc-toggle${on ? ' on' : ''}" onclick="liveCorrectToggle()" title="Corriger chacune de mes phrases">✍️ Correction ${on ? 'activée' : 'désactivée'}</button>`;
        }

        // Règles communes sur le mélange des langues (reprises par Discuter et le cours particulier).
        const LIVE_MIX_RULES = `L'apprenant peut MÉLANGER français et néerlandais dans une même phrase quand un mot lui manque (ex. « ik wil een rendez-vous prendre met de dokter »). À l'oral, la reconnaissance vocale écoute en néerlandais : un mot français peut donc être mal transcrit (ex. « prendre » → « pranter ») ; s'il ne veut rien dire en néerlandais et ressemble à un mot français à l'oreille, reconstitue le mot français. Rends alors la phrase ENTIÈRE en néerlandais naturel, et liste chaque partie dite en français avec son équivalent néerlandais.`;

        // Règle commune « réponse à côté » (correcteur, Discuter, tuteur, recruteur de Rejouer).
        const LIVE_OFFTOPIC_RULE = `Vérifie aussi qu'il RÉPOND VRAIMENT à la question ou à la réplique de son interlocuteur : une phrase juste en néerlandais peut répondre à côté, parce qu'il a mal compris la question. Une réponse partielle, une demande de répétition (« Sorry, kunt u dat herhalen? ») ou une question en retour ne sont PAS à côté.`;

        function liveCorrectPrompt(text, level, question) {
            return `Tu es correcteur de néerlandais (Flandre) pour un apprenant francophone de niveau ${level || 'A2'}. Voici UNE phrase qu'il vient de dire à l'oral (reconnaissance vocale : ignore ponctuation, majuscules et petites erreurs de transcription évidentes) ou d'écrire.
${LIVE_MIX_RULES}
Corrige les vraies fautes (grammaire, ordre des mots, conjugaison, de/het, mot faux ou inexistant) et ce qui sonnerait nettement mieux autrement ; garde son idée, ne rajoute rien.
Si la phrase est ENTIÈREMENT en français (une question qu'il te pose, par exemple), réponds {"tout_fr": true}.
${question ? `Il répond à cette réplique de son interlocuteur : « ${String(question).replace(/"/g, "'").slice(0, 500)} »
${LIVE_OFFTOPIC_RULE}
` : ''}Phrase : "${String(text).replace(/"/g, "'")}"
Réponds UNIQUEMENT en JSON : {"tout_fr": false, "ok": true, "corrige": "la phrase complète, entièrement en néerlandais", "erreurs": [{"faux": "", "correct": "", "pourquoi": "très court, en français"}], "francais": [{"fr": "ce qu'il a dit en français", "nl": "l'équivalent néerlandais"}], "bloquant": false${question ? ', "a_cote": false, "question_fr": "", "comprehension_fr": "", "piste_nl": ""' : ''}}
("ok" = aucune faute ET aucun mot français ; "bloquant" = on ne comprend pas ce qu'il veut dire${question ? ` ; "a_cote" = il répond à côté : alors "question_fr" = la question traduite en français, "comprehension_fr" = en une phrase, ce qu'on lui demandait vraiment et ce qu'il a compris à la place, "piste_nl" = une courte réponse en néerlandais qui répond vraiment, en gardant ses informations si possible` : ''})`;
        }

        function liveLevel() { return curriculumLoaded ? getCurriculumLevel().level : 'A1'; }

        // Corrige une phrase ; renvoie l'objet de correction (ou null). Mémorise les mots dits en
        // français dans « ✍️ Mes corrections ».
        async function liveCorrect(text, level, question) {
            if (!text || !GeminiService.isAvailable()) return null;
            let c = null;
            try { c = rpHelpParseJson(await GeminiService.generate(liveCorrectPrompt(text, level || liveLevel(), question))); } catch (e) { return null; }
            if (!c || c.error || c.tout_fr) return null;
            c.francais = (Array.isArray(c.francais) ? c.francais : []).filter(x => x && x.fr && x.nl);
            c.erreurs = (Array.isArray(c.erreurs) ? c.erreurs : []).filter(x => x && x.correct);
            if (c.francais.length) liveSaveWords(c.francais);
            return c;
        }

        function liveSaveWords(pairs) {
            if (!state.customLists) state.customLists = {};
            if (!state.customLists[LIVE_WORDS_LIST]) state.customLists[LIVE_WORDS_LIST] = [];
            const ids = state.customLists[LIVE_WORDS_LIST];
            pairs.forEach(p => {
                const base = String(p.nl).trim();
                const existing = rpWordLookup(base.replace(/^(de|het|een) /i, ''));
                let id = existing && existing.id;
                if (!id) {
                    const k = rpKitNorm(base);
                    if (!k) return;
                    if (!state.rpWords) state.rpWords = {};
                    if (!state.rpWords[k]) state.rpWords[k] = { nl: base, fr: p.fr, at: Date.now() };
                    rpWordsInject();
                    id = 'RPW:' + k;
                }
                if (!ids.includes(id)) ids.push(id);
            });
            save();
            if (typeof renderCustomListsHome === 'function') renderCustomListsHome();
        }

        // Encart sous la bulle de l'apprenant.
        function liveCorrectHtml(c, original) {
            if (!c) return '';
            const same = c.corrige && original && normalize(c.corrige).replace(/[^a-z0-9 ]/g, '') === normalize(original).replace(/[^a-z0-9 ]/g, '');
            const offTopic = c.a_cote ? liveOffTopicHtml(c) : '';
            if ((c.ok || same) && !c.francais.length) return offTopic ? `<div class="lc-card lc-off">${offTopic}<div class="lc-fr">(Ta phrase, elle, est correcte.)</div></div>` : '<div class="lc-card lc-ok">✓ Bien dit</div>';
            const fr = c.francais.map(x => `<div class="lc-fr">🇫🇷 ${rpEscapeHtml(x.fr)} → <b>${rpEscapeHtml(x.nl)}</b></div>`).join('');
            const err = c.erreurs.map(e => `<div class="lc-err">${e.faux ? rpEscapeHtml(e.faux) + ' → ' : ''}<b>${rpEscapeHtml(e.correct)}</b>${e.pourquoi ? ' : ' + rpEscapeHtml(e.pourquoi) : ''}</div>`).join('');
            return `<div class="lc-card${offTopic ? ' lc-off' : ''}">${offTopic}<div class="lc-best">✨ <b>${rpEscapeHtml(c.corrige || '')}</b> ${c.corrige ? speakBtnHtml(c.corrige) : ''}</div>${fr}${err}${c.bloquant ? '<div class="lc-err">On ne comprend pas bien ce que tu veux dire : essaie plus simple.</div>' : ''}</div>`;
        }

        // « Tu as répondu à côté » : ce qu'on demandait, et une piste de vraie réponse.
        function liveOffTopicHtml(c) {
            return `<div class="lc-offq">❓ <b>Tu as répondu à côté</b>${c.question_fr ? ` : on te demandait « ${rpEscapeHtml(c.question_fr)} »` : ''}</div>
                ${c.comprehension_fr ? `<div class="lc-fr">${rpEscapeHtml(c.comprehension_fr)}</div>` : ''}
                ${c.piste_nl ? `<div class="lc-fr">💡 Par exemple : <b>${rpEscapeHtml(c.piste_nl)}</b> ${speakBtnHtml(c.piste_nl)}</div>` : ''}`;
        }

        // Corrige et affiche sous l'élément donné (si la correction active est en marche).
        // question = la réplique à laquelle l'apprenant répond (pour repérer une réponse à côté).
        async function liveCorrectUnder(el, text, level, question) {
            if (!liveCorrectOn() || !el || !GeminiService.isAvailable()) return null;
            const wait = document.createElement('div');
            wait.className = 'lc-card lc-wait';
            wait.innerText = '✍️ …';
            el.appendChild(wait);
            const c = await liveCorrect(text, level, question);
            wait.remove();
            if (c) el.insertAdjacentHTML('beforeend', liveCorrectHtml(c, text));
            return c;
        }

        // ===== Revoir avec mon tuteur (après une conversation) =====
        // À la fin d'un jeu de rôle (entretien, journée métier, étude de cas, jeu de rôle classique,
        // Discuter, Rejouer), le tuteur prend le relais, à l'oral et en français : il revoit les
        // répliques de l'apprenant une par une (contexte, explication de la faute, bonne version en
        // néerlandais, autre façon de le dire) ; l'apprenant peut lui poser des questions en
        // français à tout moment. Répéter la phrase au micro est une option (state.settings.tutor
        // .repeat, désactivée par défaut). Gemini : un appel pour préparer la séance (tutorPrepPrompt),
        // puis un par question posée (tutorAskPrompt) ; prompts séparés des personnages.
        let tutor = null;

        function tutorSettings() {
            if (!state.settings) state.settings = {};
            const s = state.settings.tutor || {};
            state.settings.tutor = { repeat: s.repeat === true };
            return state.settings.tutor;
        }
        function tutorActive(t) { return !!(t && tutor === t && !t.ended && document.getElementById('tutor-view').classList.contains('active')); }

        // La conversation à revoir, selon d'où on vient : [{ me, text }].
        function tutorLines(src) {
            const out = [];
            const push = (me, text) => { text = String(text || '').trim(); if (text) out.push({ me, text }); };
            if (src === 'talk' && talk) talk.history.forEach(h => push(h.who === 'me', h.who === 'me' ? h.text : h.nl));
            else if (src === 'replay' && rpReplay) rpReplay.log.forEach(l => { const m = l.match(/^(.*?) : ([\s\S]*)$/); if (m) push(m[1] === 'Candidat', m[2]); });
            else if (src === 'day' && rpDayState) rpDayState.log.forEach(e => e.turns.forEach(x => push(x.qui === 'apprenant', x.texte)));
            else if (src === 'case' && rpCaseState && rpCaseState.turns) rpCaseState.turns.forEach(x => push(x.qui === 'CANDIDAT', x.texte));
            else if (src === 'rp') {
                if (rpCurrentScenario && rpCurrentScenario.welcome) push(false, rpCurrentScenario.welcome);
                rpConversationHistory.slice(1).forEach(m => push(m.role === 'user', m.parts && m.parts[0] && m.parts[0].text));
            }
            return out;
        }

        function tutorPrepPrompt(lines) {
            const conv = lines.slice(-70).map(l => (l.me ? 'APPRENANT : ' : 'INTERLOCUTEUR : ') + l.text).join('\n');
            return `Tu es le tuteur de néerlandais (Flandre) d'un apprenant francophone de niveau ${liveLevel()}. Il vient de terminer une conversation d'entraînement ; tu prends le relais pour la revoir AVEC lui, à l'oral, comme un tuteur bienveillant.
Conversation (APPRENANT = lui ; ses répliques ont pu être dictées : ignore ponctuation, majuscules et petites erreurs de transcription évidentes ; il a pu glisser des mots français quand un mot lui manquait) :
${conv}

Choisis au plus 8 répliques de l'APPRENANT qui contiennent une faute, un passage en français, qui répondent À CÔTÉ de ce qu'on lui demandait (il a mal compris la question : explique-lui alors ce qu'on lui demandait vraiment, et "version_nl" est une réponse qui y répond), ou qui se diraient nettement mieux autrement (les plus utiles, dans l'ordre de la conversation), et 1 ou 2 répliques réussies à saluer.
Réponds UNIQUEMENT en JSON :
{"intro_fr": "1 ou 2 phrases chaleureuses : ton impression générale",
 "bons": [{"phrase": "sa réplique réussie, telle quelle", "pourquoi_fr": "ce qui est bien, court"}],
 "items": [{"contexte": "la réplique de l'interlocuteur à laquelle il répondait, telle quelle", "phrase": "ce qu'il a dit, tel quel", "explication_fr": "2 ou 3 phrases simples, comme à l'oral, qui expliquent la ou les fautes ; mots néerlandais entre ** **", "version_nl": "la bonne façon de le dire, en gardant son idée", "version_fr": "traduction française", "autre_nl": "une autre façon naturelle de le dire", "a_retenir": {"nl": "la tournure clé, quelques mots", "fr": "sa traduction"}}],
 "conclusion_fr": "1 ou 2 phrases : le point prioritaire à travailler"}`;
        }

        function tutorAskPrompt(item, question) {
            return `Tu es tuteur de néerlandais (Flandre) pour un apprenant francophone de niveau ${liveLevel()}. Vous revoyez ensemble une de ses phrases.
Il avait dit : « ${item ? item.phrase : ''} »
Bonne version : « ${item ? item.version_nl : ''} »
Ton explication : ${item ? item.explication_fr : ''}
Il te demande, en français : « ${question} »
Réponds-lui en français, comme à l'oral, en 2 à 4 phrases claires, avec les mots néerlandais entre ** ** et un exemple si utile.
Réponds UNIQUEMENT en JSON : {"reponse_fr": "", "exemple_nl": ""}`;
        }

        function tutorBubble(who, html) {
            const chat = document.getElementById('tutor-chat');
            if (!chat) return null;
            const div = document.createElement('div');
            div.className = 'prof-msg ' + who;
            div.innerHTML = html;
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            return div;
        }
        const tutorMd = s => rpEscapeHtml(s || '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        async function tutorSay(t, fr) {
            tutorBubble('prof guide-voice', `<div>${tutorMd(fr)}</div>`);
            if (tutorActive(t)) await conjAudioSpeakMixed(String(fr).replace(/\*\*/g, ''), 1, 0.9, () => tutorActive(t));
        }
        async function tutorSayNl(t, nl) { if (tutorActive(t) && nl) await conjAudioSpeak(nl, 'nl', 0.9); }

        function tutorRenderShell() {
            const s = tutorSettings();
            document.getElementById('tutor-content').innerHTML = `
                <h2 style="margin-bottom:4px;">🧑‍🏫 Revoir avec mon tuteur</h2>
                <div class="lc-row" style="margin-bottom:6px;"><button type="button" class="lc-toggle${s.repeat ? ' on' : ''}" onclick="tutorSettings().repeat = !tutorSettings().repeat; save(); this.classList.toggle('on'); this.innerText = '🔁 Me faire répéter : ' + (tutorSettings().repeat ? 'oui' : 'non');">🔁 Me faire répéter : ${s.repeat ? 'oui' : 'non'}</button></div>
                <div id="tutor-chat" class="prof-chat guide-chat"></div>
                <div id="tutor-actions" class="guide-actions"></div>
                <div class="prof-input-row">
                    <input type="text" id="tutor-input" placeholder="Pose-moi ta question en français…" onkeydown="if(event.key==='Enter') tutorSendTyped()">
                    <button type="button" class="btn btn-green prof-send" onclick="tutorSendTyped()">➤</button>
                </div>
                <div class="prof-mic-row"><button type="button" class="btn btn-gray" id="tutor-mic" onclick="tutorMic()">🎤 Poser une question</button></div>`;
        }

        // Attente d'un choix (boutons) ou d'une question tapée / dite.
        function tutorWait(t, btns) {
            return new Promise(res => {
                if (!tutorActive(t)) return res('quit');
                if (t.queued) { const q = t.queued; t.queued = null; return res({ q }); }
                t.waiter = res;
                document.getElementById('tutor-actions').innerHTML = btns.map(([v, l]) => `<button type="button" class="btn ${v === 'next' ? 'btn-green' : 'btn-gray'}" onclick="tutorPick('${v}')">${l}</button>`).join('');
            });
        }
        function tutorPick(v) {
            const t = tutor;
            if (!t || !t.waiter) return;
            const w = t.waiter;
            t.waiter = null;
            const el = document.getElementById('tutor-actions');
            if (el) el.innerHTML = '';
            w(v);
        }
        function tutorSubmit(text) {
            const t = tutor;
            text = String(text || '').trim();
            if (!t || t.ended || !text) return;
            if (t.waiter) tutorPick({ q: text }); else t.queued = text;
        }
        function tutorSendTyped() {
            const input = document.getElementById('tutor-input');
            const v = input ? input.value.trim() : '';
            if (!v) return;
            input.value = '';
            tutorSubmit(v);
        }
        function tutorMic() {
            const t = tutor;
            if (!t) return;
            if (t.rec) { t.rec.finish(true); return; }
            if (!window.SpeechRecognition) { alert("La reconnaissance vocale n'est pas disponible ici : écris ta question."); return; }
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            const mic = document.getElementById('tutor-mic');
            t.rec = longListen({
                lang: 'fr', input: document.getElementById('tutor-input'), silence: profSettings().silence,
                isActive: () => tutorActive(t),
                onState: (st, cd) => { if (mic) { mic.classList.add('listening'); mic.innerText = cd ? `Envoi dans ${cd}…` : "👂 J'écoute… (touche pour envoyer)"; } },
                onEnd: st => { if (t.rec === st) t.rec = null; if (mic) { mic.classList.remove('listening'); mic.innerText = '🎤 Poser une question'; } },
                onSubmit: text => tutorSubmit(text)
            });
        }

        async function tutorAnswer(t, item, q) {
            tutorBubble('moi', '🇫🇷 ' + rpEscapeHtml(q));
            const wait = tutorBubble('info', '…');
            let r = null;
            try { r = rpHelpParseJson(await GeminiService.generate(tutorAskPrompt(item, q))); } catch (e) { r = null; }
            if (wait) wait.remove();
            if (!tutorActive(t)) return;
            if (!r || !r.reponse_fr) { await tutorSay(t, "Je n'ai pas réussi à te répondre, réessaie dans un instant."); return; }
            await tutorSay(t, r.reponse_fr);
            if (r.exemple_nl) { tutorBubble('prof', `<div class="prof-nl">${rpEscapeHtml(r.exemple_nl)} ${speakBtnHtml(r.exemple_nl)}</div>`); await tutorSayNl(t, r.exemple_nl); }
        }

        // Répétition (option) : deux essais, vérifiés dans l'app (rpSpeechMatch), sans Gemini.
        async function tutorRepeat(t, nl) {
            if (!window.SpeechRecognition) return;
            for (let k = 0; k < 2 && tutorActive(t); k++) {
                await tutorSay(t, k ? 'Encore une fois ?' : 'À toi, redis-la.');
                const heard = await conjAudioListen();
                if (!tutorActive(t)) return;
                if (!heard) continue;
                tutorBubble('moi', rpEscapeHtml(heard));
                if (rpSpeechMatch(heard, nl)) { await tutorSay(t, 'Parfait !'); return; }
            }
            if (tutorActive(t)) await tutorSay(t, "Pas grave, on continue : tu la retrouveras dans tes corrections.");
        }

        async function tutorOpen(src) {
            const lines = tutorLines(src);
            if (!lines.some(l => l.me)) { alert("Tu n'as encore rien dit : rien à revoir."); return; }
            if (!GeminiService.isAvailable()) { alert("Il faut une clé Gemini : Profil 👤 → 🤖 Intelligence IA."); return; }
            if (rpIsRecording && rpRecognition) rpRecognition.stop();
            if (typeof rpReplayStopListen === 'function') rpReplayStopListen();
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            if (tutor) tutorQuit(true);
            const prev = document.querySelector('.view.active');
            const t = tutor = { prev: prev ? prev.id : 'home-view', ended: false, waiter: null, queued: null, rec: null };
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('tutor-view').classList.add('active');
            tutorRenderShell();
            const wait = tutorBubble('info', '🧑‍🏫 Je relis ta conversation…');
            let p = null;
            try { p = rpHelpParseJson(await GeminiService.generate(tutorPrepPrompt(lines))); } catch (e) { p = { error: e.message }; }
            if (wait) wait.remove();
            if (!tutorActive(t)) return;
            if (!p || p.error) {
                tutorBubble('info', `⚠️ Je n'ai pas pu préparer la séance (${rpEscapeHtml((p && p.error) || 'réponse illisible')}). <button class="rp-coach-btn" onclick="tutorOpen('${src}')">Réessayer</button>`);
                return;
            }
            const arr = x => Array.isArray(x) ? x : [];
            const items = arr(p.items).filter(x => x && x.version_nl);
            if (p.intro_fr) await tutorSay(t, p.intro_fr);
            for (const b of arr(p.bons).slice(0, 2)) {
                if (!tutorActive(t) || !b.phrase) break;
                tutorBubble('info', `👍 « ${rpEscapeHtml(b.phrase)} »`);
                if (b.pourquoi_fr) await tutorSay(t, b.pourquoi_fr);
            }
            if (!items.length && tutorActive(t)) await tutorSay(t, "Je n'ai rien trouvé d'important à corriger : bravo !");
            for (let i = 0; i < items.length && tutorActive(t); i++) {
                const it = items[i];
                if (it.a_retenir && it.a_retenir.nl && it.a_retenir.fr) liveSaveWords([{ nl: it.a_retenir.nl, fr: it.a_retenir.fr }]);
                tutorBubble('info', `<div class="tutor-step">Réplique ${i + 1} / ${items.length}</div>
                    ${it.contexte ? `<div class="tutor-ctx">On t'a dit : « ${rpEscapeHtml(it.contexte)} »</div>` : ''}
                    <div class="tutor-said">Tu as répondu : « ${rpEscapeHtml(it.phrase || '')} »</div>`);
                if (it.explication_fr) await tutorSay(t, it.explication_fr);
                if (!tutorActive(t)) break;
                tutorBubble('prof', `<div class="prof-nl">✨ <b>${rpEscapeHtml(it.version_nl)}</b> ${speakBtnHtml(it.version_nl)}</div>${it.version_fr ? `<small>${rpEscapeHtml(it.version_fr)}</small>` : ''}`);
                await tutorSayNl(t, it.version_nl);
                if (tutorSettings().repeat) await tutorRepeat(t, it.version_nl);
                let shownOther = false;
                while (tutorActive(t)) {
                    const btns = [['next', i + 1 < items.length ? '✅ Suivant' : '✅ Terminer'], ['again', '🔁 Réécouter']];
                    if (it.autre_nl && !shownOther) btns.push(['other', '🤔 Une autre façon de le dire']);
                    const v = await tutorWait(t, btns);
                    if (v === 'next' || v === 'quit') break;
                    if (v === 'again') { await tutorSayNl(t, it.version_nl); continue; }
                    if (v === 'other') {
                        shownOther = true;
                        tutorBubble('prof', `<div class="prof-nl">💬 ${rpEscapeHtml(it.autre_nl)} ${speakBtnHtml(it.autre_nl)}</div>`);
                        await tutorSayNl(t, it.autre_nl);
                        continue;
                    }
                    if (v && v.q) await tutorAnswer(t, it, v.q);
                }
            }
            if (!tutorActive(t)) return;
            if (p.conclusion_fr) await tutorSay(t, p.conclusion_fr);
            if (items.length) tutorBubble('info', `Les tournures à retenir sont dans « ${LIVE_WORDS_LIST} ».`);
            // Questions libres jusqu'à la sortie.
            while (tutorActive(t)) {
                const v = await tutorWait(t, [['next', '🏁 J\'ai fini']]);
                if (v === 'next' || v === 'quit') break;
                if (v && v.q) await tutorAnswer(t, items[items.length - 1] || null, v.q);
            }
            if (tutor === t && !t.ended) tutorQuit();
        }

        // Retour à l'écran d'où l'on venait (le bilan reste affiché tel quel).
        function tutorQuit(silent) {
            const t = tutor;
            if (!t) return;
            t.ended = true;
            if (t.rec) { const st = t.rec; t.rec = null; st.finish(false); }
            if (t.waiter) { const w = t.waiter; t.waiter = null; w('quit'); }
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            tutor = null;
            if (silent) return;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            const back = document.getElementById(t.prev) || document.getElementById('home-view');
            back.classList.add('active');
        }

        // ===== Compagnon vocal (Svetlana ou John, partout) =====
        // Un micro flottant sur tous les écrans : on parle (ou écrit) au compagnon, en français ou en
        // néerlandais ; il ouvre l'activité demandée, répond aux questions de langue, ou propose la
        // suite. Les demandes courantes sont reconnues dans l'app, sans Gemini (buddyLocal) ; les
        // phrases libres partent à Gemini avec la liste des actions possibles (buddyAsk), qui répond
        // en JSON { reply, action, params }. Les actions ne font qu'appeler les écrans existants.
        let buddyLog = [];      // conversation de la session (non sauvegardée)
        let buddyRec = null;
        let buddyBusy = false;

        function buddySettings() {
            if (!state.settings) state.settings = {};
            const s = state.settings.buddy || {};
            state.settings.buddy = { partner: TALK_PARTNERS[s.partner] ? s.partner : 'svetlana', lang: s.lang === 'nl' ? 'nl' : 'fr' };
            return state.settings.buddy;
        }
        function buddyPartner() { return TALK_PARTNERS[buddySettings().partner]; }

        // Écrans qui ont déjà leur propre micro : le bouton flottant s'y efface.
        const BUDDY_HIDDEN_VIEWS = ['tutor-view', 'talk-view', 'replay-view', 'prof-view', 'modguide-view', 'roleplay-view', 'scene-view', 'compte-view', 'onboarding-view'];
        function buddyRefreshFab() {
            const fab = document.getElementById('buddy-fab');
            if (!fab) return;
            const v = document.querySelector('.view.active');
            const hide = document.body.classList.contains('gated') || document.body.classList.contains('auth-pending') || (v && BUDDY_HIDDEN_VIEWS.includes(v.id)) || document.getElementById('buddy-sheet').classList.contains('open');
            fab.style.display = hide ? 'none' : '';
            fab.innerHTML = '🎙️';
            document.querySelectorAll('#rp-help-row .lc-toggle').forEach(b => { b.outerHTML = liveCorrectToggleHtml(); });
            fab.title = 'Parler à ' + buddyPartner().name;
        }

        // ----- Les actions que le compagnon sait lancer -----
        function buddyNextModule() {
            const isPassed = m => { const s = modRpState(m.id); return !!(s.finalResult && s.finalResult.passed); };
            return MODRP_IDS.map(id => modRpData[id]).filter(Boolean).find(m => !isPassed(m));
        }
        const BUDDY_CATS = { verbes: 'VERBES_NL', noms: 'NOMS_NL', adjectifs: 'ADJECTIFS_NL', adverbes: 'ADVERBES_NL', expressions: 'EXPRESSIONS_NL', locutions: 'LOCUTIONS_NL', 'mots-outils': 'MOTS_OUTILS_NL' };
        const BUDDY_ACTIONS = {
            accueil: { desc: "écran d'accueil", run: () => showHome() },
            vocabulaire: { desc: 'onglet Vocabulaire (choix des catégories de mots)', run: () => showVocab() },
            categorie: { desc: "fiche d'une catégorie de mots ; params.categorie parmi " + Object.keys(BUDDY_CATS).join(', ') + " ; params.entrainer=true pour lancer l'entraînement", run: p => { const f = BUDDY_CATS[p.categorie]; if (!f) return showVocab(); vocabOpenCat('file', f); if (p.entrainer) vocabTrain(); } },
            erreurs: { desc: 'réviser les mots ratés', check: () => getReviewItems().length ? null : "Tu n'as aucun mot raté à revoir pour l'instant, bravo ! On fait autre chose ?", run: () => { studyReturnFn = showHome; startRevision(); } },
            dehet: { desc: 'réviser les articles de / het', check: () => getArticleReviewItems().length ? null : "Rien à revoir côté de / het pour l'instant. Tu veux t'entraîner sur les noms ?", run: () => { studyReturnFn = showHome; startArticleRevision(); } },
            conjugaison: { desc: "conjugaison ; params.verbe = infinitif néerlandais pour ouvrir sa fiche ; params.entrainer=true pour l'entraînement", run: p => { const v = p.verbe && conjugationLoaded && conjugationData.find(x => normalize(x.infinitief) === normalize(p.verbe)); if (p.entrainer && !v) return startConjTrainingSession(); showConjugaison(); if (v) showConjugaisonDetail(v.infinitief); } },
            separables: { desc: "entraînement aux verbes à particule séparable", run: () => startSeparableTrainingSession() },
            blocs: { desc: 'blocs de mots (mots en contexte)', run: () => showChunkTraining() },
            test: { desc: 'test de vocabulaire', run: () => showTestSelect() },
            cours: { desc: 'onglet Cours (modules en situation)', run: () => showApprendre() },
            module: { desc: "lancer ou continuer un module en situation ; params.module = mot du titre (ex. courses, logement), sinon le prochain", run: p => { const all = MODRP_IDS.map(id => modRpData[id]).filter(Boolean); const q = p.module ? normalize(p.module) : ''; const m = (q && all.find(x => normalize(x.titre).includes(q) || x.id.includes(q))) || buddyNextModule() || all[0]; if (m) guideStart(m.id); else showApprendre(); } },
            grammaire: { desc: 'mémo de grammaire', run: () => showComprendre() },
            cours_particulier: { desc: 'cours particulier avec le prof ; params.duree 15 ou 30', run: p => { if (p.duree) profSettings().dur = Number(p.duree) === 30 ? 30 : 15; showProf(); } },
            faire_le_point: { desc: "faire le point sur son niveau en conversation avec Svetlana ou John (valide ce qu'il sait déjà) ; params.partenaire", run: p => talkStartPoint(TALK_PARTNERS[p.partenaire] ? p.partenaire : talkSettings().partner) },
            situation: { desc: "jouer une situation de la vie courante dans Discuter (pharmacie, médecin, logement, soirée, téléphone…) ; params.situation = mots-clés, sinon au hasard", run: async p => { await rpLoadLibrary(); const all = talkSituations(); const q = normalize(p.situation || ''); const words = q.split(/[^a-z0-9]+/).filter(w => (w.length > 3 || /^\d+$/.test(w)) && !['avec', 'pour', 'dans', 'chez', 'veux', 'voudrais', 'faire', 'aller', 'visite', 'situation', 'simule', 'simuler', 'jouer'].includes(w)); const score = x => words.reduce((n, w) => n + (normalize(x.label + ' ' + x.contexte).includes(w) ? w.length + (normalize(x.label).includes(w) ? 5 : 0) : 0), 0); const best = all.map(x => [x, score(x)]).sort((a, b) => b[1] - a[1])[0]; const e = best && best[1] > 0 ? best[0] : null; if (TALK_PARTNERS[p.partenaire]) talkSettings().partner = p.partenaire; talkOpenSituation(e ? e.id : all[Math.floor(Math.random() * all.length)].id); } },
            discuter: { desc: 'conversation libre ; params.partenaire svetlana ou john ; params.sujet (week-end, travail, voyages…)', run: async p => { const s = talkSettings(); if (TALK_PARTNERS[p.partenaire]) s.partner = p.partenaire; const sj = p.sujet ? normalize(p.sujet).replace(/-/g, '') : ''; const tk = sj && Object.keys(TALK_TOPICS).find(k => k !== 'libre' && (sj.includes(k) || normalize(TALK_TOPICS[k]).replace(/-/g, '').includes(sj))); if (tk) s.topic = tk; s.mode = 'libre'; await showTalk(); if (p.lancer) talkStart(); } },
            pratiquer: { desc: 'onglet Pratiquer', run: () => showPratiquer() },
            entretiens: { desc: "entraînement aux entretiens d'embauche (questions de vrais entretiens)", run: () => { showRoleplay('travail'); rpShowRealCandidateList(); } },
            rejouer: { desc: 'rejouer un vrai entretien mot pour mot', run: () => rpShowReplayList() },
            etude_de_cas: { desc: 'étude de cas (business case)', run: () => { showRoleplay('travail'); rpShowCaseHome(); } },
            travail: { desc: 'mises en situation dans mon métier', run: () => { showRoleplay('travail'); rpShowJobHome(); } },
            jeux: { desc: "onglet Jouer ; params.jeu parmi memory, chrono, anagramme, tri", run: p => ({ memory: startMemory, chrono: showTASelect, anagramme: startAnagram, tri: showSwipeSelect }[p.jeu] || showReviser)() },
            profil: { desc: 'profil, statistiques, carte des compétences', run: () => showProfil() }
        };

        // ----- Reconnaissance locale des demandes courantes (sans Gemini) -----
        function buddyLocal(text) {
            const t = ' ' + normalize(text).replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ') + ' ';
            const has = re => re.test(t);
            // Traduction : « comment on dit X », « que veut dire X », « wat betekent X »
            let m = t.match(/comment (?:on dit|dit-on|dire) (.+?)(?: en neerlandais)? $/);
            if (m) return { translate: { dir: 'fr2nl', q: m[1].trim() } };
            m = t.match(/(?:que veut dire|ca veut dire quoi|wat betekent|qu'est-ce que veut dire) (.+?) $/);
            if (m) return { translate: { dir: 'nl2fr', q: m[1].trim() } };
            const verbe = conjugationLoaded ? conjugationData.find(v => t.includes(' ' + normalize(v.infinitief) + ' ')) : null;
            if (has(/conjug|vervoeg/)) return { action: 'conjugaison', params: { verbe: verbe && verbe.infinitief, entrainer: has(/entrain|exerc|interroge/) } };
            if (has(/separable|particule/)) return { action: 'separables' };
            if (has(/erreur|rate|fautes|mots a revoir/)) return { action: 'erreurs' };
            if (has(/ de het |de ou het|article/)) return { action: 'dehet' };
            if (has(/cours particulier|prof\b|professeur/)) return { action: 'cours_particulier', params: { duree: has(/30|trente/) ? 30 : (has(/15|quinze/) ? 15 : null) } };
            if (has(/rejou|tel quel|mot pour mot/)) return { action: 'rejouer' };
            if (has(/entretien|sollicit|recruteur/)) return { action: 'entretiens' };
            if (has(/etude de cas|business case/)) return { action: 'etude_de_cas' };
            if (has(/faire le point|mon niveau|evaluer|placement|ce que je sais deja/)) return { action: 'faire_le_point', params: { partenaire: has(/john/) ? 'john' : (has(/svetlana/) ? 'svetlana' : null) } };
            if (has(/simul|situation|jeu de role|pharmac|medecin|dentiste|commune|boulanger|coiffeur|restaurant|supermarche|112|urgence|appartement|plombier|soiree/) && !has(/metier|travail|entretien|module/)) return { action: 'situation', params: { situation: text } };
            if (has(/discut|parler (avec|de|un peu)|bavard|conversation/)) return { action: 'discuter', params: { partenaire: has(/john/) ? 'john' : (has(/svetlana/) ? 'svetlana' : null), sujet: text, lancer: true } };
            if (has(/module|lecon|continue|reprend/)) {
                const all = MODRP_IDS.map(id => modRpData[id]).filter(Boolean);
                const named = all.find(x => normalize(x.titre).split(/\s+/).some(w => w.length > 4 && t.includes(' ' + w + ' ')));
                return { action: 'module', params: { module: named ? named.id : null } };
            }
            if (has(/memory/)) return { action: 'jeux', params: { jeu: 'memory' } };
            if (has(/contre la montre|chrono/)) return { action: 'jeux', params: { jeu: 'chrono' } };
            if (has(/anagram|melange/)) return { action: 'jeux', params: { jeu: 'anagramme' } };
            if (has(/ jeu| jeux|jouer/)) return { action: 'jeux' };
            const cat = Object.keys(BUDDY_CATS).find(k => t.includes(' ' + k.replace('-', ' ') + ' ') || t.includes(' ' + k + ' '));
            if (cat) return { action: 'categorie', params: { categorie: cat, entrainer: has(/entrain|revis|apprend|interroge/) } };
            if (has(/bloc/)) return { action: 'blocs' };
            if (has(/test/)) return { action: 'test' };
            if (has(/grammaire|regle/)) return { action: 'grammaire' };
            if (has(/vocabulaire|mots/)) return { action: 'vocabulaire' };
            if (has(/metier|au travail|situation/)) return { action: 'travail' };
            if (has(/profil|progression|competence|statistique/)) return { action: 'profil' };
            if (has(/accueil|maison/)) return { action: 'accueil' };
            return null;
        }

        function buddyTranslateLocal(tr) {
            const q = normalize(tr.q).replace(/^(le |la |les |l'|un |une |de |het |een )/, '');
            if (!q) return null;
            const field = tr.dir === 'fr2nl' ? 'fr' : 'nl';
            const pool = fullDb.filter(i => i.nl && i.fr);
            const exact = pool.filter(i => normalize(i[field]).split(/\s*[\/,;]\s*/).some(x => x.replace(/^(le |la |les |l'|de |het |een |un |une )/, '') === q));
            const hits = (exact.length ? exact : pool.filter(i => normalize(i[field]).includes(q))).slice(0, 3);
            if (!hits.length) return null;
            return hits.map(i => tr.dir === 'fr2nl' ? `« ${i.fr} » se dit **${i.nl}**` : `**${i.nl}** veut dire « ${i.fr} »`).join(' ; ');
        }

        // ----- Interface : panneau qui s'ouvre depuis le micro flottant ou l'accueil -----
        function buddyOpen(listen) {
            const sheet = document.getElementById('buddy-sheet');
            sheet.classList.add('open');
            buddyRender();
            buddyRefreshFab();
            if (!buddyLog.length) buddyGreet();
            if (listen && window.SpeechRecognition) setTimeout(() => buddyMic(), 150);
        }
        function buddyClose() {
            buddyStopListen();
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            document.getElementById('buddy-sheet').classList.remove('open');
            buddyRefreshFab();
        }

        function buddyRender() {
            const p = buddyPartner(), s = buddySettings();
            document.getElementById('buddy-sheet').innerHTML = `
                <div class="buddy-head">
                    <div class="buddy-who">${Object.entries(TALK_PARTNERS).map(([k, x]) => `<button type="button" class="buddy-pick${s.partner === k ? ' active' : ''}" onclick="buddySetPartner('${k}')">${x.emoji} ${x.name}</button>`).join('')}</div>
                    <button type="button" class="buddy-close" onclick="buddyClose()" title="Fermer">✕</button>
                </div>
                <div id="buddy-chat" class="buddy-chat"></div>
                <div id="buddy-sugg" class="talk-sugg"></div>
                <div class="prof-input-row">
                    <input type="text" id="buddy-input" placeholder="Demande-moi ce que tu veux…" onkeydown="if(event.key==='Enter') buddySendTyped()">
                    <button type="button" class="btn btn-green prof-send" onclick="buddySendTyped()">➤</button>
                </div>
                <div class="talk-bar">
                    <button type="button" class="talk-side" onclick="buddySetLang('${s.lang === 'fr' ? 'nl' : 'fr'}')" title="Langue du micro">${s.lang === 'fr' ? '🇫🇷' : '🇳🇱'}</button>
                    <button type="button" class="talk-mic" id="buddy-mic" onclick="buddyMic()">🎤</button>
                    <span class="talk-side" style="visibility:hidden;"></span>
                </div>
                <div id="buddy-hint" class="talk-mic-hint">Parle-moi en ${s.lang === 'fr' ? 'français' : 'néerlandais'} (touche le drapeau pour changer).</div>
                ${s.lang === 'nl' ? `<div class="lc-row">${liveCorrectToggleHtml()}</div>` : ''}`;
            buddyLog.forEach(m => buddyAppend(m, true));
            buddyRenderSugg();
        }

        function buddySetPartner(k) { buddySettings().partner = k; save(); buddyLog = []; buddyRender(); buddyGreet(); buddyRefreshFab(); if (document.getElementById('home-view').classList.contains('active')) renderDashboard(); }
        function buddySetLang(l) { buddySettings().lang = l; save(); buddyRender(); }

        function buddyAppend(m, replay) {
            if (!replay) buddyLog.push(m);
            const chat = document.getElementById('buddy-chat');
            if (!chat) return;
            const div = document.createElement('div');
            div.className = 'talk-msg ' + (m.who === 'me' ? 'me' : 'them');
            div.innerHTML = m.who === 'me' ? rpEscapeHtml(m.text) : rpEscapeHtml(m.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
            return div;
        }

        // Suggestions selon la situation, calculées dans l'app.
        function buddySuggestions() {
            const out = [];
            const next = buddyNextModule();
            if (next) out.push({ label: '▶️ ' + next.titre, text: 'continue le module ' + next.titre });
            const n = getReviewItems().length;
            if (n) out.push({ label: `🔁 Mes ${n} erreurs`, text: 'fais-moi réviser mes erreurs' });
            out.push({ label: '💬 Discuter', text: 'je veux discuter' });
            out.push({ label: '🎓 Cours de 15 min', text: 'lance un cours particulier de 15 minutes' });
            out.push({ label: '🔤 Conjugaison', text: 'je veux travailler la conjugaison' });
            out.push({ label: '🎯 Entretien', text: "entraîne-moi pour un entretien" });
            return out;
        }
        function buddyRenderSugg() {
            const el = document.getElementById('buddy-sugg');
            if (el) el.innerHTML = buddySuggestions().map((s, i) => `<button type="button" class="talk-chip" onclick="buddySubmit(buddySuggestions()[${i}].text)">${rpEscapeHtml(s.label)}</button>`).join('');
        }

        function buddyGreeting() {
            const p = buddyPartner();
            const name = currentUserDoc && currentUserDoc.pseudo ? ' ' + currentUserDoc.pseudo : '';
            const next = buddyNextModule();
            const n = getReviewItems().length;
            const idea = next ? `on continue « ${next.titre} » ?` : (n ? `on revoit tes ${n} mots ratés ?` : 'on discute un peu en néerlandais ?');
            return `Salut${name} ! C'est ${p.name}. Dis-moi ce que tu veux faire, ou ${idea}`;
        }
        function buddyGreet() {
            const g = buddyGreeting();
            buddyAppend({ who: 'them', text: g });
            conjAudioSpeakMixed(g, 1, 0.9);
        }

        async function buddySay(text, speak) {
            buddyAppend({ who: 'them', text });
            if (speak !== false) await conjAudioSpeakMixed(text.replace(/\*\*/g, ''), 1, 0.9);
        }

        // Exécute une action : courte confirmation, puis le panneau se ferme et l'écran s'ouvre.
        async function buddyRun(id, params) {
            const a = BUDDY_ACTIONS[id];
            if (!a) return false;
            const why = a.check && a.check(params || {});
            if (why) { await buddySay(why); return true; }
            buddyClose();
            try { await a.run(params || {}); } catch (e) { console.warn('Action du compagnon impossible :', id, e); }
            return true;
        }

        async function buddySubmit(text) {
            text = String(text || '').trim();
            if (!text || buddyBusy) return;
            buddyStopListen();
            const meDiv = buddyAppend({ who: 'me', text });
            if (buddySettings().lang === 'nl') (liveCorrectOn() ? liveCorrectUnder(meDiv, text) : Promise.resolve(null)).then(c => usedWordsRecord(text, c));
            const local = buddyLocal(text);
            if (local && local.translate) {
                const ans = buddyTranslateLocal(local.translate);
                if (ans) { await buddySay(ans); return; }
            } else if (local && local.action) {
                const label = { conjugaison: 'la conjugaison', erreurs: 'tes erreurs', module: 'le module', cours_particulier: 'le cours particulier', discuter: 'la discussion', entretiens: 'les entretiens', rejouer: 'les vrais entretiens', jeux: 'les jeux', categorie: 'le vocabulaire', vocabulaire: 'le vocabulaire' }[local.action];
                if (!(BUDDY_ACTIONS[local.action].check && BUDDY_ACTIONS[local.action].check(local.params || {}))) buddySay(label ? `C'est parti pour ${label} !` : "C'est parti !", false);
                await buddyRun(local.action, local.params);
                return;
            }
            await buddyAsk(text);
        }

        // Phrase libre : Gemini choisit l'action ou répond (question de langue, conseil…).
        async function buddyAsk(text) {
            if (!GeminiService.isAvailable()) { await buddySay("Je n'ai pas compris, et sans clé Gemini je ne peux pas aller plus loin. Essaie par exemple : « conjugue werken », « mes erreurs », « continue le module »."); return; }
            const p = buddyPartner();
            buddyBusy = true;
            const chat = document.getElementById('buddy-chat');
            const wait = document.createElement('div');
            wait.className = 'talk-msg them typing';
            wait.innerHTML = '<span></span><span></span><span></span>';
            if (chat) { chat.appendChild(wait); chat.scrollTop = chat.scrollHeight; }
            let r = null;
            try {
                r = rpHelpParseJson(await GeminiService.generate(`${p.base} Ici, tu es le compagnon d'apprentissage de l'apprenant dans l'application NL Mastery (néerlandais pour francophones, niveau ${curriculumLoaded ? getCurriculumLevel().level : 'A1'}). Tu parles surtout français, avec des exemples en néerlandais.
Actions que tu peux lancer dans l'app (id : description) :
${Object.entries(BUDDY_ACTIONS).map(([k, a]) => '- ' + k + ' : ' + a.desc).join('\n')}
Conversation récente :
${buddyLog.slice(-8).map(m => (m.who === 'me' ? 'Apprenant : ' : p.name + ' : ') + m.text).join('\n')}
Si l'apprenant veut faire une activité, choisis l'action et ses paramètres. S'il pose une question (traduction, grammaire, conseil), réponds-y en 2 à 4 phrases claires, avec les mots néerlandais entre ** **, sans action. Reste chaleureux et bref.
Réponds UNIQUEMENT en JSON : {"reply": "ce que tu dis, en français", "action": null, "params": {}}`));
            } catch (e) { r = { error: e.message }; }
            wait.remove();
            buddyBusy = false;
            if (!r || r.error || !r.reply) { await buddySay("Oups, je n'ai pas réussi à répondre. Réessaie dans un instant."); return; }
            await buddySay(r.reply, !(r.action && BUDDY_ACTIONS[r.action]));
            if (r.action && BUDDY_ACTIONS[r.action]) await buddyRun(r.action, r.params || {});
        }

        function buddySendTyped() {
            const input = document.getElementById('buddy-input');
            const v = input ? input.value.trim() : '';
            if (!v) return;
            input.value = '';
            buddySubmit(v);
        }

        function buddyStopListen() { if (buddyRec) { const st = buddyRec; buddyRec = null; st.finish(false); } }
        function buddyMic() {
            if (buddyRec) { buddyRec.finish(true); return; }
            if (!window.SpeechRecognition) { alert("La reconnaissance vocale n'est pas disponible ici : écris ta demande, ou utilise Chrome."); return; }
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            const lang = buddySettings().lang;
            const mic = document.getElementById('buddy-mic'), hint = document.getElementById('buddy-hint');
            buddyRec = longListen({
                lang, input: document.getElementById('buddy-input'), silence: Math.min(profSettings().silence || 3000, 3000) || 3000,
                isActive: () => document.getElementById('buddy-sheet').classList.contains('open'),
                onState: (st, cd) => { if (mic) mic.classList.add('listening'); if (hint) hint.innerText = cd ? `Envoi dans ${cd}…` : "J'écoute…"; },
                onEnd: st => { if (buddyRec === st) buddyRec = null; if (mic) mic.classList.remove('listening'); if (hint) hint.innerText = 'Touche le micro pour parler.'; },
                onSubmit: text => buddySubmit(text)
            });
        }

        // Bloc « conversation » en haut de l'accueil.
        function buddyHomeHtml() {
            const s = buddySettings(), p = buddyPartner();
            return `<div class="dash-card buddy-home">
                <div class="buddy-home-top">
                    <span class="buddy-home-mic">🎙️</span>
                    <div class="buddy-home-txt"><b>${p.name}</b> · <span class="buddy-home-switch">${Object.entries(TALK_PARTNERS).filter(([k]) => k !== s.partner).map(([k, x]) => `<a href="#" onclick="buddySetPartner('${k}'); return false;">passer à ${x.name}</a>`).join('')}</span><div>${rpEscapeHtml(buddyGreeting())}</div></div>
                </div>
                <div class="talk-sugg">${buddySuggestions().slice(0, 4).map((x, i) => `<button type="button" class="talk-chip" onclick="buddyOpen(false); buddySubmit(buddySuggestions()[${i}].text)">${rpEscapeHtml(x.label)}</button>`).join('')}</div>
                <button class="btn btn-green" style="margin:8px 0 0;" onclick="buddyOpen(true)">🎤 Parler à ${p.name}</button>
            </div>`;
        }

        // Le bouton suit les changements d'écran (classe .active des vues) et l'état de connexion.
        function buddyInit() {
            if (!document.getElementById('buddy-fab')) return;
            const obs = new MutationObserver(() => buddyRefreshFab());
            document.querySelectorAll('.view').forEach(v => obs.observe(v, { attributes: true, attributeFilter: ['class'] }));
            obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            buddyRefreshFab();
        }
        buddyInit();

        rpInitSpeechRecognition();
        rpCheckDutchVoice();
        init();
