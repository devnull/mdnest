// Measures how much memory one shared editing room holds on the server after
// a long session. The server keeps every Yjs update it relays until the saver
// sends a compacted snapshot, so this replays a synthetic session and adds up
// the update sizes, then compares with the snapshot size.
//
//   node frontend/scripts/measure-shared-room.mjs [keystrokes] [saveEvery]
//
// The session: two people type into one note (a mix of new words and
// backspaces) with one update per keystroke, the way the editor binding sends
// them, and the saver records a save (etag, base text, serialized text in the
// shared document) every `saveEvery` keystrokes.
import * as Y from 'yjs';

const keystrokes = Number(process.argv[2] || 20000);
const saveEvery = Number(process.argv[3] || 40);

const a = new Y.Doc();
const b = new Y.Doc();
let logBytes = 0;
let entries = 0;
// The server's rule (backend/collab/yjs.go): past 1 MB and 4x the last
// snapshot, the saver is asked for a snapshot that replaces the log.
let roomBytes = 0;
let lastSnap = 0;
let peakRoom = 0;
let compactions = 0;
const relay = (from, to) => from.on('update', (u, origin) => {
  if (origin === 'remote') return;
  logBytes += u.length;
  entries += 1;
  roomBytes += u.length;
  peakRoom = Math.max(peakRoom, roomBytes);
  if (roomBytes > 1024 * 1024 && roomBytes > 4 * lastSnap) {
    lastSnap = Y.encodeStateAsUpdate(from).length;
    roomBytes = lastSnap;
    compactions += 1;
  }
  Y.applyUpdate(to, u, 'remote');
});
relay(a, b);
relay(b, a);

// A starting note of about 4 KB, seeded as one update.
const fragA = a.getXmlFragment('prosemirror');
a.transact(() => {
  for (let i = 0; i < 40; i += 1) {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Starting paragraph number ' + i + ' with some ordinary words in it for size.')]);
    fragA.insert(fragA.length, [p]);
  }
});
const seedBytes = logBytes;

const words = 'the quick brown fox jumps over a lazy dog while people edit notes together'.split(' ');
let rnd = 7;
const rand = (n) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd % n; };

const text = (doc) => doc.getXmlFragment('prosemirror').toString();
for (let k = 0; k < keystrokes; k += 1) {
  const doc = k % 2 ? a : b;
  const frag = doc.getXmlFragment('prosemirror');
  const para = frag.get(rand(frag.length));
  const t = para.get(0);
  if (rand(10) === 0 && t.length > 5) {
    t.delete(t.length - 1, 1); // backspace
  } else {
    const w = words[rand(words.length)];
    t.insert(rand(t.length + 1), w[rand(w.length)]);
  }
  if (k % saveEvery === 0) {
    // What sharedDoc.js records on a save: the etag and the saved text
    // (baseMd is only stored when it differs from the file text).
    const md = text(a);
    a.transact(() => {
      a.getMap('meta').set('etag', '"' + k + '"');
      a.getMap('meta').set('base', md);
    }, 'meta');
  }
}

const snapshot = Y.encodeStateAsUpdate(a).length;
const noteBytes = text(a).length;
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(JSON.stringify({ keystrokes, saveEvery, entries, seed: kb(seedBytes) }));
console.log(`note text now:          ${kb(noteBytes)}`);
console.log(`room log, no compaction: ${mb(logBytes)} in ${entries} updates`);
console.log(`snapshot after compaction: ${kb(snapshot)}`);
console.log(`with the server's compaction: peak room ${mb(peakRoom)}, ${compactions} compactions`);
console.log(`docs agree: ${text(a) === text(b)}`);
