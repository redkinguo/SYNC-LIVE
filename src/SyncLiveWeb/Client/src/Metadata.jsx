import React, { useEffect, useRef, useState } from 'react';

const platforms = [{ id: 'youtube', name: 'YouTube' }, { id: 'twitch', name: 'Twitch' }, { id: 'kick', name: 'Kick' }];
async function read(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
const post = (path, data) => read(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
export default function Metadata() {
  const [selected, setSelected] = useState('youtube');
  const [form, setForm] = useState({});
  const requestId = useRef(0);
  const [loading, setLoading] = useState(false);
  const [descriptions, setDescriptions] = useState({ youtube: '', twitch: '', kick: '' });
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState([]);
  const [notice, setNotice] = useState('');
  const load = async platform => {
    const id = ++requestId.current;
    setLoading(true); setForm({});
    try { const data = await read(`/api/metadata/${platform}`); if (id === requestId.current) setForm(data.metadata || {}); }
    catch (error) { if (id === requestId.current) { setNotice(error.message); setForm({}); } }
    finally { if (id === requestId.current) setLoading(false); }
  };
  useEffect(() => { void load(selected); void read('/api/metadata/descriptions').then(data => setDescriptions(data.descriptions || {})).catch(error => setNotice(error.message)); }, [selected]);
  const search = async () => { try { const data = await read(`/api/metadata/categories/${selected}?q=${encodeURIComponent(query)}`); setCategories(data.categories || []); } catch (error) { setNotice(error.message); } };
  const save = async () => { try { const result = await post(`/api/metadata/${selected}`, { ...form, tags: typeof form.tags === 'string' ? form.tags.split(',').map(x => x.trim()).filter(Boolean) : form.tags }); setNotice(result.detail || '更新しました'); await load(selected); } catch (error) { setNotice(error.message); } };
  const upload = async file => { if (!file) return; try { const result = await read('/api/metadata/youtube/thumbnail', { method: 'POST', headers: { 'content-type': file.type }, body: file }); setNotice(result.detail); } catch (error) { setNotice(error.message); } };
  const saveDescriptions = async () => { try { const data = await post('/api/metadata/descriptions', descriptions); setDescriptions(data.descriptions); setNotice(data.detail); } catch (error) { setNotice(error.message); } };
  const pinYouTube = async () => { try { const data = await post('/api/metadata/youtube/fix-current-description', {}); setNotice(data.detail); const next = await read('/api/metadata/descriptions'); setDescriptions(next.descriptions); } catch (error) { setNotice(error.message); } };
  const updateTwitchProfile = async () => { try { const data = await post('/api/metadata/twitch/description', { description: descriptions.twitch }); setNotice(data.detail); } catch (error) { setNotice(error.message); } };
  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  return <div style={{ maxWidth: 1040, margin: '30px auto', padding: 22 }}><a href="/">← ダッシュボード</a><h1>配信先ごとの詳細設定</h1><p>タイトル、カテゴリー、タグなどを各サービスのAPIで更新します。保存操作を押すまで外部サービスは変更されません。</p>{notice && <div className="demo-notice">{notice}</div>}
    <div className="chat-filters">{platforms.map(p => <button className={`filter ${selected === p.id ? 'active' : ''}`} onClick={() => { setSelected(p.id); setCategories([]); setQuery(''); }} key={p.id}>{p.name}</button>)}</div>
    <section className="card"><div className="card-head"><div className="card-title">{platforms.find(p => p.id === selected)?.name} の配信情報</div><button className="btn" onClick={() => load(selected)}>現在の情報を再取得</button></div><div className="card-content"><div className="field"><label>タイトル</label><input value={form.title || ''} onChange={event => set('title', event.target.value)} /></div>{selected === 'youtube' && <div className="field"><label>説明</label><textarea rows="6" value={form.description || ''} onChange={event => set('description', event.target.value)} /></div>}<div className="field"><label>カテゴリー</label><div className="compose-box"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="カテゴリー名を検索" /><button className="btn" onClick={search}>検索</button></div><select value={form.categoryId || ''} onChange={event => set('categoryId', event.target.value)}><option value="">カテゴリーを選択</option>{form.categoryId && !categories.some(c => String(c.id) === String(form.categoryId)) && <option value={form.categoryId}>{form.categoryName || form.categoryId}</option>}{categories.map(category => <option value={category.id} key={category.id}>{category.name}</option>)}</select></div><div className="field"><label>タグ（カンマ区切り）</label><input value={Array.isArray(form.tags) ? form.tags.join(', ') : form.tags || ''} onChange={event => set('tags', event.target.value)} /></div><button className="btn primary" disabled={loading || !form.title} onClick={save}>このサービスに反映</button>{selected === 'youtube' && <div className="field"><label>サムネイル（JPG/PNG、2MB以下）</label><input type="file" accept="image/jpeg,image/png" onChange={event => upload(event.target.files?.[0])} /></div>}</div></section>
    <section className="card" style={{ marginTop: 20 }}><div className="card-head"><div className="card-title">固定の説明文</div></div><div className="card-content">{platforms.map(p => <div className="field" key={p.id}><label>{p.name}</label><textarea rows="5" value={descriptions[p.id] || ''} onChange={event => setDescriptions(previous => ({ ...previous, [p.id]: event.target.value }))} /></div>)}<div className="modal-actions"><button className="btn primary" onClick={saveDescriptions}>このPCに保存</button><button className="btn" onClick={pinYouTube}>現在のYouTube説明を固定文にする</button><button className="btn" onClick={updateTwitchProfile}>Twitchプロフィール説明を更新</button></div><p><a href="/oauth/start/twitch?include=profile-description">Twitchプロフィール変更権限を追加する →</a></p><p>Kickのチャンネル説明は公開APIから変更できないため、保存した文を管理画面に貼り付けてください。</p></div></section>
  </div>;
}
