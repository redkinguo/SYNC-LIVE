import http from 'node:http';

// Expose only the signed Kick webhook endpoint through the local tunnel.
// The rest of SYNC LIVE stays reachable only on localhost:4318.
const listenPort = 4320;
const appPort = 4318;
const allowedExtraHeaders = new Set(['content-type', 'content-length', 'content-encoding', 'user-agent']);

const server = http.createServer((incoming, outgoing) => {
  let pathname;
  try {
    pathname = new URL(incoming.url || '/', 'http://localhost').pathname;
  } catch {
    outgoing.writeHead(400).end('Bad request');
    return;
  }

  if (incoming.method !== 'POST' || pathname !== '/webhooks/kick') {
    outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (name.startsWith('kick-event-') || allowedExtraHeaders.has(name)) headers[name] = value;
  }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: appPort,
    path: '/webhooks/kick',
    method: 'POST',
    headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode || 502, {
      'content-type': response.headers['content-type'] || 'text/plain; charset=utf-8',
    });
    response.pipe(outgoing);
  });

  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end('Webhook receiver unavailable');
  });
  incoming.on('aborted', () => upstream.destroy());
  incoming.pipe(upstream);
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`Kick webhook relay listening on 127.0.0.1:${listenPort}`);
});
