// Firebase SDK bootstrap.
// Initialized lazily — only when USER_PROVIDER=firebase servers load the app.
// Config is pulled from /api/config at runtime (backend embeds the web config
// there) so the same frontend bundle works on both local-mode and Firebase
// mode deployments without a rebuild.
//
// The SDK itself is loaded on first use, not imported: a static import put
// firebase/app + firebase/auth into the entry bundle of every install,
// although only Firebase-mode servers ever call initFirebase
// (__tests__/marp-entry-bundle.test.js pins it).

let _sdk = null; // { getApps, initializeApp, getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
let _ready = null;
let _auth = null;
let _provider = null;

function loadSdk() {
  if (!_ready) {
    _ready = Promise.all([import('firebase/app'), import('firebase/auth')])
      .then(([app, auth]) => { _sdk = { ...app, ...auth }; return _sdk; });
  }
  return _ready;
}

/**
 * Call once on app bootstrap with the `firebaseWebConfig` object returned
 * from /api/config. Safe to call multiple times — subsequent calls no-op.
 * Loads the SDK; resolves to the Auth instance (null without a config).
 */
export async function initFirebase(webConfig) {
  if (!webConfig || typeof webConfig !== 'object') return null;
  const sdk = await loadSdk();
  if (sdk.getApps().length === 0) {
    sdk.initializeApp(webConfig);
  }
  if (!_auth) {
    _auth = sdk.getAuth();
    _provider = new sdk.GoogleAuthProvider();
  }
  return _auth;
}

/**
 * Pop up the Google sign-in dialog. Returns a Firebase ID token on success.
 * Errors bubble up to the caller so the UI can display them.
 */
export async function signInWithGoogle() {
  if (!_auth && _ready) await _ready.then(() => null).catch(() => null);
  if (!_auth) throw new Error('Firebase not initialized');
  // No await before this when the SDK is ready (it starts loading as the app
  // boots): a popup opened outside the click's own task can be blocked.
  const result = await _sdk.signInWithPopup(_auth, _provider);
  const idToken = await result.user.getIdToken();
  return { idToken, user: result.user };
}

/**
 * Local Firebase sign-out — forgets the Google sign-in in *this* tab only.
 * Does NOT revoke the user's Google session globally. That's deliberate —
 * logging out of mdnest should not sign the user out of Google services.
 */
export async function signOutFirebase() {
  if (!_auth) return;
  try {
    await _sdk.signOut(_auth);
  } catch {
    // Ignore — we're tearing down anyway.
  }
}

/**
 * Subscribe to Firebase auth state. Returns an unsubscribe fn.
 * Currently unused by App.jsx (mdnest has its own JWT and doesn't re-sync
 * from Firebase), but exported for future integrations.
 */
export function onFirebaseAuthStateChanged(cb) {
  if (!_auth) return () => {};
  return _sdk.onAuthStateChanged(_auth, cb);
}
