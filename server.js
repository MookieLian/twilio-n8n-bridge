const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Configuration
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN || '';

// Log configuration on startup
logger.info({ 
  port: PORT, 
  host: HOST, 
  hasWebhook: !!N8N_WEBHOOK_URL,
  hasToken: !!WS_AUTH_TOKEN,
  nodeVersion: process.version,
  platform: process.platform
}, 'Starting Twilio Media Streams Bridge');

// Express app for health checks
const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));
app.get('/', (req, res) => res.json({ 
  status: 'Twilio Media Streams Bridge', 
  port: PORT,
  endpoints: ['/health', '/ws/twilio']
}));

const server = http.createServer(app);

// WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ noServer: true });

// Track active Twilio streams
const activeStreams = new Map(); // streamSid -> { ws, buffer, lastActivity }

// Handle HTTP upgrade to WebSocket
server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  
  if (url?.startsWith('/ws/twilio')) {
    // Validate token if configured
    if (WS_AUTH_TOKEN) {
      const token = new URL(url, 'http://x').searchParams.get('token');
      if (token !== WS_AUTH_TOKEN) {
        logger.warn('Invalid token, closing connection');
        socket.destroy();
        return;
      }
    }
    
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handle WebSocket connections
wss.on('connection', (ws, request) => {
  const clientId = Math.random().toString(36).slice(2);
  let currentStreamSid = null;
  
  logger.info({ clientId }, 'Twilio WebSocket connected');

  ws.on('message', async (data) => {
    try {
      const frame = JSON.parse(data.toString());
      const event = frame.event;
      
      if (event === 'start') {
        // New stream started
        const streamSid = frame.start?.streamSid;
        if (streamSid) {
          currentStreamSid = streamSid;
          activeStreams.set(streamSid, {
            ws,
            buffer: [],
            lastActivity: Date.now(),
            startTime: Date.now()
          });
          logger.info({ clientId, streamSid }, 'Stream started');
        }
      }
      
      else if (event === 'media') {
        // Audio chunk received
        const streamSid = frame.streamSid;
        const media = frame.media;
        
        if (streamSid && media?.payload) {
          const stream = activeStreams.get(streamSid);
          if (stream) {
            // Add to buffer
            stream.buffer.push({
              timestamp: Date.now(),
              payload: media.payload,
              contentType: media.contentType || 'audio/x-mulaw;rate=8000'
            });
            stream.lastActivity = Date.now();
            
            // Send to n8n webhook if configured
            if (N8N_WEBHOOK_URL) {
              try {
                await axios.post(N8N_WEBHOOK_URL, {
                  event: 'media',
                  streamSid,
                  media: {
                    payload: media.payload,
                    contentType: media.contentType || 'audio/x-mulaw;rate=8000',
                    timestamp: Date.now()
                  }
                }, {
                  timeout: 5000,
                  headers: { 'Content-Type': 'application/json' }
                });
                logger.debug({ streamSid }, 'Sent to n8n webhook');
              } catch (err) {
                logger.error({ streamSid, err: err.message }, 'Failed to send to n8n');
              }
            }
          }
        }
      }
      
      else if (event === 'stop') {
        // Stream ended
        const streamSid = frame.streamSid || currentStreamSid;
        if (streamSid) {
          const stream = activeStreams.get(streamSid);
          if (stream) {
            // Send final buffer to n8n
            if (N8N_WEBHOOK_URL && stream.buffer.length > 0) {
              try {
                await axios.post(N8N_WEBHOOK_URL, {
                  event: 'stop',
                  streamSid,
                  finalBuffer: stream.buffer,
                  duration: Date.now() - stream.startTime
                }, {
                  timeout: 5000,
                  headers: { 'Content-Type': 'application/json' }
                });
              } catch (err) {
                logger.error({ streamSid, err: err.message }, 'Failed to send final buffer');
              }
            }
            
            activeStreams.delete(streamSid);
            logger.info({ clientId, streamSid }, 'Stream stopped');
          }
        }
      }
      
    } catch (err) {
      logger.warn({ clientId, err: err.message }, 'Invalid frame received');
    }
  });

  ws.on('close', () => {
    if (currentStreamSid) {
      activeStreams.delete(currentStreamSid);
    }
    logger.info({ clientId }, 'WebSocket disconnected');
  });

  ws.on('error', (err) => {
    logger.error({ clientId, err: err.message }, 'WebSocket error');
  });
});

// Cleanup inactive streams every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [streamSid, stream] of activeStreams.entries()) {
    if (now - stream.lastActivity > 30000) { // 30 seconds
      logger.info({ streamSid }, 'Cleaning up inactive stream');
      activeStreams.delete(streamSid);
    }
  }
}, 30000);

// Start server
server.listen(PORT, HOST, () => {
  logger.info({ port: PORT, host: HOST }, 'Twilio Media Streams Bridge started');
  logger.info('WebSocket endpoint: /ws/twilio');
  if (N8N_WEBHOOK_URL) {
    logger.info('n8n webhook configured');
  }
});

// Add error handling
server.on('error', (err) => {
  logger.error({ err: err.message, code: err.code }, 'Server error');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

