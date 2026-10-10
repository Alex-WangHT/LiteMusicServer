import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, resolveSource, byteRange } from '../src/shared.mjs';
test('Bilibili canonicalization, tracking removal and separate multipart identities', () => {
  assert.deepEqual(parseSource('https://www.bilibili.com/video/BV1EAYszPEP9/?spm_id_from=abc'), { platform: 'bilibili', sourceId: 'BV1EAYszPEP9:p1', url: 'https://www.bilibili.com/video/BV1EAYszPEP9?p=1' });
  assert.equal(parseSource('https://m.bilibili.com/video/BV1EAYszPEP9?p=2').sourceId, 'BV1EAYszPEP9:p2');
  for (const url of ['https://bilibili.com.evil.test/video/BV1EAYszPEP9', 'https://www.bilibili.com/video/BV1EAYszPEP9?p=0', 'https://www.bilibili.com/video/BV1EAYszPEP9?p=abc', 'https://live.bilibili.com/1234']) assert.throws(() => parseSource(url));
});
test('only accepts Douyin/Bilibili and canonicalizes Douyin video identities', () => {
  const expected = { platform: 'douyin', sourceId: 'douyin:7380000000000000000', url: 'https://www.douyin.com/video/7380000000000000000' };
  for (const url of ['https://www.douyin.com/video/7380000000000000000?foo=bar', 'https://www.iesdouyin.com/share/video/7380000000000000000/', 'https://www.douyin.com/?modal_id=7380000000000000000']) assert.deepEqual(parseSource(url), expected);
  for (const url of ['https://youtube.com/watch?v=u5NiDaaq-XM', 'https://youtu.be/u5NiDaaq-XM', 'https://tiktok.com/@x/video/7380000000000000000', 'https://www.douyin.com.evil.test/video/7380000000000000000', 'https://www.douyin.com/user/123', 'https://live.douyin.com/123', 'file:///etc/passwd', 'https://localhost/video/123', 'https://evil@www.douyin.com/video/7380000000000000000', null]) assert.throws(() => parseSource(url));
});
test('Douyin short links resolve only to permitted video destinations', async () => {
  const result = await resolveSource('https://v.douyin.com/abc123/', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://www.iesdouyin.com/share/video/7380000000000000000/' } });
  });
  assert.equal(result.sourceId, 'douyin:7380000000000000000');
  for (const target of ['http://127.0.0.1/private', 'https://www.youtube.com/watch?v=u5NiDaaq-XM', 'https://www.bilibili.com/video/BV1EAYszPEP9']) {
    let calls = 0;
    await assert.rejects(resolveSource('https://v.douyin.com/abc123/', async () => { calls++; return new Response(null, { status: 302, headers: { Location: target } }); }));
    assert.equal(calls, 1, 'Must reject before requesting unsupported destination');
  }
  await assert.rejects(resolveSource('https://v.douyin.com/abc123/', async () => new Response(null, { status: 302, headers: { Location: '/abc123/' } })), /跳转过多/);
});
test('byte ranges support seeking, suffixes, open ends and bounds', () => {
  assert.equal(byteRange(null, 100), null);
  assert.deepEqual(byteRange('bytes=0-0', 100), { offset: 0, length: 1 });
  assert.deepEqual(byteRange('bytes=90-', 100), { offset: 90, length: 10 });
  assert.deepEqual(byteRange('bytes=-10', 100), { offset: 90, length: 10 });
  assert.deepEqual(byteRange('bytes=90-999', 100), { offset: 90, length: 10 });
  for (const value of ['bytes=100-', 'bytes=-0', 'bytes=9-1', 'bytes=0-1,3-4', 'bytes=-', 'items=0-1']) assert.throws(() => byteRange(value, 100));
});
