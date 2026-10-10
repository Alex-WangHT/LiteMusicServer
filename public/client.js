const $ = id => document.getElementById(id);
let connection = null, generation = 0;
const say = text => { $('message').textContent = text; };
const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
const button = (text, action) => { const b = node('button', text); b.type = 'button'; b.className = 'secondary'; b.onclick = () => Promise.resolve().then(action).catch(e => say(e.message)); return b; };
async function api(path, method = 'GET', data) {
  const c = connection; if (!c) throw new Error('请先连接');
  const r = await fetch(c.base + path, { method, headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await r.json(); if (c !== connection) throw new Error('连接已更改');
  if (!r.ok) throw new Error(result.error || r.status); return result;
}
function reset() { connection = null; generation++; $('library').replaceChildren(); $('playlists').replaceChildren(); $('identity').textContent = '未连接'; $('new-key').value = ''; $('new-key').hidden = true; }
async function refresh() {
  const g = ++generation;
  const [{ videos }, { playlists }] = await Promise.all([api('/api/videos'), api('/api/playlists')]);
  if (g !== generation) return;
  const ids = new Set(videos.map(v => v.id));
  for (const card of [...$('library').children]) if (!ids.has(card.dataset.id)) card.remove();
  for (const v of videos) {
    const old = $('library').querySelector(`[data-id="${v.id}"]`), signature = JSON.stringify(v);
    if (old?.dataset.signature === signature) continue;
    const card = node('article'); card.className = 'card'; card.dataset.id = v.id; card.dataset.signature = signature;
    card.append(node('h3', v.title || v.source_id), node('p', v.status + (v.error ? `: ${v.error}` : '')));
    if (v.status === 'ready') {
      const audio = node('audio'); audio.controls = true; audio.preload = 'metadata';
      audio.onerror = () => say(`播放失败：${audio.error?.message || '请重新获取链接'}`);
      card.append(audio, button('获取链接并播放', async () => { const t = await api(`/api/videos/${v.id}/playback`, 'POST'); audio.src = t.audio_url; await audio.play(); }));
    }
    card.append(button('加入歌单', async () => { const id = prompt('歌单 ID（见下方）'); if (!id) return; const p = await api(`/api/playlists/${id}`); await api(`/api/playlists/${id}/items`, 'PUT', { video_ids: [...new Set([...p.videos.map(v => v.id), v.id])] }); await refresh(); }), button('移出音频库', async () => { if (confirm('从自己的音频库和歌单移除？')) { await api(`/api/videos/${v.id}`, 'DELETE'); await refresh(); } }));
    if (v.status === 'failed') card.append(button('重试', async () => { await api(`/api/videos/${v.id}/retry`, 'POST'); await refresh(); }));
    if (old) old.replaceWith(card); else $('library').append(card);
  }
  const cards = [];
  for (const item of playlists) {
    const p = await api(`/api/playlists/${item.id}`), card = node('article'); card.className = 'card';
    card.append(node('h3', p.name), node('p', p.id), button('重命名', async () => { const name = prompt('歌单名称', p.name); if (name) { await api(`/api/playlists/${p.id}`, 'PATCH', { name }); await refresh(); } }), button('删除歌单', async () => { if (confirm('删除歌单？')) { await api(`/api/playlists/${p.id}`, 'DELETE'); await refresh(); } }));
    for (const [i, v] of p.videos.entries()) {
      const line = node('div'); line.className = 'actions'; line.append(node('span', `${i + 1}. ${v.title || v.source_id}`));
      const edit = async direction => { const ids = p.videos.map(v => v.id); if (!direction) ids.splice(i, 1); else { const j = i + direction; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; } await api(`/api/playlists/${p.id}/items`, 'PUT', { video_ids: ids }); await refresh(); };
      line.append(button('↑', () => edit(-1)), button('↓', () => edit(1)), button('移除', () => edit(0))); card.append(line);
    }
    cards.push(card);
  }
  if (g === generation) $('playlists').replaceChildren(...cards);
}
$('connect').onclick = async () => { reset(); try { const url = new URL($('api-base').value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址无效'); connection = { base: url.origin, key: $('token').value.trim() }; const me = await api('/api/me'); $('identity').textContent = `${me.name} · ${me.id}`; await refresh(); say('连接成功'); } catch (e) { reset(); say(e.message); } };
$('logout').onclick = () => { reset(); $('token').value = ''; say('已清除本页身份；密钥仍有效。撤销旧密钥请使用轮换。'); };
$('rotate').onclick = async () => { if (!connection || !confirm('旧密钥和旧播放链接将失效，请保存返回的新密钥。')) return; try { const { key } = await api('/api/me/key', 'POST'); connection = { ...connection, key }; $('token').value = key; $('new-key').value = key; $('new-key').hidden = false; $('library').replaceChildren(); await refresh(); say('请保存新密钥，仅返回一次。'); } catch (e) { say(e.message); } };
$('form').onsubmit = async e => { e.preventDefault(); try { await api('/api/videos', 'POST', { url: $('url').value }); await refresh(); } catch (e) { say(e.message); } };
$('playlist-form').onsubmit = async e => { e.preventDefault(); try { await api('/api/playlists', 'POST', { name: $('playlist-name').value }); await refresh(); } catch (e) { say(e.message); } };
$('refresh').onclick = () => refresh().catch(e => say(e.message));
setInterval(() => { if (connection) refresh().catch(e => say(e.message)); }, 10000);
