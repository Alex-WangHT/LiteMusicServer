import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createJobServer } from '../downloader/server.mjs';
import { wakeDownloader } from '../src/dispatch.mjs';

test('container wake-up does not run work without auth and coalesces concurrent triggers', async () => {
  let release, calls = 0, complete;
  const done = new Promise(resolve => { complete = resolve; });
  const work = new Promise(resolve => { release = resolve; });
  const server = createJobServer({ token: 'test-secret', processOne: () => { calls++; return work; }, onComplete: (_, result) => complete(result) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/run', { method: 'POST' })).status, 401);
    assert.equal(calls, 0);
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(base + '/run', { method: 'POST', headers: { Authorization: 'Bearer test-secret' } })));
    assert.ok(responses.every(r => r.status === 202));
    await Promise.all(responses.map(r => r.text()));
    assert.equal(calls, 1);
    release({ ok: true }); assert.deepEqual(await done, { ok: true });
    assert.equal((await fetch(base + '/run', { method: 'POST', headers: { Authorization: 'Bearer test-secret' } })).status, 202);
    assert.equal(calls, 1, 'One job per container process; next process reclaims from D1');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('cloud scheduler stays asleep without queued jobs; wakes one named container with secret', async () => {
  let pending = null, wakes = 0;
  const env = {
    DOWNLOADER_TOKEN: 'test-secret',
    DB: { prepare(sql) { assert.match(sql, /user_videos/); return { bind() { return { first: async () => pending }; } }; } },
    DOWNLOAD_CONTAINER: { getByName(name) {
      assert.equal(name, 'audio-downloader');
      return { fetch: async (url, options) => { wakes++; assert.equal(url, 'http://container/run'); assert.equal(options.headers.Authorization, 'Bearer test-secret'); return Response.json({ accepted: true }, { status: 202 }); } };
    } }
  };
  assert.deepEqual(await wakeDownloader(env), { started: false }); assert.equal(wakes, 0);
  pending = { id: 'queued-id' };
  assert.deepEqual(await wakeDownloader(env), { started: true }); assert.equal(wakes, 1);
});
