const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const source = fs.readFileSync('src/ui/mv-hls.mjs', 'utf8');
  const { attributes, mvLink, parseMaster, recommendedAudio, parseMedia } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(mvLink('https://music.apple.com/cn/music-video/title/1794822079').id, '1794822079');
  assert.equal(mvLink('https://music.apple.com.evil.test/cn/music-video/title/123'), null);
  assert.equal(mvLink('https://music.apple.com/cn/song/title/123'), null);
  assert.deepEqual(attributes('CODECS="avc1.123,mp4a.40.2",BANDWIDTH=123'), { CODECS: 'avc1.123,mp4a.40.2', BANDWIDTH: '123' });
  const base = 'https://example.test/path/master.m3u8?token=1';
  const master = parseMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="A",DEFAULT=NO,URI="a.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="B",DEFAULT=YES,URI="b.m3u8"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",LANGUAGE="en",INSTREAM-ID="CC1"
#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360,CODECS="avc1.1,mp4a.40.2",AUDIO="aac"
low.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=900,URI="ignored.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1920x1080,CODECS="avc1.2,mp4a.40.2",AUDIO="aac"
high.m3u8`, base);
  assert.equal(master.videos[0].BANDWIDTH, '200');
  assert.equal(master.videos.length, 2);
  assert.equal(recommendedAudio(master.videos[0], master.audios).NAME, 'B');
  assert.equal(master.audios[0].codec, 'mp4a.40.2');
  assert.equal(master.captions[0]['INSTREAM-ID'], 'CC1');
  assert.equal(master.captions[0].LANGUAGE, 'en');
  const playlist = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.microsoft.playready",URI="data:;base64,AAAA"
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="other",URI="ignore"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
#EXT-X-BYTERANGE:10@100
media.mp4
#EXTINF:3,
#EXT-X-BYTERANGE:20
media.mp4
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.microsoft.playready",URI="data:;base64,BBBB"
#EXTINF:4,
next.m4s
#EXT-X-ENDLIST`;
  const media = parseMedia(playlist, base);
  assert.deepEqual(media.segments.map(s => s.start), [0, 2, 5]);
  assert.equal(media.duration, 9);
  assert.deepEqual(media.segments[1].range, { offset: 110, length: 20 });
  assert.equal(media.segments[0].key, 'data:;base64,AAAA');
  assert.equal(media.segments[2].key, 'data:;base64,BBBB');
  assert.equal(media.init.url, 'https://example.test/path/init.mp4');
  assert.throws(() => parseMedia(playlist.replace('#EXT-X-ENDLIST', ''), base), /completed/);
  assert.throws(() => parseMedia(playlist.replace('20\nmedia.mp4', '20\nother.mp4'), base), /offset/);
  assert.throws(() => parseMedia(playlist.replace('#EXTINF:4,', '#EXT-X-DISCONTINUITY\n#EXTINF:4,'), base), /Discontinuous/);
  console.log('MV HLS: link validation, variants, defaults, key rotation, byte ranges and malformed input passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
