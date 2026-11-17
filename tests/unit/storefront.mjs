import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseStorefront } from '../../web/amp.mjs';
import { parseAppleLink } from '../../web/views/links.mjs';

test('regionless links prefer valid online storefronts then candidate order', () => {
  assert.equal(chooseStorefront(['cn', 'jp', 'us'], ['JP', 'US']), 'us');
  assert.equal(chooseStorefront(['jp', 'cn'], ['US']), 'cn');
  assert.equal(chooseStorefront(['tw']), 'tw');
  assert.equal(chooseStorefront([]), null);
  assert.equal(parseAppleLink('https://music.apple.com/album/123?i=456'), 'https://music.apple.com/album/123?i=456');
  assert.equal(parseAppleLink('https://music.apple.com/song/name/123'), 'https://music.apple.com/song/name/123');
});
