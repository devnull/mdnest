// firebase-config.js loads the Firebase SDK on first use instead of importing
// it (it used to sit in every install's entry bundle). Lazy loading must not
// change what the user sees: the Google popup has to open in the same task
// as the click, or the browser's popup blocker may stop it. The SDK starts
// loading as the app boots, so by the time anyone clicks it is ready and
// signInWithGoogle must reach signInWithPopup without waiting on anything.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => []);

vi.mock('firebase/app', () => ({
  getApps: () => [],
  initializeApp: (cfg) => { calls.push(['initializeApp', cfg.projectId]); },
}));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ name: 'auth' }),
  GoogleAuthProvider: class {},
  signInWithPopup: () => {
    calls.push(['signInWithPopup']);
    return Promise.resolve({ user: { getIdToken: () => Promise.resolve('id-token') } });
  },
  signOut: () => { calls.push(['signOut']); return Promise.resolve(); },
  onAuthStateChanged: () => () => {},
}));

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
});

describe('firebase-config', () => {
  it('refuses to sign in before Firebase was set up', async () => {
    const fb = await import('../firebase-config.js');
    await expect(fb.signInWithGoogle()).rejects.toThrow('Firebase not initialized');
  });

  it('does nothing without a config', async () => {
    const fb = await import('../firebase-config.js');
    expect(await fb.initFirebase(null)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('opens the popup in the same task as the click once the SDK is loaded', async () => {
    const fb = await import('../firebase-config.js');
    await fb.initFirebase({ projectId: 'p1' });
    expect(calls).toEqual([['initializeApp', 'p1']]);

    const pending = fb.signInWithGoogle(); // the click handler's call
    // Synchronously, before any microtask: the popup was already requested.
    expect(calls.at(-1)).toEqual(['signInWithPopup']);
    await expect(pending).resolves.toMatchObject({ idToken: 'id-token' });
  });

  it('waits for an SDK still loading instead of failing the click', async () => {
    const fb = await import('../firebase-config.js');
    const init = fb.initFirebase({ projectId: 'p2' }); // not awaited: still loading
    await expect(fb.signInWithGoogle()).resolves.toMatchObject({ idToken: 'id-token' });
    await init;
  });

  it('signs out through the loaded SDK', async () => {
    const fb = await import('../firebase-config.js');
    await fb.signOutFirebase(); // nothing set up: a no-op
    await fb.initFirebase({ projectId: 'p3' });
    await fb.signOutFirebase();
    expect(calls.at(-1)).toEqual(['signOut']);
  });
});
