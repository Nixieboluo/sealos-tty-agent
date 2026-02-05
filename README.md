# sealos-tty-agent

Kubernetes `exec` terminal gateway over WebSocket.

```
Browser (xterm.js) <-> this server (WS) <-> Kubernetes API Server (exec) <-> Pod PTY
```

## Run

```bash
pnpm install
pnpm run dev
```

Default: `http://localhost:3000`.

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

See `openapi.yaml` for full details.

## Security

`kubeconfig` is sensitive. Use HTTPS/WSS and restrict RBAC for `pods/exec`.
