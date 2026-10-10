export const MAX_BYTES = 80 * 1024 * 1024;
export const MAX_DURATION = 7200;
export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 900;

export function parseSource(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('仅支持抖音和 Bilibili 视频链接'); }
  if (typeof value !== 'string' || value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('无效的视频链接');
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
    const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
    const part = url.searchParams.get('p') ?? '1';
    if (!match || !/^[1-9]\d{0,3}$/.test(part)) throw new Error('请输入包含 BV 号的 Bilibili 视频链接');
    return { platform: 'bilibili', sourceId: `${match[1]}:p${part}`, url: `https://www.bilibili.com/video/${match[1]}?p=${part}` };
  }
  if (['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname)) {
    const id = /^\/(?:share\/)?video\/(\d{10,24})\/?$/.exec(url.pathname)?.[1]
      || (url.pathname === '/' ? url.searchParams.get('modal_id') : null);
    if (!/^\d{10,24}$/.test(id || '')) throw new Error('请输入抖音单个视频链接，不支持主页、图集或直播');
    return { platform: 'douyin', sourceId: `douyin:${id}`, url: `https://www.douyin.com/video/${id}` };
  }
  if (url.hostname === 'v.douyin.com' && /^\/[a-zA-Z0-9_-]{3,64}\/?$/.test(url.pathname)) {
    return { platform: 'douyin', sourceId: `douyin:short:${url.pathname.replaceAll('/', '')}`, url: `https://v.douyin.com${url.pathname}` };
  }
  throw new Error('仅支持抖音和 Bilibili 视频链接');
}

export async function resolveSource(value, fetcher = fetch) {
  let source = parseSource(value);
  for (let count = 0; source.sourceId.startsWith('douyin:short:'); count++) {
    if (count >= 5) throw new Error('抖音短链接跳转过多，请使用完整视频链接');
    const response = await fetcher(source.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) throw new Error('无法解析抖音短链接，请使用完整视频链接');
    const target = parseSource(new URL(location, source.url).href);
    if (target.platform !== 'douyin') throw new Error('抖音短链接指向了不支持的平台');
    source = target;
  }
  return source;
}

// A single byte range is enough for HTML audio seeking. Reject multipart ranges.
export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new Error('Invalid range');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('Invalid range');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) throw new Error('Invalid range');
    end = Math.min(end, size - 1);
  }
  return { offset: start, length: end - start + 1 };
}
