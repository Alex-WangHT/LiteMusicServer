import { writeFile } from 'node:fs/promises';
const base = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const response = await fetch(`${base}/api/admin/users`, {
  method: 'POST', headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: process.argv.find(arg => arg.startsWith('--name='))?.slice(7) || '个人音频库', import_existing: process.argv.includes('--import-existing') })
});
if (!response.ok) throw new Error(await response.text());
const data = await response.json();
// The only plaintext copy is deliberately kept in a user-controlled local file.
const file = `.user-${data.user.id}.json`;
await writeFile(file, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`User created: ${data.user.id}\nKey saved once to ${file}; keep it private.`);
