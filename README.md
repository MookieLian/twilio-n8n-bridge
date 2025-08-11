Twilio ↔ n8n Voice Bridge (WebSocket + Socket.io)

A minimal Node.js service to bridge Twilio Media Streams to n8n. It:

- Accepts Twilio Media Streams over raw WebSocket at `/ws/twilio`
- Lets n8n connect via raw WebSocket at `/ws/n8n` to receive Twilio frames and send control/media back
- Optionally connects out to an n8n WebSocket (`N8N_WS_URL`) and/or POSTs frames to an n8n webhook (`N8N_WEBHOOK_URL`)
- Exposes Socket.io on `/socket.io` for observability (events like `twilio:start`, `bridge:*`)

Quick start (local)

```
npm i
# or set PORT explicitly
PORT=1971 npm run start
# or
npm run dev
```

Env vars (create `.env`):

```
PORT=1971
HOST=0.0.0.0
LOG_LEVEL=info
# Optional simple auth for both WS paths: append ?token=... to URL
WS_AUTH_TOKEN=changeme

# Choose one or both for forwarding into n8n
N8N_WS_URL=ws://your-n8n:5678
N8N_WEBHOOK_URL=https://your-n8n/webhook/your-workflow

# Socket.io CORS
CORS_ORIGIN=*
```

Twilio setup

1. Expose this service publicly with TLS (e.g. via EasyPanel + HTTPS or a reverse proxy).
2. Create a TwiML App pointing Twilio voice to your bridge WS, for example:

```
<wss url="wss://your-bridge.example.com/ws/twilio?token=changeme"/>
```

Sample TwiML for a call:

```
<Response>
  <Connect>
    <Stream url="wss://your-bridge.example.com/ws/twilio?token=changeme" />
  </Connect>
  </Response>
```

Twilio will send frames as JSON: `start`, `media` (base64 audio), `stop`. The bridge ensures each call's `streamSid` is tracked and used for routing.

n8n integration

You have two options:

- Inbound WS from n8n to the bridge: connect n8n websocket node to `wss://your-bridge/ws/n8n?token=changeme`. You will receive messages like:

```
{
  "source": "twilio",
  "type": "media",
  "streamSid": "MZxxxx",
  "media": { "payload": "base64", "contentType": "audio/x-mulaw;rate=8000" }
}
```

- Outbound WS to n8n: set `N8N_WS_URL`, the bridge will send the same payloads to that server.
- HTTP webhook: set `N8N_WEBHOOK_URL`, the bridge will POST `{ data: "..." }` if payload is string, otherwise JSON.

To send audio or control back from n8n to Twilio, send JSON to the bridge inbound n8n WS:

```
// send audio into the call (base64 payload)
{
  "type": "media",
  "streamSid": "MZxxxx",
  "media": {
    "contentType": "audio/x-mulaw;rate=8000",
    "payload": "...base64..."
  }
}
```

Other supported messages from n8n to Twilio:

```
{ "type": "mark", "streamSid": "MZxxxx", "mark": { "name": "ready" } }
{ "type": "clear", "streamSid": "MZxxxx" }
{ "type": "stop", "streamSid": "MZxxxx" }
```

Notes:
- Ensure your audio format matches the Twilio stream (`audio/x-mulaw;rate=8000` by default).
- Keep message sizes small; prefer streaming small chunks.

Observability via Socket.io

Connect to the same origin with Socket.io to observe events:

- `ws:connected`, `ws:message`, `ws:closed`, `ws:error`
- `twilio:start`, `twilio:tx`
- `bridge:forwarded`, `bridge:dropped`, `bridge:error`

Docker / EasyPanel

Build and run:

```
docker build -t twilio-n8n-bridge .
docker run -p 1971:1971 \
  -e PORT=1971 -e HOST=0.0.0.0 \
  -e WS_AUTH_TOKEN=changeme \
  -e N8N_WS_URL=ws://n8n:5678 \
  -e N8N_WEBHOOK_URL=https://n8n/webhook/flow \
  twilio-n8n-bridge
```

In EasyPanel, create an app from this Dockerfile, set the same env vars, and enable HTTPS. Point Twilio to the public WSS URL.

Security

- Use HTTPS/WSS only.
- Set `WS_AUTH_TOKEN` and use `?token=...` in connection URLs.
- Optionally restrict by IP at your proxy.

Endpoints

- Health: `GET /health`
- Twilio WS: `wss://host/ws/twilio[?token=...]`
- n8n WS inbound: `wss://host/ws/n8n[?token=...]`
- Socket.io: `wss://host/socket.io`


