import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storefrontCandidates, guessStorefront } from '../../web/amp.mjs';
import { parseAppleLink } from '../../web/views/links.mjs';

test('regionless links probe normalized wrapper regions in order, falling back only without regions', async () => {
  assert.deepEqual(storefrontCandidates(['CA', 'jp', 'ca', '', 'USA', '12']), ['ca', 'jp']);
  assert.deepEqual(storefrontCandidates(['invalid']), ['cn', 'us', 'kr', 'jp', 'tw']);
  const calls = [];
  const resource = { type: 'songs', id: '123' };
  const catalog = async (path) => { calls.push(path.split('/')[3]); return { data: [{ id: '123' }] }; };
  assert.equal(await guessStorefront(resource, { catalog, status: async () => ({ regions: ['CA', 'JP', 'ca'] }) }), 'ca');
  assert.deepEqual(calls, ['ca', 'jp']);
  assert.equal(await guessStorefront(resource, { catalog, status: async () => { throw Error('offline'); } }), 'cn');
  assert.equal(await guessStorefront(resource, { catalog, status: async () => ({ regions: [] }) }), 'cn');
  assert.equal(await guessStorefront(resource, { catalog: async () => { throw Error('missing'); }, status: async () => ({ regions: ['ca'] }) }), null);
  assert.equal(parseAppleLink('https://music.apple.com/album/123?i=456'), 'https://music.apple.com/album/123?i=456');
  assert.equal(parseAppleLink('https://music.apple.com/song/name/123'), 'https://music.apple.com/song/name/123');
});
