# Twilio Media Streams Bridge

A lightweight Node.js service that bridges Twilio Media Streams to n8n webhooks for voice agent processing.

## What it does

1. **Accepts Twilio Media Streams** over WebSocket at `/ws/twilio`
2. **Buffers audio chunks** and forwards them to n8n via HTTP webhook
3. **Streams audio data** in real-time as it arrives from Twilio
4. **Maintains stream state** for each active call

## Quick Start

### Local Development
```bash
npm install
npm start
```

### Docker
```bash
docker build -t twilio-bridge .
docker run -p 3000:3000 -e N8N_WEBHOOK_URL=https://your-n8n.com/webhook/voice twilio-bridge
```

## Environment Variables

```bash
PORT=3000                    # Server port (default: 3000)
HOST=0.0.0.0                # Server host (default: 0.0.0.0)
LOG_LEVEL=info              # Logging level
WS_AUTH_TOKEN=your-token    # Optional: WebSocket authentication token
N8N_WEBHOOK_URL=https://your-n8n.com/webhook/voice  # n8n webhook endpoint
```

## Twilio Setup

### TwiML for Voice Calls
```xml
<Response>
  <Connect>
    <Stream url="wss://your-bridge.com/ws/twilio?token=your-token">
      <Parameter name="workflow" value="voice-agent" />
    </Stream>
  </Connect>
</Response>
```

### WebSocket URL Format
```
wss://your-bridge.com/ws/twilio?token=your-token
```

## n8n Integration

### Webhook Payload Format

**Media Chunk:**
```json
{
  "event": "media",
  "streamSid": "MZxxxx",
  "media": {
    "payload": "base64-encoded-audio",
    "contentType": "audio/x-mulaw;rate=8000",
    "timestamp": 1234567890
  }
}
```

**Stream End:**
```json
{
  "event": "stop",
  "streamSid": "MZxxxx",
  "finalBuffer": [...],
  "duration": 15000
}
```

### n8n Workflow Example
1. **Webhook Trigger** - receives audio chunks
2. **STT Node** - transcribes audio (Google Speech-to-Text, Deepgram, etc.)
3. **AI Node** - processes transcript and generates response
4. **TTS Node** - converts response to audio
5. **HTTP Request** - sends audio back to Twilio (if needed)

## Architecture

```
Twilio Call → Media Stream → Bridge → n8n Webhook → STT → AI → TTS
```

- **Real-time streaming**: Audio chunks are processed as they arrive
- **Stateful**: Each call maintains its own buffer and metadata
- **Stateless**: n8n receives individual chunks, no persistent connection needed
- **Scalable**: Multiple concurrent calls supported

## Endpoints

- `GET /` - Service status
- `GET /health` - Health check
- `WSS /ws/twilio` - Twilio Media Streams WebSocket

## Security

- Optional token-based authentication via `WS_AUTH_TOKEN`
- Add `?token=your-token` to WebSocket URL
- Use HTTPS/WSS in production

## Deployment

### EasyPanel
1. Build and push Docker image
2. Set environment variables in app settings
3. Configure port mapping: `3000:3000`
4. Enable HTTPS for production

### Other Platforms
- **Railway**: Deploy directly from GitHub
- **Render**: Use Docker deployment
- **DigitalOcean App Platform**: Container deployment
- **AWS ECS**: Container orchestration

## Testing

### Test WebSocket Connection
```bash
# Install wscat
npm install -g wscat

# Connect to bridge
wscat -c 'wss://your-bridge.com/ws/twilio?token=your-token'

# Send test frame
{"event":"start","start":{"streamSid":"TEST123"}}
{"event":"media","streamSid":"TEST123","media":{"payload":"AAA=","contentType":"audio/x-mulaw;rate=8000"}}
{"event":"stop","streamSid":"TEST123"}
```

## Troubleshooting

- **Connection refused**: Check if bridge is running and port is accessible
- **Token errors**: Verify `WS_AUTH_TOKEN` matches URL parameter
- **n8n not receiving**: Check webhook URL and network connectivity
- **Audio issues**: Ensure Twilio sends `audio/x-mulaw;rate=8000` format

## License

MIT


