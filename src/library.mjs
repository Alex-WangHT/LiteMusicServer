import { parseSource, resolveSource } from './shared.mjs';
import { now, json, HttpError, readJson, randomKey, hash, requireToken, userFor } from './http.mjs';
function named(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new HttpError(400, '名称需为 1–100 个字符');
  return value.trim();
}
function view(row, origin) {
  const { lease_token, lease_until, audio_key, ...data } = row;
  return { ...data, audio_url: row.status === 'ready' ? `${origin}/api/videos/${row.id}/audio` : null };
}
async function owned(env, userId, videoId) {
  const row = await env.DB.prepare('SELECT v.* FROM videos v JOIN user_videos uv ON uv.video_id=v.id WHERE uv.user_id=? AND v.id=?').bind(userId, videoId).first();
  if (!row) throw new HttpError(404, '音频不存在');
  return row;
}
export async function library(request, env, audio) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/api/admin/users' && method === 'POST') {
    await requireToken(request, env.ADMIN_TOKEN);
    const data = await readJson(request), name = named(data.name);
    const key = randomKey(), id = crypto.randomUUID();
    const statements = [env.DB.prepare('INSERT INTO users(id,name,key_hash,created_at) VALUES(?,?,?,?)').bind(id, name, await hash(key), now())];
    // Legacy unowned media is only imported at the administrator's explicit request.
    if (data.import_existing === true) statements.push(env.DB.prepare('INSERT INTO user_videos(user_id,video_id,added_at) SELECT ?,id,? FROM videos WHERE NOT EXISTS (SELECT 1 FROM user_videos WHERE video_id=videos.id)').bind(id, now()));
    await env.DB.batch(statements);
    return json({ user: { id, name }, key }, 201);
  }
  const audioMatch = /^\/api\/videos\/([\w-]+)\/audio$/.exec(path);
  if (audioMatch && ['GET', 'HEAD'].includes(method) && url.searchParams.has('ticket')) {
    const ticket = url.searchParams.get('ticket');
    if (ticket.length > 256) throw new HttpError(401, '播放凭证无效');
    const row = await env.DB.prepare(`SELECT v.* FROM playback_tickets t
      JOIN users u ON u.id=t.user_id AND u.key_version=t.key_version
      JOIN user_videos uv ON uv.user_id=t.user_id AND uv.video_id=t.video_id
      JOIN videos v ON v.id=t.video_id
      WHERE t.token_hash=? AND t.video_id=? AND t.expires_at>?`).bind(await hash(ticket), audioMatch[1], now()).first();
    if (!row) throw new HttpError(401, '播放链接过期或已撤销');
    return audio(request, env, row);
  }
  const user = await userFor(request, env);
  if (path === '/api/me' && method === 'GET') return json({ id: user.id, name: user.name, created_at: user.created_at });
  if (path === '/api/me/key' && method === 'POST') {
    const key = randomKey();
    const changed = await env.DB.prepare('UPDATE users SET key_hash=?,key_version=key_version+1 WHERE id=? AND key_hash=? RETURNING id').bind(await hash(key), user.id, user.key_hash).first();
    if (!changed) throw new HttpError(409, '密钥已轮换，请使用新密钥');
    return json({ key, user_id: user.id });
  }
  if (path === '/api/videos') {
    if (method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '无效的 offset');
      const rows = await env.DB.prepare('SELECT v.*,uv.added_at FROM videos v JOIN user_videos uv ON uv.video_id=v.id WHERE uv.user_id=? ORDER BY uv.added_at DESC,v.id LIMIT 100 OFFSET ?').bind(user.id, offset).all();
      return json({ videos: rows.results.map(row => view(row, url.origin)), next_offset: rows.results.length === 100 ? offset + 100 : null });
    }
    if (method === 'POST') {
      const data = await readJson(request); let source;
      try { source = await resolveSource(data.url); } catch (error) { throw new HttpError(400, error.message); }
      await env.DB.batch([
        env.DB.prepare('INSERT INTO videos(id,source_id,platform,source_url,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO NOTHING').bind(crypto.randomUUID(), source.sourceId, source.platform, source.url, now(), now()),
        env.DB.prepare('INSERT INTO user_videos(user_id,video_id,added_at) SELECT ?,id,? FROM videos WHERE source_id=? ON CONFLICT(user_id,video_id) DO NOTHING').bind(user.id, now(), source.sourceId)
      ]);
      const row = await env.DB.prepare('SELECT * FROM videos WHERE source_id=?').bind(source.sourceId).first();
      return json(view(row, url.origin), row.status === 'ready' ? 200 : 202);
    }
  }
  const vm = /^\/api\/videos\/([\w-]+)(?:\/(audio|retry|playback))?$/.exec(path);
  if (vm) {
    const [, id, action] = vm, row = await owned(env, user.id, id);
    if (!action && method === 'GET') return json(view(row, url.origin));
    if (!action && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM user_videos WHERE user_id=? AND video_id=?').bind(user.id, id).run();
      return json({ ok: true });
    }
    if (action === 'audio' && ['GET', 'HEAD'].includes(method)) return audio(request, env, row);
    if (action === 'playback' && method === 'POST') {
      if (row.status !== 'ready') throw new HttpError(409, '音频尚未就绪');
      const ticket = randomKey(), expires = now() + 3600;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM playback_tickets WHERE expires_at<=?').bind(now()),
        env.DB.prepare('INSERT INTO playback_tickets(token_hash,user_id,video_id,key_version,expires_at) VALUES(?,?,?,?,?)').bind(await hash(ticket), user.id, id, user.key_version, expires)
      ]);
      return json({ audio_url: `${url.origin}/api/videos/${id}/audio?ticket=${ticket}`, expires_at: expires });
    }
    if (action === 'retry' && method === 'POST') {
      try { parseSource(row.source_url); } catch { throw new HttpError(400, '仅支持重试抖音和 Bilibili 视频'); }
      const result = await env.DB.prepare("UPDATE videos SET status='queued',attempts=0,error=NULL,updated_at=? WHERE id=? AND status='failed'").bind(now(), id).run();
      if (!result.meta.changes) throw new HttpError(409, '只能重试失败任务');
      return json({ ok: true });
    }
  }
  if (path === '/api/playlists') {
    if (method === 'GET') return json({ playlists: (await env.DB.prepare('SELECT id,name,created_at FROM playlists WHERE user_id=? ORDER BY created_at,id').bind(user.id).all()).results });
    if (method === 'POST') {
      const name = named((await readJson(request)).name), id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO playlists(id,user_id,name,created_at) VALUES(?,?,?,?)').bind(id, user.id, name, now()).run();
      return json({ id, name }, 201);
    }
  }
  const pm = /^\/api\/playlists\/([\w-]+)(?:\/(items))?$/.exec(path);
  if (pm) {
    const [, id, action] = pm;
    const playlist = await env.DB.prepare('SELECT id,name,created_at FROM playlists WHERE id=? AND user_id=?').bind(id, user.id).first();
    if (!playlist) throw new HttpError(404, '歌单不存在');
    if (!action && method === 'GET') {
      const rows = await env.DB.prepare('SELECT v.*,i.position FROM playlist_items i JOIN videos v ON v.id=i.video_id WHERE i.playlist_id=? AND i.user_id=? ORDER BY i.position').bind(id, user.id).all();
      return json({ ...playlist, videos: rows.results.map(row => view(row, url.origin)) });
    }
    if (!action && method === 'PATCH') {
      const name = named((await readJson(request)).name);
      await env.DB.prepare('UPDATE playlists SET name=? WHERE id=? AND user_id=?').bind(name, id, user.id).run();
      return json({ id, name });
    }
    if (!action && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM playlists WHERE id=? AND user_id=?').bind(id, user.id).run();
      return json({ ok: true });
    }
    if (action === 'items' && method === 'PUT') {
      const { video_ids: ids } = await readJson(request);
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) || new Set(ids).size !== ids.length) throw new HttpError(400, 'video_ids 必须为最多 100 个不重复音频 ID');
      const membership = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_videos WHERE user_id=? AND video_id IN (SELECT value FROM json_each(?))').bind(user.id, JSON.stringify(ids)).first();
      if (membership.n !== ids.length) throw new HttpError(404, '音频不存在');
      // Transactional replacement is the add/remove/reorder API; foreign keys enforce membership.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM playlist_items WHERE playlist_id=? AND user_id=?').bind(id, user.id),
        ...ids.map((videoId, position) => env.DB.prepare('INSERT INTO playlist_items(playlist_id,user_id,video_id,position) VALUES(?,?,?,?)').bind(id, user.id, videoId, position))
      ]);
      return json({ ok: true, video_ids: ids });
    }
  }
  throw new HttpError(404, 'API route not found');
}
