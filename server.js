// High-level: A small bridge that can accept Twilio Media Streams over raw WS,
// relay messages to n8n (WS or HTTP), and expose Socket.io events for observability.

require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server: IOServer } = require('socket.io');
const WebSocket = require('ws');
const axios = require('axios');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = parseInt(process.env.PORT || '1971', 10);
const HOST = process.env.HOST || '0.0.0.0';
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN || '';

// n8n destinations
const N8N_WS_URL = process.env.N8N_WS_URL || '';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// Express + HTTP server
const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// Socket.io for observability and optional client integrations
const io = new IOServer(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  logger.info({ id: socket.id }, 'Socket.io client connected');
  socket.emit('hello', { message: 'socket.io connected' });
  socket.on('disconnect', () => logger.info({ id: socket.id }, 'Socket.io client disconnected'));
});

// Raw WebSocket servers
// 1) Twilio Media Streams endpoint (expects raw WS, not Socket.io)
// 2) n8n inbound clients connect here in a separate path
const wss = new WebSocket.Server({ noServer: true });

// Per-stream routing
const streamSidToTwilio = new Map(); // streamSid -> twilioWs
const twilioWsToStreamSid = new Map(); // twilioWs -> streamSid
const n8nInboundClients = new Set();

// Optional outbound n8n WS client
let outboundN8nWs = null;
function connectOutboundN8n() {
  if (!N8N_WS_URL) return;
  logger.info({ url: N8N_WS_URL }, 'Connecting to outbound n8n WS...');
  const ws = new WebSocket(N8N_WS_URL);
  ws.on('open', () => {
    logger.info('Connected to n8n WS');
    outboundN8nWs = ws;
  });
  ws.on('message', (data) => {
    // Forward messages from n8n to any interested Socket.io observers
    io.emit('n8n:message', safeToString(data));
  });
  ws.on('close', () => {
    logger.warn('n8n WS disconnected');
    outboundN8nWs = null;
    // Reconnect with simple backoff
    setTimeout(connectOutboundN8n, 2000);
  });
  ws.on('error', (err) => logger.error({ err }, 'n8n WS error'));
}
connectOutboundN8n();

// Handle HTTP upgrade to WS for our two raw WS paths
server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  if (url?.startsWith('/ws/twilio') || url?.startsWith('/ws/n8n')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Simple routing based on request.url
wss.on('connection', (ws, request) => {
  const path = request.url || '';
  const clientId = Math.random().toString(36).slice(2);
  logger.info({ clientId, path }, 'WS connection established');

  // Emit to Socket.io observers
  io.emit('ws:connected', { clientId, path });

  // Optional simple bearer token via query param token=...
  if (WS_AUTH_TOKEN) {
    const valid = hasValidToken(path, WS_AUTH_TOKEN);
    if (!valid) {
      logger.warn({ clientId }, 'Missing/invalid token, closing');
      try { ws.close(1008, 'unauthorized'); } catch {}
      return;
    }
  }

  const isTwilio = path.startsWith('/ws/twilio');
  const isN8n = path.startsWith('/ws/n8n');
  if (isN8n) n8nInboundClients.add(ws);

  ws.on('message', async (data, isBinary) => {
    const text = isBinary ? data.toString('utf8') : safeToString(data);
    io.emit('ws:message', { clientId, path, payloadPreview: preview(text) });

    if (isTwilio) {
      // Expect Twilio Media Stream frames (JSON). Maintain streamSid mapping and forward to n8n.
      try {
        const frame = JSON.parse(text);
        await handleTwilioFrame(ws, frame);
      } catch (e) {
        logger.warn({ clientId, err: e.message, text: preview(text) }, 'Non-JSON or invalid Twilio frame');
      }
    } else if (isN8n) {
      // Expect app-level control frames from n8n to Twilio
      try {
        const msg = JSON.parse(text);
        await handleN8nInboundMessage(msg);
      } catch (e) {
        logger.warn({ clientId, err: e.message, text: preview(text) }, 'Invalid n8n message');
      }
    } else {
      // Unknown path, ignore
    }
  });

  ws.on('close', () => {
    logger.info({ clientId }, 'WS connection closed');
    io.emit('ws:closed', { clientId, path });
    if (isN8n) n8nInboundClients.delete(ws);
    if (isTwilio) detachTwilio(ws);
  });

  ws.on('error', (err) => {
    logger.error({ clientId, err }, 'WS connection error');
    io.emit('ws:error', { clientId, error: err.message });
  });
});

async function forwardToN8n(payload) {
  // 1) Prefer outbound WS if configured and open
  if (outboundN8nWs && outboundN8nWs.readyState === WebSocket.OPEN) {
    outboundN8nWs.send(payload);
    return 'ws';
  }
  // 2) Fallback to HTTP POST webhook if configured
  if (N8N_WEBHOOK_URL) {
    await axios.post(N8N_WEBHOOK_URL, typeof payload === 'string' ? { data: payload } : payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });
    return 'http';
  }
  return null;
}

function hasValidToken(path, token) {
  try {
    const u = new URL(path, 'http://x');
    return u.searchParams.get('token') === token;
  } catch {
    return false;
  }
}

function detachTwilio(twilioWs) {
  const sid = twilioWsToStreamSid.get(twilioWs);
  if (sid) {
    streamSidToTwilio.delete(sid);
    twilioWsToStreamSid.delete(twilioWs);
    io.emit('twilio:detached', { streamSid: sid });
  }
}

async function handleTwilioFrame(ws, frame) {
  const event = frame.event;
  if (event === 'start') {
    const sid = frame.start?.streamSid;
    if (sid) {
      streamSidToTwilio.set(sid, ws);
      twilioWsToStreamSid.set(ws, sid);
      io.emit('twilio:start', { streamSid: sid, start: frame.start });
      // Tell observers
      await forwardToN8n(JSON.stringify({ source: 'twilio', type: 'start', streamSid: sid, start: frame.start }));
    }
    return;
  }
  if (event === 'media') {
    const sid = frame.streamSid;
    const media = frame.media;
    // Forward as-is to n8n listeners
    const payload = JSON.stringify({ source: 'twilio', type: 'media', streamSid: sid, media });
    await forwardToN8n(payload);
    broadcastToInboundN8n(payload);
    return;
  }
  if (event === 'stop') {
    const sid = frame.streamSid || twilioWsToStreamSid.get(ws);
    await forwardToN8n(JSON.stringify({ source: 'twilio', type: 'stop', streamSid: sid }));
    broadcastToInboundN8n(JSON.stringify({ source: 'twilio', type: 'stop', streamSid: sid }));
    detachTwilio(ws);
    return;
  }
  // Forward any other events generically
  await forwardToN8n(JSON.stringify({ source: 'twilio', type: event, ...frame }));
  broadcastToInboundN8n(JSON.stringify({ source: 'twilio', type: event, ...frame }));
}

function broadcastToInboundN8n(text) {
  for (const client of n8nInboundClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(text);
    }
  }
}

async function handleN8nInboundMessage(msg) {
  // Expected shapes:
  // { type: 'media', streamSid, media: { contentType: 'audio/x-mulaw;rate=8000', payload: base64 } }
  // { type: 'mark', streamSid, mark: { name: 'xyz' } }
  // { type: 'clear', streamSid }
  const type = msg.type;
  const sid = msg.streamSid;
  if (!sid) return;
  const twilioWs = streamSidToTwilio.get(sid);
  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;

  if (type === 'media' && msg.media?.payload) {
    const frame = {
      event: 'media',
      streamSid: sid,
      media: {
        contentType: msg.media.contentType || 'audio/x-mulaw;rate=8000',
        payload: msg.media.payload,
      },
    };
    twilioWs.send(JSON.stringify(frame));
    io.emit('twilio:tx', { streamSid: sid, bytes: byteLength(JSON.stringify(frame)) });
    return;
  }
  if (type === 'mark' && msg.mark?.name) {
    const frame = { event: 'mark', streamSid: sid, mark: { name: msg.mark.name } };
    twilioWs.send(JSON.stringify(frame));
    return;
  }
  if (type === 'clear') {
    const frame = { event: 'clear', streamSid: sid };
    twilioWs.send(JSON.stringify(frame));
    return;
  }
  if (type === 'stop') {
    const frame = { event: 'stop', streamSid: sid };
    twilioWs.send(JSON.stringify(frame));
    return;
  }
}

function safeToString(data) {
  try {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (typeof data === 'string') return data;
    return JSON.stringify(data);
  } catch (e) {
    return '[binary]';
  }
}

function preview(data, max = 200) {
  const s = typeof data === 'string' ? data : '[binary]';
  return s.length > max ? `${s.slice(0, max)}…(${s.length} bytes)` : s;
}

function byteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.length;
  return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

server.listen(PORT, HOST, () => {
  logger.info({ port: PORT, host: HOST }, 'Server listening');
  logger.info('WS endpoints: /ws/twilio, /ws/n8n');
});


