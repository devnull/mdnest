// Which notes are edited through a shared (Yjs) room. Kept apart from
// sharedText.js so the entry bundle can ask this without loading the shared
// editing chunk.
//
// Everything else keeps the whole-file path: drawings, chats and Marp decks
// are edited as raw text (or a canvas) and must keep their bytes exactly.
export function isSharedEligible({ path, isDrawing, isChat, isMarp }) {
  if (!path || !/\.md$/i.test(path)) return false;
  if (/\.excalidraw\.md$/i.test(path)) return false;
  return !isDrawing && !isChat && !isMarp;
}
