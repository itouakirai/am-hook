const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AmPlayer } = require('../src/ui/player.js');

test('Media Session uses one local artwork URL instead of the remote image', async () => {
  const original = { navigator: Object.getOwnPropertyDescriptor(global, 'navigator'), MediaMetadata: global.MediaMetadata, fetch: global.fetch };
  const session = { metadata: null };
  const requests = [];
  Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaSession: session } });
  global.MediaMetadata = class MediaMetadata {
    constructor(value) { Object.assign(this, value); }
  };
  global.fetch = async (url) => {
    requests.push(url);
    return { ok: true, blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }) };
  };

  const player = Object.create(AmPlayer.prototype);
  player.playToken = 1;
  player.current = { title: 'Test', artwork: 'https://example.com/600x600bb.jpg' };
  try {
    player.updateMediaSession();
    await new Promise(setImmediate);
    assert.deepEqual(requests, [player.current.artwork]);
    assert.match(session.metadata.artwork[0].src, /^blob:/);
    assert.equal(session.metadata.title, 'Test');
  } finally {
    if (player.mediaArtController) player.mediaArtController.abort();
    if (player.mediaArtUrl) URL.revokeObjectURL(player.mediaArtUrl);
    if (original.navigator) Object.defineProperty(global, 'navigator', original.navigator);
    else delete global.navigator;
    global.MediaMetadata = original.MediaMetadata;
    global.fetch = original.fetch;
  }
});
