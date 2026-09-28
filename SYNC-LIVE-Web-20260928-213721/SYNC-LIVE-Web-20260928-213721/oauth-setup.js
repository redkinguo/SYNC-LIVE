const providers = ['twitch', 'youtube', 'kick'];
const resultText = {
  connected: '連携を保存しました。', denied: '許可されなかったため、連携は変更していません。',
  failed: '認証の完了に失敗しました。アプリID、シークレット、リダイレクトURLを確認してください。',
  'client-missing': '先にClient IDとClient Secretを保存してください。',
  'invalid-state': '認証の期限が切れました。許可画面を開き直してください。',
  'missing-code': '認証コードを受け取れませんでした。',
};

function message(value) { document.getElementById('result').textContent = value; }

async function refresh() {
  const status = await (await fetch('/api/oauth/status', { cache: 'no-store' })).json();
  for (const provider of providers) {
    const item = status[provider];
    document.getElementById(`redirect-${provider}`).textContent = item.redirectUri;
    document.getElementById(`status-${provider}`).textContent = item.authorized ? '連携済み' : item.clientReady ? 'アプリ設定済み・許可待ち' : 'アプリ設定待ち';
    document.getElementById(`authorize-${provider}`).classList.toggle('disabled', !item.clientReady);
  }
  if (status.youtube.authorized) await loadBroadcasts();
}

async function loadBroadcasts() {
  const response = await fetch('/api/oauth/youtube/broadcasts', { cache: 'no-store' });
  if (!response.ok) return;
  const body = await response.json();
  const select = document.getElementById('broadcast-select');
  select.replaceChildren();
  for (const broadcast of body.broadcasts || []) {
    const option = document.createElement('option');
    option.value = broadcast.id;
    option.textContent = `${broadcast.status === 'active' ? '配信中' : '予定'}: ${broadcast.title}`;
    select.append(option);
  }
  document.getElementById('youtube-broadcast').hidden = !select.options.length;
}

for (const button of document.querySelectorAll('[data-save]')) {
  button.addEventListener('click', async () => {
    const provider = button.dataset.save;
    const id = document.getElementById(`id-${provider}`);
    const secret = document.getElementById(`secret-${provider}`);
    button.disabled = true;
    try {
      const response = await fetch(`/api/oauth/client/${provider}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: id.value.trim(), clientSecret: secret.value.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '保存できませんでした');
      id.value = '';
      secret.value = '';
      message(`${provider.toUpperCase()}のアプリ設定をこのPCに保存しました。許可画面へ進めます。`);
      await refresh();
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
}

document.getElementById('choose-broadcast').addEventListener('click', async () => {
  const id = document.getElementById('broadcast-select').value;
  if (!id) return;
  const response = await fetch('/api/oauth/youtube/broadcast', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  });
  const body = await response.json();
  message(response.ok && body.ok ? 'このYouTube配信枠をコメント・タイトル連携に設定しました。' : body.error || '配信枠を設定できませんでした。');
});

const query = new URLSearchParams(location.search);
if (query.has('result')) message(`${(query.get('provider') || '').toUpperCase()}: ${resultText[query.get('result')] || '認証状態を確認してください。'}`);
refresh().catch(() => message('SYNC LIVEのサーバーに接続できません。'));
