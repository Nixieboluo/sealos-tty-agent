import type { Buffer } from 'node:buffer'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { RawData } from 'ws'
import type WebSocket from 'ws'
import type { ClientFrame } from './protocol.ts'
import type { Session, WsConnection } from './terminal-session.ts'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { WS_ALLOWED_ORIGINS, WS_AUTH_TIMEOUT_MS, WS_HEARTBEAT_INTERVAL_MS, WS_MAX_PAYLOAD } from './config.ts'
import { parseExecQuery, parseUrl } from './http-utils.ts'
import { debugLog } from './logger.ts'
import { isClientFrame, toErrorMessage } from './protocol.ts'
import { cleanupSession, sendCtrl, startExecIfNeeded } from './terminal-session.ts'
import { markAliveOnPong, startHeartbeat } from './ws-heartbeat.ts'
import { rawToBuffer, rawToString } from './ws-message.ts'
import { createWsStreams } from './ws-streams.ts'
import { consumeWsTicket } from './ws-ticket.ts'

type WsSendable = string | Uint8Array

function isOriginAllowed(origin: string | undefined): boolean {
	const allow = WS_ALLOWED_ORIGINS
	if (!allow)
		return true
	if (typeof origin !== 'string' || origin.length === 0)
		return false
	const allowed = allow.split(',').map(s => s.trim()).filter(Boolean)
	return allowed.includes(origin)
}

function getPeerMeta(req: IncomingMessage): { ip?: string, userAgent?: string } {
	const ip = req.socket.remoteAddress
	const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
	return { ip: typeof ip === 'string' && ip.length > 0 ? ip : undefined, userAgent }
}

function makeConnection(ws: WebSocket): WsConnection {
	const id = randomUUID()
	return {
		id,
		send: (data: WsSendable) => ws.send(data),
		close: (code?: number, reason?: string) => ws.close(code, reason),
	}
}

export function attachTerminalWebSocketServer(server: HttpServer): WebSocketServer {
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: Number.isFinite(WS_MAX_PAYLOAD) && WS_MAX_PAYLOAD > 0 ? WS_MAX_PAYLOAD : 1024 * 1024,
		perMessageDeflate: false,
	})

	startHeartbeat(wss, WS_HEARTBEAT_INTERVAL_MS)

	const sessions = new Map<string, Session>()

	server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
		const url = parseUrl(req)
		if (url.pathname !== '/api/terminal/exec') {
			socket.destroy()
			return
		}

		if (!isOriginAllowed(typeof req.headers.origin === 'string' ? req.headers.origin : undefined)) {
			socket.destroy()
			return
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req)
		})
	})

	wss.on('connection', (ws, req) => {
		markAliveOnPong(ws)

		const parsed = parseExecQuery(req)
		if (!parsed.ok) {
			ws.close(1008, parsed.error)
			return
		}

		const conn = makeConnection(ws)
		debugLog('ws open', { id: conn.id, query: parsed.query })

		const streams = createWsStreams(ws)
		const meta = getPeerMeta(req)
		sessions.set(conn.id, {
			started: false,
			starting: false,
			streams,
		})

		// Optional: allow passing ticket in URL query for non-browser clients.
		const initialTicket = parsed.query.ticket
		if (typeof initialTicket === 'string' && initialTicket.length > 0) {
			const r = consumeWsTicket(initialTicket, meta)
			if (!r.ok) {
				sendCtrl(conn, { type: 'error', message: r.error })
				try {
					conn.close(1008, 'invalid ticket')
				}
				catch {}
				return
			}
			const sess = sessions.get(conn.id)
			if (sess) {
				sess.kubeconfig = r.kubeconfig
				sess.target = r.target
				sendCtrl(conn, { type: 'authed' })
			}
		}

		sendCtrl(conn, { type: 'ready' })

		const authTimeout = setTimeout(() => {
			const sess = sessions.get(conn.id)
			if (!sess)
				return
			if (typeof sess.kubeconfig === 'string' && sess.kubeconfig.length > 0)
				return
			sendCtrl(conn, { type: 'error', message: 'Auth timeout: first message must be { "type": "auth", "ticket": "..." }.' })
			try {
				conn.close(1008, 'auth timeout')
			}
			catch {}
			sessions.delete(conn.id)
			cleanupSession(sess)
		}, Number.isFinite(WS_AUTH_TIMEOUT_MS) && WS_AUTH_TIMEOUT_MS > 0 ? WS_AUTH_TIMEOUT_MS : 10_000)

		const handleCtrl = async (frame: ClientFrame): Promise<void> => {
			const sess = sessions.get(conn.id)
			if (!sess)
				return

			if (frame.type === 'auth') {
				if (typeof sess.kubeconfig === 'string' && sess.kubeconfig.length > 0) {
					sendCtrl(conn, { type: 'authed' })
					return
				}
				const r = consumeWsTicket(frame.ticket, meta)
				if (!r.ok) {
					sendCtrl(conn, { type: 'error', message: r.error })
					try {
						conn.close(1008, 'invalid ticket')
					}
					catch {}
					return
				}
				sess.kubeconfig = r.kubeconfig
				sess.target = r.target
				sendCtrl(conn, { type: 'authed' })
				return
			}

			if (frame.type === 'ping') {
				sendCtrl(conn, { type: 'pong' })
				return
			}

			if (typeof sess.kubeconfig !== 'string' || sess.kubeconfig.length === 0) {
				sendCtrl(conn, { type: 'error', message: 'Not authenticated. First message must be { "type": "auth", "ticket": "..." }.' })
				try {
					conn.close(1008, 'not authenticated')
				}
				catch {}
				return
			}

			if (frame.type === 'resize') {
				if (!sess.started) {
					await startExecIfNeeded(conn, sess, { cols: frame.cols, rows: frame.rows })
					return
				}
				debugLog('resize', { id: conn.id, size: { cols: frame.cols, rows: frame.rows } })
				sess.stdout?.resize(frame.cols, frame.rows)
				return
			}

			if (frame.type === 'stdin') {
				try {
					debugLog('stdin', { id: conn.id, bytes: frame.data.length })
					sess.streams.stdin.write(frame.data)
				}
				catch (err: unknown) {
					sendCtrl(conn, { type: 'error', message: toErrorMessage(err) })
				}
			}
		}

		const handleMessage = async (data: RawData, isBinary: boolean): Promise<void> => {
			const sess = sessions.get(conn.id)
			if (!sess)
				return

			if (isBinary) {
				if (typeof sess.kubeconfig !== 'string' || sess.kubeconfig.length === 0) {
					sendCtrl(conn, { type: 'error', message: 'Not authenticated. First message must be { "type": "auth", "ticket": "..." }.' })
					try {
						conn.close(1008, 'not authenticated')
					}
					catch {}
					return
				}
				const buf = rawToBuffer(data)
				try {
					debugLog('stdin (binary)', { id: conn.id, bytes: buf.length })
					sess.streams.stdin.write(buf)
				}
				catch (err: unknown) {
					sendCtrl(conn, { type: 'error', message: toErrorMessage(err) })
				}
				return
			}

			let value: unknown
			try {
				value = JSON.parse(rawToString(data))
			}
			catch {
				sendCtrl(conn, { type: 'error', message: 'Invalid JSON message.' })
				return
			}

			if (!isClientFrame(value)) {
				sendCtrl(conn, { type: 'error', message: 'Invalid client frame.' })
				return
			}

			// Control frames go through ctrl stream for a unified flow.
			sess.streams.ctrl.write(value)
		}

		ws.on('message', (data: RawData, isBinary: boolean) => {
			void handleMessage(data, isBinary)
		})

		// ctrl-consumer: drive init/ping/resize/stdin from stream
		streams.ctrl.on('data', (frame: unknown) => {
			if (!isClientFrame(frame)) {
				sendCtrl(conn, { type: 'error', message: 'Invalid client frame.' })
				return
			}
			void handleCtrl(frame)
		})

		ws.on('close', () => {
			clearTimeout(authTimeout)
			const sess = sessions.get(conn.id)
			sessions.delete(conn.id)
			if (!sess)
				return

			debugLog('ws close', { id: conn.id })
			cleanupSession(sess)
		})

		ws.on('error', (err) => {
			debugLog('ws error', err)
		})
	})

	return wss
}
