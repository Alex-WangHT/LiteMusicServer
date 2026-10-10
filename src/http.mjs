export const now = () => Math.floor(Date.now() / 1000);
export const json = (data, status = 200) => Response.json(data, { status });
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '缺少 JSON 请求体');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new HttpError(413, '请求过大'); }
    chunks.push(value);
  }
  try {
    const data = JSON.parse(await new Blob(chunks).text());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new HttpError(400, '无效的 JSON 对象'); }
}
export const bearer = request => /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1];
export const randomKey = () => 'lp_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function requireToken(request, expected) {
  if (!expected) throw new HttpError(503, '服务尚未配置认证密钥');
  if (await hash(bearer(request) || '') !== await hash(expected)) throw new HttpError(401, 'Unauthorized');
}
export async function userFor(request, env) {
  const key = bearer(request);
  if (!key || key.length > 256) throw new HttpError(401, '缺少用户密钥');
  const user = await env.DB.prepare('SELECT * FROM users WHERE key_hash=?').bind(await hash(key)).first();
  if (!user) throw new HttpError(401, '用户密钥无效或已轮换');
  return user;
}
