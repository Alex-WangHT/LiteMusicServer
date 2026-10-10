import { Container } from '@cloudflare/containers';
import api from './worker.mjs';
import { wakeDownloader } from './dispatch.mjs';

export class DownloadContainer extends Container {
  defaultPort = 8080;
  // Safety backstop, not an always-on daemon. Process exits after each task.
  sleepAfter = '15m';
  enableInternet = true;
  constructor(ctx, env) {
    super(ctx, env);
    const url = new URL(env.WORKER_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname.endsWith('.invalid')) throw new Error('Configure WORKER_URL to the deployed HTTPS API origin');
    if (!env.DOWNLOADER_TOKEN) throw new Error('Configure DOWNLOADER_TOKEN');
    this.envVars = {
      WORKER_URL: url.origin,
      DOWNLOADER_TOKEN: env.DOWNLOADER_TOKEN,
      YTDLP_PATH: '/opt/yt-dlp/bin/yt-dlp',
      FFMPEG_PATH: '/usr/bin/ffmpeg',
      NODE_ENV: 'production'
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const response = await api.fetch(request, env, ctx);
    const path = new URL(request.url).pathname;
    if (response.ok && request.method === 'POST' && (path === '/api/videos' || /^\/api\/videos\/[\w-]+\/retry$/.test(path))) {
      ctx.waitUntil(wakeDownloader(env).catch(error => console.error('Downloader wake deferred to Cron:', error.message)));
    }
    return response;
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(wakeDownloader(env));
  }
};
