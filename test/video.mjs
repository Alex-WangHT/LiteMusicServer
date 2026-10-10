import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { processOne } from '../downloader/main.mjs';
const base = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const key = process.env.USER_KEY || JSON.parse(await (await import('node:fs/promises')).readFile(process.env.USER_KEY_FILE, 'utf8')).key;
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const source = process.argv[2] || 'https://www.bilibili.com/video/BV1EAYszPEP9';
const response = await fetch(`${base}/api/videos`, { method: 'POST', headers, body: JSON.stringify({ url: source }) });
assert.ok(response.ok, await response.clone().text());
let video = await response.json();
if (video.status === 'failed') {
  const retry = await fetch(`${base}/api/videos/${video.id}/retry`, { method: 'POST', headers });
  assert.ok(retry.ok); video.status = 'queued';
}
if (video.status !== 'ready') {
  const result = await processOne();
  assert.equal(result?.id, video.id, 'Run with no other queued jobs');
}
video = await (await fetch(`${base}/api/videos/${video.id}`, { headers })).json();
await mkdir('test-results', { recursive: true });
const result = { tested_at: new Date().toISOString(), video };
if (video.status === 'ready') {
  video.audio_url = (await (await fetch(`${base}/api/videos/${video.id}/playback`, { method: 'POST', headers })).json()).audio_url;
  const head = await fetch(video.audio_url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), video.size);
  const range = await fetch(video.audio_url, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206);
  const first = Buffer.from(await range.arrayBuffer());
  assert.equal(first.length, 1024);
  if (video.content_type === 'audio/mp4') assert.equal(first.toString('ascii', 4, 8), 'ftyp');
  else if (video.content_type === 'audio/webm') assert.equal(first.subarray(0, 4).toString('hex'), '1a45dfa3');
  const full = await fetch(video.audio_url);
  assert.equal(full.status, 200);
  const data = Buffer.from(await full.arrayBuffer());
  assert.equal(data.length, video.size);
  const file = `test-results/${video.source_id.replace(/[^\w-]/g, '_')}.${video.content_type === 'audio/mp4' ? 'm4a' : 'webm'}`;
  await writeFile(file, data);
  result.checks = { head: head.status, range: range.status, content_range: range.headers.get('content-range'), full_download_bytes: data.length, local_audio: file };
}
await writeFile('test-results/video.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (video.status !== 'ready') process.exitCode = 1;
