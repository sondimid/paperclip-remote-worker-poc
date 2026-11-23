import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { alias, decodeJson, frameBytes, maxRequests, parseTerminalFrame, receiptMs, removeExpired, requestId,
  retentionMs, sameSelection, terminalFrame, unknownReceipt, validOpenRequest, validToken, workerPath } from './protocol.mjs';

function hasToken(req, token) {
  const received = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readRequest(req) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('content_type');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > frameBytes) { req.resume(); throw new Error('body_size'); }
    chunks.push(chunk);
  }
  return decodeJson(Buffer.concat(chunks));
}

export function createTerminalBroker({ workerId, workerToken, operatorToken, timeoutMs = receiptMs }) {
  if (!alias(workerId) || !validToken(workerToken) || !validToken(operatorToken) || workerToken === operatorToken) {
    throw new Error('invalid_terminal_broker_config');
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: frameBytes, perMessageDeflate: false });
  const requests = new Map();
  let peer, pending;
  const online = () => !!peer?.inventory && peer.ws.readyState === WebSocket.OPEN;
  const view = ({ id, provider, workspace, status, reason }) => ({ id, provider, workspace, status, reason });
  function settle(entry, result) {
    if (pending !== entry) return;
    clearTimeout(entry.timer);
    delete entry.timer;
    delete entry.peer;
    Object.assign(entry, result, { expiresAt: performance.now() + retentionMs });
    pending = undefined;
  }

  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    const statusId = req.url?.startsWith('/terminal/open/') ? req.url.slice('/terminal/open/'.length) : undefined;
    const list = req.method === 'GET' && req.url === '/terminal/worker';
    const open = req.method === 'POST' && req.url === '/terminal/open';
    const status = req.method === 'GET' && requestId(statusId);
    if (!list && !open && !status) return reply(res, 404, { error: 'not_found' });
    if (!hasToken(req, operatorToken)) return reply(res, 401, { error: 'unauthorized' });
    if (list) return reply(res, 200, { workerId, online: online(), providers: online() ? peer.inventory.providers : [],
      workspaces: online() ? peer.inventory.workspaces : [] });
    if (status) {
      removeExpired(requests, performance.now());
      const stored = requests.get(statusId);
      return stored ? reply(res, 200, view(stored)) : reply(res, 404, { error: 'request_not_found' });
    }
    try {
      const body = await readRequest(req);
      if (!validOpenRequest(body)) return reply(res, 400, { error: 'invalid_selection' });
      removeExpired(requests, performance.now());
      const stored = requests.get(body.id);
      if (stored) return sameSelection(stored, body) ? reply(res, 200, view(stored)) : reply(res, 409, { error: 'request_conflict' });
      if (!online()) return reply(res, 409, { error: 'worker_offline' });
      if (!peer.inventory.providers.includes(body.provider) || !peer.inventory.workspaces.includes(body.workspace)) {
        return reply(res, 400, { error: 'selection_unavailable' });
      }
      if (pending || requests.size >= maxRequests) return reply(res, 409, { error: 'busy' });
      const entry = { ...body, peer, status: 'pending', reason: null, expiresAt: Infinity };
      requests.set(entry.id, entry);
      pending = entry;
      entry.timer = setTimeout(() => settle(entry, unknownReceipt('receipt_timeout')), timeoutMs);
      try {
        peer.ws.send(terminalFrame('open', body), error => {
          if (error) settle(entry, unknownReceipt('worker_disconnected'));
        });
      } catch { settle(entry, unknownReceipt('worker_disconnected')); }
      return reply(res, 202, view(entry));
    } catch {
      if (!res.destroyed && !res.headersSent) reply(res, 400, { error: 'invalid_request' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const rejection = req.method !== 'GET' || req.url !== workerPath ? '404 Not Found'
      : !hasToken(req, workerToken) ? '401 Unauthorized' : peer ? '409 Conflict' : null;
    if (rejection) { socket.end(`HTTP/1.1 ${rejection}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const connected = { ws, pong: true };
      peer = connected;
      const readyTimer = setTimeout(() => { if (!connected.inventory) ws.terminate(); }, 4000);
      ws.on('pong', () => { connected.pong = true; });
      ws.on('error', () => ws.terminate());
      ws.on('message', (raw, binary) => {
        if (peer !== connected || binary) { ws.close(1008, 'protocol_rejected'); return; }
        try {
          const frame = parseTerminalFrame(raw, true);
          if (!connected.inventory) {
            if (frame.type !== 'hello' || frame.workerId !== workerId) throw new Error('invalid_worker');
            connected.inventory = frame;
            clearTimeout(readyTimer);
            ws.send(terminalFrame('ready'));
          } else if (frame.type !== 'receipt') {
            throw new Error('invalid_message');
          } else if (pending?.peer === connected && pending.id === frame.id) {
            settle(pending, { status: frame.status, reason: frame.reason });
          }
        } catch { ws.close(1008, 'protocol_rejected'); }
      });
      ws.once('close', () => {
        clearTimeout(readyTimer);
        if (peer === connected) peer = undefined;
        if (pending?.peer === connected) settle(pending, unknownReceipt('worker_disconnected'));
      });
    });
  });

  const heartbeat = setInterval(() => {
    if (!peer) return;
    if (!peer.pong) { peer.ws.terminate(); return; }
    peer.pong = false;
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.ping();
  }, 15_000).unref();
  server.once('close', () => {
    clearInterval(heartbeat);
    peer?.ws.terminate();
    wss.close();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { TERMINAL_PORT = '3116', TERMINAL_WORKER_ID, TERMINAL_WORKER_TOKEN, TERMINAL_OPERATOR_TOKEN } = process.env;
    const port = Number(TERMINAL_PORT);
    if (!/^[0-9]{1,5}$/.test(TERMINAL_PORT) || port < 1 || port > 65535) throw new Error('invalid_port');
    const server = createTerminalBroker({ workerId: TERMINAL_WORKER_ID, workerToken: TERMINAL_WORKER_TOKEN,
      operatorToken: TERMINAL_OPERATOR_TOKEN });
    server.once('error', () => { console.error('Terminal Broker could not listen'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Terminal Broker listening on 127.0.0.1:${port}`));
  } catch { console.error('Invalid terminal Broker configuration'); process.exitCode = 1; }
}
