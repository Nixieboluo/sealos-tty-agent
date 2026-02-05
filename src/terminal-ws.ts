import type { ClientFrame } from '@sealos/tty-protocol'
import type { Buffer } from 'node:buffer'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { RawData } from 'ws'
import type WebSocket from 'ws'
import type { Session, WsConnection } from './terminal-session.ts'

import { randomUUID } from 'node:crypto'
import { safeParseClientFrame, toErrorMessage } from '@sealos/tty-protocol'
import { WebSocketServer } from 'ws'

import { cleanupSession, sendCtrl, startExecIfNeeded } from './terminal-session.ts'
import { Config } from './utils/config.ts'
import { parseExecQuery, parseUrl } from './utils/http-utils.ts'
import { logInfo, logWarn } from './utils/logger.ts'
import { markAliveOnPong, startHeartbeat } from './utils/ws-heartbeat.ts'
import { rawToBuffer, rawToString } from './utils/ws-message.ts'
import { createWsStreams } from './utils/ws-streams.ts'
import { consumeWsTicket } from './ws-ticket.ts'

type WsSendable = string | Uint8Array

function isOriginAllowed(origin: string | undefined): boolean {
	const allow = Config.WS_ALLOWED_ORIGINS
	if (allow.length === 0)
		return true
	if (typeof origin !== 'string' || origin.length === 0)
		return false
	return allow.includes(origin)
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
		maxPayload: Config.WS_MAX_PAYLOAD,
		perMessageDeflate: false,
	})

	startHeartbeat(wss, Config.WS_HEARTBEAT_INTERVAL_MS)

	const sessions = new Map<string, Session>()

	server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
		const url = parseUrl(req)
		if (url.pathname !== '/exec') {
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
		logInfo('ws connected', { id: conn.id })

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
				logWarn('ws auth failed (query ticket)', { id: conn.id, error: r.error })
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
				logInfo('ws authed (query ticket)', { id: conn.id })
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
			logWarn('ws auth timeout', { id: conn.id })
			try {
				conn.close(1008, 'auth timeout')
			}
			catch {}
			sessions.delete(conn.id)
			cleanupSession(sess)
		}, Config.WS_AUTH_TIMEOUT_MS)

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
					logWarn('ws auth failed (message)', { id: conn.id, error: r.error })
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
				logInfo('ws authed (message)', { id: conn.id })
				return
			}

			if (frame.type === 'ping') {
				sendCtrl(conn, { type: 'pong' })
				return
			}

			if (typeof sess.kubeconfig !== 'string' || sess.kubeconfig.length === 0) {
				sendCtrl(conn, { type: 'error', message: 'Not authenticated. First message must be { "type": "auth", "ticket": "..." }.' })
				logWarn('ws rejected: not authenticated', { id: conn.id })
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
				sess.stdout?.resize(frame.cols, frame.rows)
				return
			}

			if (frame.type === 'stdin') {
				try {
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
					logWarn('ws rejected (binary): not authenticated', { id: conn.id })
					try {
						conn.close(1008, 'not authenticated')
					}
					catch {}
					return
				}
				const buf = rawToBuffer(data)
				try {
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

			const parsedFrame = safeParseClientFrame(value)
			if (!parsedFrame.ok) {
				logWarn('ws invalid client frame', { id: conn.id, error: parsedFrame.error })
				sendCtrl(conn, { type: 'error', message: 'Invalid client frame.' })
				return
			}

			// Control frames go through ctrl stream for a unified flow.
			sess.streams.ctrl.write(parsedFrame.frame)
		}

		ws.on('message', (data: RawData, isBinary: boolean) => {
			void handleMessage(data, isBinary)
		})

		// ctrl-consumer: drive init/ping/resize/stdin from stream
		streams.ctrl.on('data', (frame: unknown) => {
			const parsedFrame = safeParseClientFrame(frame)
			if (!parsedFrame.ok) {
				logWarn('ws invalid client frame (ctrl stream)', { id: conn.id, error: parsedFrame.error })
				sendCtrl(conn, { type: 'error', message: 'Invalid client frame.' })
				return
			}
			void handleCtrl(parsedFrame.frame)
		})

		ws.on('close', () => {
			clearTimeout(authTimeout)
			const sess = sessions.get(conn.id)
			sessions.delete(conn.id)
			if (!sess)
				return

			logInfo('ws closed', { id: conn.id })
			cleanupSession(sess)
		})

		ws.on('error', (err) => {
			logWarn('ws error', { id: conn.id, error: toErrorMessage(err) })
		})
	})

	return wss
}
