import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { extractAudio } from '../downloader/main.mjs';
const run = promisify(execFile);
test('muxed video is converted to audio-only M4A by the Douyin extraction path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'liteplayer-extract-test-'));
  try {
    const input = join(directory, 'input.mp4'), output = join(directory, 'audio.m4a');
    await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', input], { windowsHide: true });
    await extractAudio(input, output);
    const bytes = await readFile(output); assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    const probe = await run(ffmpeg, ['-hide_banner', '-i', output, '-f', 'null', '-'], { windowsHide: true });
    assert.match(probe.stderr, /Audio: aac/); assert.doesNotMatch(probe.stderr, /Video:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
