# sealos-tty-agent

Kubernetes `exec` terminal gateway over WebSocket.

```
Browser (xterm.js) <-> this server (WS) <-> Kubernetes API Server (exec) <-> Pod PTY
```

## What’s in this repo

- **Server**: `sealos-tty-agent` — a small HTTP + WebSocket gateway that turns Kubernetes `pods/exec` into a browser-friendly terminal stream.
- **Client**: `@labring/sealos-tty-client` — a Web Streams API client (in `packages/protocol-client`) that handles ticket issuance + WebSocket wiring for you.

## Server usage

### Local (dev)

```bash
pnpm install
cp config.example.json config.json
pnpm run dev
```

Default: `http://localhost:3000`.

### Production

_TBD_

## Client usage

The recommended client is `@labring/sealos-tty-client` (Web Streams API), designed for browser terminals like `xterm.js`.

```bash
pnpm add @labring/sealos-tty-client
```

Minimal browser example (xterm-style wiring):

```ts
import { connectTerminalStreams } from '@labring/sealos-tty-client'

const { stdout, stdin, resize } = await connectTerminalStreams({
	client: { baseUrl: 'http://localhost:3000' },
	ticketRequest: { kubeconfig, namespace: 'default', pod: 'mypod', container: 'c1' },
	connect: { initialSize: { cols: term.cols, rows: term.rows } },
})

const enc = new TextEncoder()
const writer = stdin.getWriter()
term.onData(d => void writer.write(enc.encode(d)))
term.onResize(({ cols, rows }) => resize(cols, rows))

void stdout
	.pipeThrough(new TextDecoderStream())
	.pipeTo(new WritableStream({ write: s => term.write(s) }))
```

Notes:

- The server starts Kubernetes `exec` only after receiving the **first** `resize`.
- If you need lower-level access, call the HTTP API to get a ticket, then connect to `GET /exec` via WebSocket.

## Run

```bash
pnpm install
pnpm run dev
```

## API

### `POST /ws-ticket`

Issues a short-lived, one-time ticket for browser clients.

Request body:

```json
{
	"kubeconfig": "...",
	"namespace": "default",
	"pod": "mypod",
	"container": "c1",
	"command": ["bash", "-il"]
}
```

Response:

```json
{ "ok": true, "ticket": "...", "expiresAt": 0 }
```

### `GET /exec` (WebSocket)

- If you cannot put the ticket in the URL, the first non-ping JSON message **must** be:
  - `{ "type": "auth", "ticket": "..." }`
- After auth, the client **must** send the first resize:
  - `{ "type": "resize", "cols": 120, "rows": 30 }`
  - The server starts Kubernetes exec only after receiving the first resize.

Binary frames:

- Client -> Server: stdin bytes
- Server -> Client: stdout/stderr bytes (TTY usually merged)

## Security

`kubeconfig` is sensitive. Use HTTPS/WSS and restrict RBAC for `pods/exec`.
