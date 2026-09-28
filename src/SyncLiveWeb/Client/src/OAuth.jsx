import React, { useEffect, useState } from 'react';

const names = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };
async function json(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
export default function OAuth() {
  const [status, setStatus] = useState({});
  const [clients, setClients] = useState({});
  const [broadcasts, setBroadcasts] = useState([]);
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const reload = async () => { try { setStatus(await json('/api/oauth/status')); } catch (error) { setNotice(error.message); } };
  useEffect(() => { void reload(); const query = new URLSearchParams(location.search); if (query.has('result')) setNotice(`${names[query.get('provider')] || ''}: ${query.get('result') === 'connected' ? '連携しました' : `連携結果: ${query.get('result')}`}`); }, []);
  const save = async platform => {
    try {
      const value = clients[platform] || {};
      await json(`/api/oauth/client/${platform}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
      setClients(previous => ({ ...previous, [platform]: {} }));
      setNotice(`${names[platform]} のクライアント情報を保存しました`);
      await reload();
    } catch (error) { setNotice(error.message); }
  };
  const loadBroadcasts = async () => { try { const data = await json('/api/oauth/youtube/broadcasts'); setBroadcasts(data.broadcasts || []); } catch (error) { setNotice(error.message); } };
  const chooseBroadcast = async () => { try { await json('/api/oauth/youtube/broadcast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: selected }) }); setNotice('YouTube配信枠を選択しました'); } catch (error) { setNotice(error.message); } };
  return <div style={{ maxWidth: 900, margin: '30px auto', padding: 22 }}><a href="/">← ダッシュボード</a><h1>コメント／タイトル連携</h1><p>各サービスの開発者アプリのクライアントIDとシークレットを登録し、OAuth認証を行います。シークレットはブラウザーには保存しません。</p>{notice && <div className="demo-notice">{notice}</div>}
    {Object.keys(names).map(platform => <section className="card" style={{ marginTop: 18 }} key={platform}><div className="card-head"><div className="card-title">{names[platform]}</div><span className="count-pill">{status[platform]?.authorized ? '認証済み' : '未認証'}</span></div><div className="card-content"><p>コールバックURL: <code>{status[platform]?.redirectUri}</code></p><div className="field"><label>クライアントID</label><input value={clients[platform]?.clientId || ''} onChange={event => setClients(previous => ({ ...previous, [platform]: { ...previous[platform], clientId: event.target.value } }))} autoComplete="off" /></div><div className="field"><label>クライアントシークレット</label><input type="password" value={clients[platform]?.clientSecret || ''} onChange={event => setClients(previous => ({ ...previous, [platform]: { ...previous[platform], clientSecret: event.target.value } }))} autoComplete="new-password" /></div><div className="modal-actions"><button className="btn" onClick={() => save(platform)}>アプリ情報を保存</button><a className="btn primary" href={`/oauth/start/${platform}`}>OAuth認証を開始</a></div></div></section>)}
    <section className="card" style={{ marginTop: 18 }}><div className="card-head"><div className="card-title">YouTube配信枠</div></div><div className="card-content"><button className="btn" onClick={loadBroadcasts}>配信枠を読み込む</button>{broadcasts.length > 0 && <div className="field"><label>配信枠</label><select value={selected} onChange={event => setSelected(event.target.value)}><option value="">選択してください</option>{broadcasts.map(item => <option value={item.id} key={item.id}>{item.title} ({item.status})</option>)}</select><button className="btn primary" disabled={!selected} onClick={chooseBroadcast}>この枠を使用</button></div>}</div></section>
  </div>;
}
