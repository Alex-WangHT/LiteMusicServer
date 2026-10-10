import { byteRange, MAX_BYTES, MAX_DURATION, MAX_ATTEMPTS, LEASE_SECONDS } from './shared.mjs';
import { library } from './library.mjs';
import { now, json, HttpError, requireToken, readJson } from './http.mjs';

async function ownedJob(request, env, id) {
  const token = request.headers.get('X-Lease-Token');
  const row = await env.DB.prepare("SELECT * FROM videos WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?").bind(id, token ?? '', now()).first();
  if (!row) throw new HttpError(409, '任务租约已失效');
  return row;
}

async function audio(request, env, row) {
  if (row.status !== 'ready') throw new HttpError(409, '音频尚未就绪');
  const object = await env.AUDIO.head(row.audio_key);
  if (!object) throw new HttpError(404, '音频文件不存在');
  const headers = new Headers({
    'Content-Type': row.content_type,
    'Accept-Ranges': 'bytes',
    'ETag': object.httpEtag,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline',
    'Last-Modified': object.uploaded.toUTCString()
  });
  if (request.headers.get('If-None-Match') === object.httpEtag) return new Response(null, { status: 304, headers });
  let range = null;
  const ifRange = request.headers.get('If-Range');
  try {
    if (!ifRange || ifRange === object.httpEtag || ifRange === headers.get('Last-Modified')) range = byteRange(request.headers.get('Range'), object.size);
  } catch {
    headers.set('Content-Range', `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Length', String(range?.length ?? object.size));
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const body = await env.AUDIO.get(row.audio_key, range ? { range } : undefined);
  if (!body) throw new HttpError(404, '音频文件不存在');
  return new Response(body.body, { status: range ? 206 : 200, headers });
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (path === '/health') return json({ ok: true });
  if (path.startsWith('/internal/')) {
    await requireToken(request, env.DOWNLOADER_TOKEN);
    if (path === '/internal/jobs/claim' && request.method === 'POST') {
      const time = now();
      await env.DB.prepare("UPDATE videos SET status='failed', error='任务超过最大重试次数', lease_token=NULL, lease_until=NULL, updated_at=? WHERE status='processing' AND lease_until<=? AND attempts>=?").bind(time, time, MAX_ATTEMPTS).run();
      // One atomic UPDATE avoids two downloaders claiming the same job.
      const job = await env.DB.prepare(`UPDATE videos SET status='processing', attempts=attempts+1, lease_token=?, lease_until=?, updated_at=?, error=NULL
        WHERE id=(SELECT id FROM videos WHERE platform IN ('bilibili','douyin') AND (status='queued' OR (status='processing' AND lease_until<=?)) AND attempts<? AND EXISTS (SELECT 1 FROM user_videos WHERE video_id=videos.id) ORDER BY created_at LIMIT 1)
        RETURNING *`).bind(crypto.randomUUID(), time + LEASE_SECONDS, time, time, MAX_ATTEMPTS).first();
      return json({ job });
    }
    const match = /^\/internal\/jobs\/([\w-]+)\/(metadata|audio|fail)$/.exec(path);
    if (!match) throw new HttpError(404, 'Not found');
    const [, id, action] = match;
    const row = await ownedJob(request, env, id);
    if (action === 'metadata' && request.method === 'POST') {
      const data = await readJson(request);
      if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 2000 || !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > MAX_DURATION) throw new HttpError(400, '标题或时长无效（最长两小时）');
      await env.DB.prepare('UPDATE videos SET title=?, duration=?, updated_at=? WHERE id=? AND lease_token=?').bind(data.title, data.duration, now(), id, row.lease_token).run();
      return json({ ok: true });
    }
    if (action === 'fail' && request.method === 'POST') {
      const data = await readJson(request);
      const message = String(data.error ?? '下载失败').slice(0, 2000);
      await env.DB.prepare("UPDATE videos SET status='failed', error=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_token=?").bind(message, now(), id, row.lease_token).run();
      return json({ ok: true });
    }
    if (action === 'audio' && request.method === 'PUT') {
      const type = request.headers.get('Content-Type');
      const length = Number(request.headers.get('Content-Length'));
      if (!['audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/ogg'].includes(type)) throw new HttpError(415, '不支持的音频格式');
      if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BYTES) throw new HttpError(413, '音频大小必须为 1–80 MiB');
      if (!row.title) throw new HttpError(409, '请先保存音频元数据');
      const key = `audio/${id}/${row.lease_token}`;
      let count = 0;
      const limited = request.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > length || count > MAX_BYTES) throw new Error('上传超过大小限制');
        controller.enqueue(chunk);
      }}));
      // R2 needs a known-length stream; FixedLengthStream also rejects short uploads.
      const fixed = new FixedLengthStream(length);
      const pumping = limited.pipeTo(fixed.writable);
      const uploading = env.AUDIO.put(key, fixed.readable, { httpMetadata: { contentType: type } });
      await Promise.all([pumping, uploading]);
      const result = await env.DB.prepare("UPDATE videos SET status='ready', audio_key=?, content_type=?, size=?, error=NULL, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?").bind(key, type, length, now(), id, row.lease_token, now()).run();
      if (!result.meta.changes) {
        await env.AUDIO.delete(key);
        throw new HttpError(409, '上传期间任务租约已失效');
      }
      return json({ ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (path.startsWith('/api/')) return library(request, env, audio);
  throw new HttpError(404, 'Audio API only; open the separate verification client');
}

export default {
  async fetch(request, env) {
    let response;
    try { response = await route(request, env); }
    catch (error) {
      if (!error.status) console.error(error);
      response = json({ error: error.status ? error.message : '服务内部错误' }, error.status ?? 500);
    }
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, If-Range, If-None-Match, X-Lease-Token');
    headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length, ETag');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
};
