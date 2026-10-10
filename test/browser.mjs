import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const report = JSON.parse(await readFile('test-results/video.json', 'utf8'));
assert.equal(report.video.status, 'ready');
const base = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  const ranges = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().includes(`/api/videos/${report.video.id}/audio`)) ranges.push(response.status());
  });
  await page.goto(process.env.WEB_URL || 'http://127.0.0.1:5173');
  await page.getByLabel('API 地址').fill(base);
  const key = process.env.USER_KEY || JSON.parse(await readFile(process.env.USER_KEY_FILE, 'utf8')).key;
  await page.getByLabel('用户密钥').fill(key);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const card = page.locator(`[data-id="${report.video.id}"]`);
  await card.locator('audio').waitFor();
  await card.getByRole('button', { name: '获取链接并播放' }).click();
  assert.equal(await card.locator('h3').textContent(), report.video.title);
  await page.waitForFunction(id => {
    const audio = document.querySelector(`[data-id="${id}"] audio`);
    return audio && Number.isFinite(audio.duration) && audio.readyState >= 2;
  }, report.video.id, { timeout: 30000 });
  const media = await card.locator('audio').evaluate(async audio => {
    await audio.play();
    return { duration: audio.duration, mime_supported: audio.canPlayType('audio/mp4') };
  });
  await page.waitForFunction(id => document.querySelector(`[data-id="${id}"] audio`).currentTime > 2, report.video.id);
  await card.locator('audio').evaluate(audio => { audio.currentTime = 1800; });
  await page.waitForFunction(id => {
    const audio = document.querySelector(`[data-id="${id}"] audio`);
    return audio.currentTime > 1802 && !audio.paused && !audio.seeking && !audio.error;
  }, report.video.id, { timeout: 30000 });
  const position = await card.locator('audio').evaluate(audio => ({ current_time: audio.currentTime, paused: audio.paused, error: audio.error?.message ?? null }));
  await card.locator('audio').evaluate(audio => audio.pause());
  assert.ok(Math.abs(media.duration - report.video.duration) < 2);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(ranges.includes(206), 'Browser should request byte ranges');
  await page.screenshot({ path: 'test-results/player.png', fullPage: true });
  const result = { tested_at: new Date().toISOString(), browser: browser.version(), title: report.video.title, ...media, ...position, audio_http_statuses: ranges, page_errors: errors };
  await writeFile('test-results/browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
