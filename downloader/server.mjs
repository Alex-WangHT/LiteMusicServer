import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createJobServer({ token, processOne, onComplete, onError = console.error }) {
  if (!token) throw new Error('Missing DOWNLOADER_TOKEN');
  const expected = Buffer.from(`Bearer ${token}`);
  let started = false;
  return createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (path === '/health' && request.method === 'GET') return reply(200, { ok: true, started });
    if (path !== '/run' || request.method !== 'POST') return reply(404, { error: 'Not found' });
    const supplied = Buffer.from(request.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'Unauthorized' });
    if (started) return reply(202, { accepted: true, already_running: true });
    started = true;
    reply(202, { accepted: true });
    // Independent of request lifetime. The Linux process owns execution, not waitUntil.
    Promise.resolve().then(processOne).then(
      result => onComplete(null, result),
      error => { onError(error.message); onComplete(error); }
    ).catch(error => onError(error.message));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { processOne } = await import('./main.mjs');
  const watchdog = setTimeout(() => process.exit(1), 14 * 60 * 1000);
  const server = createJobServer({
    token: process.env.DOWNLOADER_TOKEN, processOne,
    onComplete: error => {
      clearTimeout(watchdog);
      // Task result is already persisted through Worker API before exiting.
      server.close();
      setTimeout(() => process.exit(error ? 1 : 0), 500);
    }
  });
  server.listen(8080, '0.0.0.0', () => console.log('Cloud downloader ready on port 8080'));
}
