# LiveKit pilot browser

Isolated Vite frontend using the official LiveKit JS Room and React
RoomAudioRenderer/StartAudio. The app does not need any model credentials or
LiveKit API secret. Only the short-lived participant token is received and held
in memory.

Use Node 22.12+ (Spark has 22.20.0). Build from this directory:

```sh
npm ci --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund
npm run build
```

Serve the generated dist directory through the pilot's loopback Python HTTP
server, not a separate public development server. Direct versions and their
resolved dependencies are pinned by package.json and package-lock.json.

The pilot page is http://127.0.0.1:18790/. The same-origin POST /api/token accepts
an empty JSON object and returns serverUrl, roomName, participantName and
participantToken. The page accepts only ws://127.0.0.1:18780 for LiveKit signaling.
The server must enforce the room, dispatch and grants; the browser sends no
room or agent selection. This frontend does not add Cloud endpoints, analytics,
chat, camera, screen share, audio recording or persisted browser state.

The existing SSH connection needs loopback forwards for the pilot web server,
LiveKit signaling, and RTC/ICE-TCP media. A working web page or signaling
connection alone does not establish media. Check ICE separately before an
actual call. Nothing dials until the consent checkbox and Start click.
