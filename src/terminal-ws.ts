import type { Buffer } from 'node:buffer'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { RawData } from 'ws'
import type WebSocket from 'ws'
import type { ExecQuery } from './http-utils.ts'
import type { ClientFrame } from './protocol.ts'
import type { Session, WsConnection } from './terminal-session.ts'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { WS_HEARTBEAT_INTERVAL_MS, WS_MAX_PAYLOAD } from './config.ts'
import { parseExecQuery, parseUrl } from './http-utils.ts'
import { debugLog } from './logger.ts'
import { isClientFrame, toErrorMessage } from './protocol.ts'
import { cleanupSession, sendCtrl, startExecIfNeeded } from './terminal-session.ts'
import { markAliveOnPong, startHeartbeat } from './ws-heartbeat.ts'
import { rawToBuffer, rawToString } from './ws-message.ts'
import { createWsStreams } from './ws-streams.ts'

type WsSendable = string | Uint8Array

function makeConnection(ws: WebSocket, query: ExecQuery): WsConnection {
	const id = randomUUID()
	return {
		id,
		query,
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

		const conn = makeConnection(ws, parsed.query)
		debugLog('ws open', { id: conn.id, query: conn.query })

		const streams = createWsStreams(ws)
		sessions.set(conn.id, {
			started: false,
			starting: false,
			streams,
		})

		sendCtrl(conn, { type: 'ready' })

		const handleCtrl = async (frame: ClientFrame): Promise<void> => {
			const sess = sessions.get(conn.id)
			if (!sess)
				return

			if (frame.type === 'init') {
				if (!sess.started && !sess.starting) {
					sess.kubeconfig = frame.kubeconfig
					debugLog('init received', { id: conn.id, kubeconfigBytes: frame.kubeconfig.length })
				}
				return
			}

			if (frame.type === 'ping') {
				sendCtrl(conn, { type: 'pong' })
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
