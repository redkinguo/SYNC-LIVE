import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import OAuth from './OAuth.jsx';
import Metadata from './Metadata.jsx';

const platforms = [
  { id: 'twitch', name: 'Twitch', mark: 'T', tone: 'twitch', color: '#a970ff' },
  { id: 'kick', name: 'Kick', mark: 'K', tone: 'kick', color: '#53d58b' },
  { id: 'youtube', name: 'YouTube', mark: '▶', tone: 'youtube', color: '#ff666d' },
];
const seedMessages = [
  { id: 'demo-1', platform: 'twitch', user: 'kuro_neko', text: 'こんばんは！今日も楽しみにしてました', time: '12:41:08' },
  { id: 'demo-2', platform: 'youtube', user: 'sora_live', text: '音声ばっちり聞こえてます 🙌', time: '12:41:06' },
  { id: 'demo-3', platform: 'kick', user: 'bigwave77', text: 'First time here, what game is this?', time: '12:41:03' },
];
const emptyStream = { running: false, detail: '停止中', destinations: 0, outputs: {}, startedAt: null };
const initialSettings = () => {
  try { return { channels: {}, obsUrl: 'rtmp://127.0.0.1:1935/live/stream', title: '', ...JSON.parse(localStorage.getItem('sync-live-config') || '{}') }; }
  catch { return { channels: {}, obsUrl: 'rtmp://127.0.0.1:1935/live/stream', title: '' }; }
};
async function request(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function useBridge() {
  const [snapshot, setSnapshot] = useState({ mode: 'demo', connected: {}, messages: seedMessages, stream: emptyStream, audience: {}, readiness: {} });
  const [reachable, setReachable] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await request('/api/state');
        if (!disposed) { setSnapshot(next); setReachable(true); }
      } catch { if (!disposed) setReachable(false); }
    };
    void refresh();
    const poll = setInterval(refresh, 2000);
    const events = new EventSource('/api/events');
    events.onmessage = event => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.type === 'state') setSnapshot(previous => ({ ...previous, ...packet.data }));
        if (packet.type === 'message') setSnapshot(previous => ({ ...previous, messages: [packet.data, ...(previous.messages || []).filter(m => m.id !== packet.data.id)].slice(0, 500) }));
        if (packet.type === 'connection') setSnapshot(previous => ({ ...previous, connected: { ...previous.connected, [packet.data.platform]: packet.data.connected } }));
        if (packet.type === 'stream') setSnapshot(previous => ({ ...previous, stream: packet.data }));
        if (packet.type === 'audience') setSnapshot(previous => ({ ...previous, audience: packet.data }));
      } catch { /* The next state poll restores the view. */ }
    };
    return () => { disposed = true; clearInterval(poll); events.close(); };
  }, []);
  return { snapshot, setSnapshot, reachable };
}
function duration(startedAt, clock) {
  const time = Date.parse(startedAt || '');
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.max(0, Math.floor((clock - time) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(x => String(x).padStart(2, '0')).join(':');
}
function Message({ message }) {
  const platform = platforms.find(item => item.id === message.platform) || platforms[0];
  return <div className="message">
    <div className="msg-avatar" style={{ background: `${platform.color}22`, color: platform.color }}>{(message.user?.trim()?.[0] || '?').toUpperCase()}</div>
    <div className="msg-main"><div className="msg-meta"><span className="msg-user">{message.user}</span><span className={`platform-chip ${platform.tone}`}>{platform.name}</span>{message.bot && <span className="platform-chip">BOT</span>}</div><div className="msg-text">{message.text}</div></div>
    <time className="msg-time">{message.time}</time>
  </div>;
}
function App() {
  const { snapshot, setSnapshot, reachable } = useBridge();
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(settings);
  const [showSettings, setShowSettings] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [compose, setCompose] = useState('');
  const [target, setTarget] = useState('youtube');
  const [demoLive, setDemoLive] = useState(false);
  const [bot, setBot] = useState(true);
  const [toast, setToast] = useState('');
  const [clock, setClock] = useState(Date.now());
  const liveMode = snapshot.mode === 'live';
  const stream = snapshot.stream || emptyStream;
  const messages = (snapshot.messages || []).filter(m => platforms.some(p => p.id === m.platform));
  const connectedCount = platforms.filter(p => snapshot.connected?.[p.id]).length;
  const visible = useMemo(() => messages.filter(m => (filter === 'all' || m.platform === filter) && (!search || `${m.user} ${m.text}`.toLowerCase().includes(search.toLowerCase()))), [messages, filter, search]);
  const active = liveMode ? stream.running : demoLive;
  const outputs = Object.values(stream.outputs || {});
  const sending = outputs.filter(o => o.status === 'sending').length;
  const notify = value => { setToast(value); setTimeout(() => setToast(''), value.length > 75 ? 6000 : 2500); };
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const saveSettings = () => {
    const next = { ...draft, channels: Object.fromEntries(Object.entries(draft.channels || {}).map(([key, value]) => [key, value.trim()])) };
    localStorage.setItem('sync-live-config', JSON.stringify(next)); setSettings(next); setShowSettings(false); notify('ブラウザーに設定を保存しました');
  };
  const openSettings = () => { setDraft({ ...settings, channels: { ...settings.channels } }); setShowSettings(true); };
  const addLocalMessage = (platform, user, text, isBot = false) => setSnapshot(previous => ({ ...previous, messages: [{ id: crypto.randomUUID(), platform, user, text, time: new Date().toLocaleTimeString('ja-JP', { hour12: false }), bot: isBot }, ...(previous.messages || [])].slice(0, 500) }));
  const connect = async id => {
    const action = snapshot.connected?.[id] ? 'disconnect' : 'connect';
    try {
      if (reachable) { await request(`/api/${action}/${id}`, { handle: settings.channels?.[id] || '' }); const next = await request('/api/state'); setSnapshot(next); }
      else setSnapshot(previous => ({ ...previous, connected: { ...previous.connected, [id]: action === 'connect' } }));
      notify(`${platforms.find(p => p.id === id).name} を${action === 'connect' ? '接続' : '切断'}しました`);
    } catch (error) { notify(error.message); }
  };
  const toggleStream = async () => {
    if (!liveMode) { setDemoLive(!demoLive); notify(demoLive ? 'デモ配信を停止しました' : 'デモ配信を開始しました'); return; }
    try { const result = await request(`/api/stream/${stream.running ? 'stop' : 'start'}`, { title: settings.title || '' }); notify(result.detail || '設定を更新しました'); setSnapshot(await request('/api/state')); }
    catch (error) { notify(error.message); }
  };
  const syncTitles = async () => {
    if (!settings.title.trim()) { notify('共通配信タイトルを入力してください'); return; }
    try { const result = await request('/api/titles/sync', { title: settings.title.trim() }); notify((result.results || []).map(x => `${x.platform}: ${x.ok ? '反映済み' : x.detail}`).join(' / ')); }
    catch (error) { notify(error.message); }
  };
  const sendComment = async () => {
    const text = compose.trim(); if (!text) return;
    try {
      if (liveMode) await request('/api/manual/comment', { platform: target, text });
      else {
        const targets = target === 'all' ? platforms.filter(p => snapshot.connected?.[p.id]) : platforms.filter(p => p.id === target && snapshot.connected?.[p.id]);
        if (!targets.length) throw new Error('先にプラットフォームをデモ接続してください');
        for (const platform of targets) {
          if (reachable) await request('/api/demo/comment', { platform: platform.id, user: 'あなた', text });
          else addLocalMessage(platform.id, 'あなた', text);
        }
        if (bot && text.toLowerCase() === '!help') {
          const response = 'コマンド: !help — 利用できるコマンドを表示します。';
          if (reachable) await request('/api/demo/comment', { platform: targets[0].id, user: 'SYNC BOT', text: response });
          else addLocalMessage(targets[0].id, 'SYNC BOT', response, true);
        }
      }
      setCompose(''); notify(liveMode ? '統合コメントに追加しました' : 'デモコメントを追加しました');
    } catch (error) { notify(error.message); }
  };
  const demoIncoming = async () => {
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    const items = [['ao_stream', 'この画面見やすい！'], ['momo_live', '音量ちょうどいいです'], ['stream_fan', 'ナイスプレイ！']];
    const [user, text] = items[Math.floor(Math.random() * items.length)];
    try { if (reachable && !liveMode) await request('/api/demo/comment', { platform: platform.id, user, text }); else addLocalMessage(platform.id, user, text); notify(`${platform.name} のデモコメントを受信しました`); }
    catch (error) { notify(error.message); }
  };
  const copyOverlay = async () => { const url = `${location.origin}/overlay`; try { await navigator.clipboard.writeText(url); notify('オーバーレイ URL をコピーしました'); } catch { prompt('OBS ブラウザソースに設定する URL', url); } };
  const destinationStatus = item => ({ sending: '● 送信中', failed: '● 失敗', waiting: '● OBS入力待ち', stopping: '● 停止中', stopped: '○ 停止中' })[item?.status] || '— 未設定';
  const metrics = id => {
    const metric = snapshot.audience?.[id] || {};
    const sent = stream.outputs?.[id]?.status === 'sending';
    const elapsed = duration(metric.startedAt || (sent ? stream.startedAt : null), clock);
    return `${metric.live ? 'LIVE' : metric.status === 'error' ? '状態取得エラー' : 'OFFLINE'} · 同接 ${metric.live && metric.viewers != null ? `${Number(metric.viewers).toLocaleString()}人` : '—'} · ${metric.live ? '配信時間' : '送信時間'} ${elapsed}`;
  };
  if (location.pathname === '/overlay' || location.pathname === '/overlay.html') return <Overlay messages={messages} />;
  if (location.pathname === '/chat' || location.pathname === '/chat.html') return <ChatView messages={messages} snapshot={snapshot} clock={clock} />;
  if (location.pathname === '/oauth-setup') return <OAuth />;
  if (location.pathname === '/metadata' || location.pathname === '/metadata.html') return <Metadata />;

  return <><div className="app">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">S</div><div className="brand-name">SYNC LIVE<span className="brand-sub">CREATOR CONTROL</span></div></div>
      <div><div className="nav-label">ワークスペース</div><nav className="nav-list"><button className="nav-item active"><span className="nav-icon">◫</span><span>配信ダッシュボード</span></button><button className="nav-item" onClick={() => document.querySelector('.chat-card')?.scrollIntoView({ behavior: 'smooth' })}><span className="nav-icon">▤</span><span>統合コメント</span><span className="nav-count">{String(messages.length).padStart(2, '0')}</span></button><button className="nav-item" onClick={openSettings}><span className="nav-icon">⚙</span><span>接続設定</span></button></nav></div>
      <div className="sidebar-bottom"><div className="account-box"><div className="account-row"><div className="avatar">M</div><div><div className="account-name">マイ配信</div><div className="account-state">ローカルワークスペース</div></div></div><div className="demo-label">● {liveMode ? 'ライブ接続モード' : 'デモモード'}<br />{liveMode ? 'OBS配信待機中' : '外部サービスへ接続しません'}</div></div></div>
    </aside>
    <main><div className="topbar"><div className="breadcrumbs">配信管理 <span style={{ color: '#505562' }}>/</span> <strong>ダッシュボード</strong></div><div className="top-actions"><div className="badge"><span className="pulse" style={{ background: active ? '#ff737a' : '#ffc56f' }}></span><span>{liveMode ? stream.running ? '配信リレー中' : 'API 接続モード' : demoLive ? 'デモ配信中' : 'デモモード'}</span></div></div></div>
      <div className="page-head"><div><h1>配信ダッシュボード</h1><div className="subhead">配信先・コメント・ボットをひとつの画面で管理</div></div><div className="head-actions"><button className="btn ghost" onClick={openSettings}>⚙ 接続設定</button><button className="btn primary" onClick={toggleStream}>{active ? '■ 配信を停止' : liveMode ? '▶ マルチ配信を開始' : '▶ デモ配信を開始'}</button></div></div>
      <div className="demo-notice"><span>ⓘ</span><span><b>{liveMode ? 'ライブ接続モードです。' : 'デモモードです。'}</b> {liveMode ? 'OBSの「配信開始」でYouTube・Twitch・Kickへ同時送信します。' : '外部サービスへ送信せず、画面とコメント表示を試せます。'}</span></div>
      <div style={{ margin: '9px 0 15px' }}><a href="/oauth-setup" style={{ color: '#bba7ff', fontWeight: 700 }}>Twitch・YouTube・Kick のコメント／タイトル連携を設定 →</a></div>
      <div className="layout"><div className="left-col">
        <section className="card"><div className="card-head"><div><div className="card-title">プラットフォーム接続</div><div className="card-caption">配信先とチャット連携の準備状況</div></div><span className="count-pill">{connectedCount} / 3 接続</span></div><div className="card-content"><div className="platform-grid">{platforms.map(p => {
          const connected = !!snapshot.connected?.[p.id];
          return <article className={`platform-card ${connected ? 'connected' : ''}`} key={p.id}><div className="platform-top"><div className={`platform-icon ${p.tone}`}>{p.mark}</div><div style={{ minWidth: 0 }}><div className="platform-name">{p.name}</div><div className="platform-handle">{settings.channels?.[p.id] || 'チャンネル未設定'}</div></div><span className="platform-state"></span></div><div className="platform-status-row"><span className="platform-status"><i className="status-dot"></i>{connected ? liveMode ? 'API 接続中' : 'デモ接続中' : snapshot.readiness?.[p.id]?.chat ? '接続待ち' : 'コメント連携未設定'}</span><div className="platform-actions"><button className="link-btn" onClick={openSettings}>設定</button><button className="connect-btn" onClick={() => connect(p.id)}>{connected ? '切断' : '接続'}</button></div></div></article>;
        })}</div></div></section>
        <section className="card chat-card"><div className="card-head"><div><div className="card-title">統合コメント</div><div className="card-caption">接続した配信のチャットを時系列で表示</div></div><div className="chat-tools"><a className="chat-open" href="/chat" target="_blank">コメント専用 ↗</a><input className="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="⌕ コメント検索" /><button className="count-pill" onClick={demoIncoming} title="デモコメントを受信">{visible.length} 件 · ＋</button></div></div><div className="chat-filters">{[{ id: 'all', name: 'すべて' }, ...platforms].map(p => <button key={p.id} className={`filter ${filter === p.id ? 'active' : ''}`} onClick={() => setFilter(p.id)}>{p.color && <i className="filter-dot" style={{ background: p.color }}></i>}{p.name}<span style={{ opacity: .65, marginLeft: 4 }}>{p.id === 'all' ? messages.length : messages.filter(m => m.platform === p.id).length}</span></button>)}</div><div className="chat-list" aria-live="polite">{visible.length ? visible.map(m => <Message key={m.id} message={m} />) : <div className="empty">コメントがありません</div>}</div><div className="overlay-hint">OBS の「ブラウザ」ソースに <button onClick={copyOverlay}>オーバーレイ URL をコピー</button> して追加すると、コメントを配信画面に表示できます。</div><div className="chat-compose"><div className="compose-top"><span className="compose-label">{liveMode ? '手動コメントを統合表示' : 'デモコメントを送る'}</span><select className="target-select" value={target} onChange={event => setTarget(event.target.value)}>{!liveMode && <option value="all">デモ接続先へ</option>}{platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div><div className="compose-box"><input className="compose-input" maxLength={200} value={compose} onChange={event => setCompose(event.target.value)} onKeyDown={event => event.key === 'Enter' && sendComment()} placeholder="メッセージを入力…" /><button className="send-btn" onClick={sendComment}>送信 →</button></div><div className="compose-hint">配信サイトへは投稿されません。</div></div></section>
      </div><div className="right-col"><section className="card live-card"><div className="card-head"><div><div className="card-title">配信コントロール</div><div className="card-caption">OBS Studio を映像ソースとして使用</div></div><div className={`live-indicator ${active ? 'on' : ''}`}><i></i><span>{active ? liveMode ? 'RELAY ON' : 'DEMO LIVE' : 'OFFLINE'}</span></div></div><div className="card-content"><div className="source-row"><div className="source-icon">◉</div><div className="source-meta"><div className="source-name">OBS Studio</div><div className="source-url">{snapshot.obsIngestUrl || settings.obsUrl}</div></div><span className="source-state">{stream.running ? '待機中' : '設定待ち'}</span></div><div className="source-footer"><span>映像ソースの接続先</span><button onClick={openSettings}>接続先を編集 ↗</button></div><div className="stats"><div className="stat"><div className="stat-label">配信先</div><div className="stat-value">{liveMode ? sending : demoLive ? connectedCount : 0} <small>/ {liveMode ? stream.destinations || 3 : 3}</small></div></div><div className="stat"><div className="stat-label">接続チャット</div><div className="stat-value">{connectedCount} <small>/ 3</small></div></div><div className="stat"><div className="stat-label">コメント</div><div className="stat-value">{String(messages.length).padStart(2, '0')} <small>件</small></div></div></div><div className="stream-title"><label htmlFor="streamTitle">共通配信タイトル</label><input id="streamTitle" maxLength={100} value={settings.title || ''} onChange={event => { const next = { ...settings, title: event.target.value }; setSettings(next); localStorage.setItem('sync-live-config', JSON.stringify(next)); }} placeholder="配信タイトルを入力" /><button className="link-btn" onClick={syncTitles}>タイトルを3サービスに反映</button><small>{liveMode ? '各サービスの認証が必要です。' : 'デモでは配信先を変更しません。'}</small></div><div style={{ marginTop: 7 }}><a href="/metadata" style={{ color: '#bba7ff', fontSize: 10, fontWeight: 700 }}>配信先ごとの詳細設定 →</a></div><div className="stream-preview" style={{ marginTop: 12 }}><div className="preview-grid"></div><div className="preview-content"><div className="preview-play">▶</div><div className="preview-title">{stream.running ? 'RTMP リレー稼働中' : demoLive ? 'デモ配信中' : 'OBS の映像プレビュー'}</div><div className="preview-sub">{liveMode ? stream.detail : demoLive ? '外部サービスには送信していません' : '配信開始後に状態が表示されます'}</div></div></div><div className="live-actions"><button className={`btn start ${active ? 'on' : ''}`} onClick={toggleStream}>{active ? '■ マルチ配信を停止' : liveMode ? '▶ マルチ配信を開始' : '▶ デモ配信を開始'}</button><button className="btn" onClick={() => notify('OBS の配信先に表示されたローカルRTMP URLを設定してください')}>OBS 設定</button></div></div></section>
        <section className="card"><div className="card-head"><div><div className="card-title">配信先の状態</div><div className="card-caption">アカウント別の接続状況</div></div><button className="link-btn" onClick={openSettings}>管理 →</button></div><div className="card-content"><div className="connection-list">{platforms.map(p => <div className={`connection-row ${snapshot.connected?.[p.id] ? 'connected' : ''}`} key={p.id}><div className={`platform-icon ${p.tone}`}>{p.mark}</div><div style={{ minWidth: 0 }}><div className="platform-name">{p.name}</div><div className="platform-handle">{settings.channels?.[p.id] || 'チャンネル未設定'}</div></div><div className="connection-right"><div className="connection-state"><span>配信</span><span className={`output-health ${stream.outputs?.[p.id]?.status || 'unconfigured'}`}>{destinationStatus(stream.outputs?.[p.id])}</span></div><div className="connection-count">コメント: {snapshot.connected?.[p.id] ? '接続中' : '未接続'}</div><div className="connection-live">{metrics(p.id)}</div></div></div>)}</div><div className="output-footnote">「送信中」はFFmpegからRTMP送信できている状態です。公開状況は各サービスでも確認してください。</div></div></section>
        <section className="card"><div className="card-head"><div className="bot-header"><div className="bot-avatar">✦</div><div><div className="bot-title">コメント BOT</div><div className="bot-sub">自動応答ルール</div></div></div><button className={`toggle ${bot ? 'on' : ''}`} onClick={() => setBot(!bot)} aria-label="ボット切り替え"><span></span></button></div><div className="card-content"><div className="rule"><div className="rule-top"><span className="rule-name">!help コマンド</span><span className="rule-tag">{bot ? '有効' : '停止'}</span></div><div className="rule-desc">デモコメントにコマンド一覧を表示します。</div></div><div className="bot-foot">実際のチャットには投稿しません</div></div></section>
      </div></div></main></div>
    {showSettings && <div className="modal-backdrop open" role="dialog" aria-modal="true" onClick={event => event.target === event.currentTarget && setShowSettings(false)}><div className="modal"><div className="modal-head"><div><h2>接続設定</h2><p>配信アカウント名と OBS の送信先を登録します。配信キーはブラウザーに保存しません。</p></div><button className="modal-close" onClick={() => setShowSettings(false)}>×</button></div>{platforms.map(p => <div className="field" key={p.id}><label>{p.name} チャンネル名</label><input value={draft.channels?.[p.id] || ''} onChange={event => setDraft(previous => ({ ...previous, channels: { ...previous.channels, [p.id]: event.target.value } }))} /></div>)}<div className="field"><label>OBS の映像接続先</label><input value={draft.obsUrl || ''} onChange={event => setDraft(previous => ({ ...previous, obsUrl: event.target.value }))} /></div><div className="modal-actions"><button className="btn" onClick={() => setShowSettings(false)}>キャンセル</button><button className="btn primary" onClick={saveSettings}>設定を保存</button></div></div></div>}
    <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>
  </>;
}
function Overlay({ messages }) {
  useEffect(() => {
    const oldBody = document.body.style.background;
    const oldRoot = document.documentElement.style.background;
    document.body.style.background = 'transparent'; document.documentElement.style.background = 'transparent';
    return () => { document.body.style.background = oldBody; document.documentElement.style.background = oldRoot; };
  }, []);
  return <div className="overlay-feed" aria-live="polite">{messages.slice(0, 7).reverse().map(m => { const platform = platforms.find(p => p.id === m.platform); return <article className="overlay-comment" key={m.id}><span className="overlay-mark" style={{ color: platform?.color, background: `${platform?.color}26` }}>{platform?.name?.toUpperCase()}</span><div><div className="overlay-meta">{m.user} <time>{m.time}</time></div><div className="overlay-text">{m.text}</div></div></article>; })}</div>;
}
function ChatView({ messages, snapshot, clock }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const list = useRef(null);
  const follow = useRef(true);
  const visible = messages.filter(m => (filter === 'all' || m.platform === filter) && `${m.user} ${m.text}`.toLowerCase().includes(search.toLowerCase())).slice().reverse();
  useEffect(() => { if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [messages, filter, search]);
  return <div className="chat-page"><header><a href="/">← ダッシュボード</a><h1>統合コメント</h1><p>{platforms.filter(p => snapshot.connected?.[p.id]).map(p => p.name).join('・') || '接続待ち'}</p>
    <div className="chat-audience">{platforms.map(p => { const metric = snapshot.audience?.[p.id] || {}; return <div className="card" key={p.id}><b style={{ color: p.color }}>{p.name}</b><span>{metric.live ? 'LIVE' : 'OFFLINE'} · 同接 {metric.live ? metric.viewers ?? '—' : '—'}人</span><span>配信時間 {duration(metric.startedAt || snapshot.stream?.startedAt, clock)}</span></div>; })}</div>
    <div className="chat-filters">{[{ id: 'all', name: 'すべて' }, ...platforms].map(p => <button className={`filter ${filter === p.id ? 'active' : ''}`} key={p.id} onClick={() => setFilter(p.id)}>{p.name} {messages.filter(m => p.id === 'all' || m.platform === p.id).length}</button>)}<input className="search" placeholder="コメント検索" aria-label="コメント検索" value={search} onChange={event => setSearch(event.target.value)} /></div>
  </header><div className="chat-page-messages" ref={list} onScroll={() => { const node = list.current; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 50; }} aria-live="polite">{visible.length ? visible.map(m => <Message key={m.id} message={m} />) : <div className="empty">コメントがありません</div>}</div></div>;
}
createRoot(document.getElementById('root')).render(<App />);
