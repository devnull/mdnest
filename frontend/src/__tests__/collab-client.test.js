// The live-typing message must always carry the LAST text typed. The throttle
// used to drop every call inside its 200 ms window with no trailing send, so
// the final keystrokes of a burst never reached anyone else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import CollabClient from '../collab.js';

function openClient() {
  const sent = [];
  const c = new CollabClient(() => {}, () => {});
  c.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} };
  return { c, sent };
}

describe('CollabClient.sendContent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.WebSocket = globalThis.WebSocket || { OPEN: 1 };
  });
  afterEach(() => vi.useRealTimers());

  it('sends the last text of a burst once the window closes', () => {
    const { c, sent } = openClient();
    c.sendContent('a');
    c.sendContent('ab');
    c.sendContent('abc');
    expect(sent.map((m) => m.content)).toEqual(['a']);
    vi.advanceTimersByTime(200);
    expect(sent.map((m) => m.content)).toEqual(['a', 'abc']);
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBe(2);
  });

  it('does not carry a pending send into the next note', () => {
    const { c, sent } = openClient();
    c.sendContent('old note');
    c.sendContent('old note, more');
    c.disconnect();
    c.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} };
    vi.advanceTimersByTime(1000);
    expect(sent.map((m) => m.content)).toEqual(['old note']);
  });
});
