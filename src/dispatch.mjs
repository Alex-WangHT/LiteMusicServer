// D1 is the durable queue. A wake-up is only a hint; Cron retries lost wake-ups.
export async function wakeDownloader(env) {
  if (!env.DOWNLOAD_CONTAINER || !env.DOWNLOADER_TOKEN) throw new Error('Missing cloud downloader bindings/secrets');
  const pending = await env.DB.prepare(`SELECT id FROM videos
    WHERE platform IN ('bilibili','douyin')
    AND ((status='queued' AND attempts<3) OR (status='processing' AND lease_until<=?))
    AND EXISTS (SELECT 1 FROM user_videos WHERE video_id=videos.id)
    LIMIT 1`).bind(Math.floor(Date.now() / 1000)).first();
  if (!pending) return { started: false };
  // All wake-ups go to one DO/container; the container also enforces one active job.
  const stub = env.DOWNLOAD_CONTAINER.getByName('audio-downloader');
  const response = await stub.fetch('http://container/run', {
    method: 'POST', headers: { Authorization: `Bearer ${env.DOWNLOADER_TOKEN}` },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`Container wake-up failed: ${response.status}`);
  await response.body?.cancel();
  return { started: true };
}
