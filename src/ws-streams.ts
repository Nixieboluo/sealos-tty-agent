import type WebSocket from 'ws'
import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'

export type WsStreams = {
	stdin: PassThrough
	/**
	 * Reserved for future: structured control flow (resize, audit events, mux, etc.).
	 * Currently not used; kept to align with the "ws as streams" design.
	 */
	ctrl: PassThrough
	wsOut: Writable
}

function createWsOut(ws: WebSocket): Writable {
	return new Writable({
		write(chunk, _encoding, callback) {
			if (ws.readyState !== ws.OPEN) {
				callback(new Error('WebSocket is not open'))
				return
			}

			// Always send as binary. `ws` accepts Buffer/Uint8Array.
			const data
				= typeof chunk === 'string'
					? Buffer.from(chunk, 'utf8')
					: Buffer.isBuffer(chunk)
						? chunk
						: chunk instanceof Uint8Array
							? chunk
							: Buffer.from(String(chunk), 'utf8')

			ws.send(data, { binary: true }, err => callback(err ?? undefined))
		},
	})
}

export function createWsStreams(ws: WebSocket): WsStreams {
	const stdin = new PassThrough()
	const ctrl = new PassThrough({ objectMode: true })
	const wsOut = createWsOut(ws)
	return { stdin, ctrl, wsOut }
}
