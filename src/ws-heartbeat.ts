import type WebSocket from 'ws'
import type { WebSocketServer } from 'ws'

type WsWithHeartbeat = WebSocket & { isAlive?: boolean }

export function startHeartbeat(wss: WebSocketServer, intervalMs: number): () => void {
	const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000

	const timer = setInterval(() => {
		for (const client of wss.clients) {
			const ws = client as WsWithHeartbeat
			if (ws.isAlive === false) {
				try {
					ws.terminate()
				}
				catch {}
				continue
			}
			ws.isAlive = false
			try {
				ws.ping()
			}
			catch {}
		}
	}, ms)

	timer.unref?.()

	return () => clearInterval(timer)
}

export function markAliveOnPong(ws: WebSocket): void {
	const s = ws as WsWithHeartbeat
	s.isAlive = true
	ws.on('pong', () => {
		s.isAlive = true
	})
}
