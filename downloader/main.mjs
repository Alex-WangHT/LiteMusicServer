import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { parseSource, MAX_BYTES, MAX_DURATION } from '../src/shared.mjs';

const base = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = process.env.DOWNLOADER_TOKEN;
const executable = process.env.YTDLP_PATH || 'yt-dlp';
const mime = { '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(path, options = {}, lease) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${token}`, ...(lease ? { 'X-Lease-Token': lease } : {}), ...options.headers }
  });
  if (!response.ok) throw new Error(`Worker ${response.status}: ${await response.text()}`);
  return response.json();
}
function run(args, command = executable, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      const text = chunk.toString();
      process.stdout.write(text);
      output = (output + text).slice(-6000);
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Media tool exit ${code}: ${output}`)));
  });
}
export async function extractAudio(input, output) {
  return run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output], process.env.FFMPEG_PATH || ffmpegStatic, 60000);
}
export async function processOne() {
  if (!token) throw new Error('缺少 DOWNLOADER_TOKEN，请配置 .env');
  const { job } = await api('/internal/jobs/claim', { method: 'POST' });
  if (!job) return null;
  console.log(`Processing ${job.id}: ${job.source_url}`);
  let directory;
  try {
    const source = parseSource(job.source_url);
    if (source.sourceId !== job.source_id || source.platform !== job.platform) throw new Error('任务来源不匹配');
    directory = await mkdtemp(join(tmpdir(), 'liteplayer-'));
    const common = [
      '--ignore-config', '--no-playlist', '--no-progress', '--no-colors', '--encoding', 'utf-8',
      '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '20', '--retries', '2',
      '--match-filters', `!is_live & duration<=${MAX_DURATION}`,
      ...(process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : []),
      ...(process.env.YTDLP_COOKIES_FILE ? ['--cookies', process.env.YTDLP_COOKIES_FILE] : [])
    ];
    // Save the title even if the subsequent media download fails.
    await run([...common, '--skip-download', '--write-info-json', '-o', join(directory, 'audio.%(ext)s'), '--', job.source_url]);
    const info = JSON.parse(await readFile(join(directory, 'audio.info.json'), 'utf8'));
    if (job.platform === 'douyin' && `douyin:${info.id}` !== job.source_id) throw new Error('视频 ID 不匹配');
    if (info.is_live || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION) throw new Error('不支持直播或超过两小时的视频');
    await api(`/internal/jobs/${job.id}/metadata`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: info.title, duration: info.duration })
    }, job.lease_token);
    await run([...common, '--load-info-json', join(directory, 'audio.info.json'),
      '-f', job.platform === 'douyin' ? 'bestaudio[ext=m4a]/bestaudio/best[acodec!=none]' : 'bestaudio[ext=m4a]/bestaudio', '--max-filesize', String(MAX_BYTES),
      '-o', join(directory, 'audio.%(ext)s')]);
    let files = (await readdir(directory)).filter(file => mime[extname(file)]);
    if (job.platform === 'douyin') {
      const inputs = (await readdir(directory)).filter(file => /^audio\./.test(file) && ['.mp4', '.mkv', ...Object.keys(mime)].includes(extname(file)));
      if (inputs.length !== 1) throw new Error('未生成可提取音轨的抖音媒体文件');
      await extractAudio(join(directory, inputs[0]), join(directory, 'extracted.m4a'));
      files = ['extracted.m4a'];
    }
    if (files.length !== 1) throw new Error('没有生成音频文件（可能超过 80 MiB 限制）');
    const file = join(directory, files[0]);
    const { size } = await stat(file);
    if (!size || size > MAX_BYTES) throw new Error('音频大小超限');
    await api(`/internal/jobs/${job.id}/audio`, {
      method: 'PUT', headers: { 'Content-Type': mime[extname(file)], 'Content-Length': String(size) },
      body: createReadStream(file), duplex: 'half'
    }, job.lease_token);
    console.log(`Ready ${job.id}: ${info.title} (${size} bytes)`);
    return { id: job.id, ok: true };
  } catch (error) {
    console.error(error.message);
    // Keep URLs, local paths and proxy credentials out of the public task error.
    let message = '音频下载失败，请检查下载服务日志后重试';
    if (/sign in|confirm you.re not a bot|login required|HTTP Error 412/i.test(error.message)) message = '视频平台要求登录或验证，当前下载环境无法访问该视频';
    else if (/timed out|timeout|unable to download webpage/i.test(error.message)) message = '连接视频平台失败，请检查下载服务网络或配置 YTDLP_PROXY';
    else if (/ENOENT/.test(error.message)) message = '未找到下载或音频提取工具，请检查 YTDLP_PATH / FFMPEG_PATH';
    try {
      await api(`/internal/jobs/${job.id}/fail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) }, job.lease_token);
    } catch (reportError) { console.error('Unable to report failure:', reportError.message); }
    return { id: job.id, ok: false, error: message };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--once')) {
    const result = await processOne();
    console.log(JSON.stringify(result));
    if (result?.ok === false) process.exitCode = 1;
  } else {
    console.log(`Downloader polling ${base}`);
    while (true) {
      try { await processOne(); } catch (error) { console.error(error.message); }
      await delay(Number(process.env.POLL_INTERVAL_MS) || 5000);
    }
  }
}
