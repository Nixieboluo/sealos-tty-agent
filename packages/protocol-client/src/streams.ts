import type { ServerFrame } from './protocol.js'
import type { FetchLike, WsCloseEvent, WsFactory, WsLike } from './types.js'
import { safeJsonStringify, toErrorMessage } from './protocol.js'

export type TerminalStreams = {
	/**
	 * Session state transitions.
	 */
	state: ReadableStream<TerminalSessionState>
	/**
	 * JSON control frames from server (ready/authed/started/status/error/pong).
	 */
	frames: ReadableStream<ServerFrame>
	/**
	 * Binary stdout/stderr bytes from server.
	 */
	stdout: ReadableStream<Uint8Array>
	/**
	 * Binary stdin bytes to server.
	 */
	stdin: WritableStream<Uint8Array>
	/**
	 * Resize terminal. The first resize triggers exec start on server-side.
	 */
	resize: (cols: number, rows: number) => void
	/**
	 * Close the underlying websocket.
	 */
	close: (code?: number, reason?: string) => void
}

export type ConnectTerminalStreamsOptions = {
	client: ProtocolClientOptions
	connect: TerminalSessionConnectOptions
	/**
	 * Optional helper to fetch ticket by calling `/ws-ticket`.
	 * If provided, `connect.ticket` is not required.
	 */
	ticketRequest?: WsTicketRequest
	/**
	 * Abort the connection and close streams.
	 */
	signal?: AbortSignal
}

type Ctrl<T> = ReadableStreamDefaultController<T>

function tryClose<T>(c: Ctrl<T> | null | undefined): void {
	try {
		c?.close()
	}
	catch {}
}

function tryError<T>(c: Ctrl<T> | null | undefined, err: unknown): void {
	try {
		c?.error(err)
	}
	catch {}
}

/**
 * Connect and expose a Web Streams API interface.
 *
 * Design notes:
 * - stdout is a binary stream (Uint8Array). For xterm, you usually want:
 *   `stdout.pipeThrough(new TextDecoderStream()).pipeTo(...)`.
 * - stdin is a binary WritableStream. For xterm:
 *   `term.onData(d => writer.write(new TextEncoder().encode(d)))`.
 */
export type TicketTarget = {
	namespace: string
	pod: string
	container?: string
	command?: string[]
}

export type WsTicketRequest = TicketTarget & {
	kubeconfig: string
}

export type WsTicketResponse = {
	ok: true
	ticket: string
	expiresAt: number
}

export type ErrorResponse = {
	ok: false
	error: string
}

export type ProtocolClientOptions = {
	baseUrl: string
	/**
	 * Override fetch implementation. If omitted, uses global fetch when available.
	 */
	fetch?: FetchLike
	/**
	 * Override WebSocket factory. If omitted, uses global WebSocket when available.
	 */
	wsFactory?: WsFactory
	wsPath?: string
	ticketPath?: string
}

export type TerminalSessionState
	= | 'idle'
		| 'connecting'
		| 'ready'
		| 'authed'
		| 'starting'
		| 'started'
		| 'closed'
		| 'error'

export type TerminalSessionConnectOptions = {
	/**
	 * Use an existing ticket.
	 */
	ticket?: string
	/**
	 * Provide a ticket lazily (e.g. by calling your own backend).
	 */
	ticketProvider?: (signal: AbortSignal) => Promise<string>
	/**
	 * Provide initial terminal size (cols/rows). If omitted, you can call `resize()` later.
	 * Note: server will only start exec after receiving the first resize.
	 */
	initialSize?: { cols: number, rows: number }
	/**
	 * If true, puts ticket into WS query (?ticket=...). Useful for non-browser clients.
	 * Default: false (send auth control frame).
	 */
	ticketInQuery?: boolean
}

function defaultFetchLike(): FetchLike {
	const f = (globalThis as unknown as { fetch?: unknown }).fetch
	if (typeof f !== 'function')
		throw new Error('fetch is not available. Provide ProtocolClientOptions.fetch.')
	return f as FetchLike
}

function defaultWsFactory(): WsFactory {
	const ws = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
	if (typeof ws !== 'function')
		throw new Error('WebSocket is not available. Provide ProtocolClientOptions.wsFactory.')
	return (url: string) => new (ws as new (url: string) => WsLike)(url)
}

function joinUrl(base: string, path: string): string {
	const u = new URL(base)
	const p = path.startsWith('/') ? path : `/${path}`
	u.pathname = p
	return u.toString()
}

function toWsUrl(httpBase: string, wsPath: string, ticketInQuery?: string): string {
	const u = new URL(joinUrl(httpBase, wsPath))
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
	if (typeof ticketInQuery === 'string' && ticketInQuery.length > 0)
		u.searchParams.set('ticket', ticketInQuery)
	return u.toString()
}

async function normalizeBinary(data: unknown): Promise<Uint8Array | null> {
	if (data instanceof Uint8Array)
		return data
	if (data instanceof ArrayBuffer)
		return new Uint8Array(data)

	// Blob (browser)
	const maybeBlob = data as { arrayBuffer?: () => Promise<ArrayBuffer> } | null
	if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') {
		const buf = await maybeBlob.arrayBuffer()
		return new Uint8Array(buf)
	}

	return null
}

async function createOpenPromise(ws: WsLike): Promise<void> {
	if (ws.readyState === 1)
		return
	return new Promise((resolve, reject) => {
		function cleanup(): void {
			try {
				ws.removeEventListener?.('open', onOpen)
			}
			catch {}
			try {
				ws.removeEventListener?.('error', onError as never)
			}
			catch {}
			if (ws.onopen === onOpen)
				ws.onopen = null
			if (ws.onerror === onError)
				ws.onerror = null
		}

		function onOpen(): void {
			cleanup()
			resolve()
		}

		function onError(ev: unknown): void {
			cleanup()
			reject(ev)
		}

		if (typeof ws.addEventListener === 'function') {
			ws.addEventListener('open', onOpen)
			ws.addEventListener('error', onError as never)
		}
		else {
			ws.onopen = onOpen
			ws.onerror = onError
		}
	})
}

export async function issueWsTicket(client: ProtocolClientOptions, req: WsTicketRequest, signal?: AbortSignal): Promise<WsTicketResponse> {
	const fetchLike = client.fetch ?? defaultFetchLike()
	const baseUrl = client.baseUrl.replace(/\/$/, '')
	const ticketPath = client.ticketPath ?? '/ws-ticket'
	const url = joinUrl(baseUrl, ticketPath)

	const res = await fetchLike(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(req),
		signal,
	})

	const data: unknown = await res.json().catch(() => null)
	if (!res.ok)
		throw new Error(`failed to get ticket: HTTP ${res.status}`)
	if (data === null || typeof data !== 'object')
		throw new Error(`failed to get ticket: invalid JSON response (HTTP ${res.status})`)

	const r = data as Partial<WsTicketResponse> & Partial<ErrorResponse>
	if (r.ok === true && typeof r.ticket === 'string' && typeof r.expiresAt === 'number')
		return { ok: true, ticket: r.ticket, expiresAt: r.expiresAt }

	const msg = r.ok === false && typeof r.error === 'string' ? r.error : `HTTP ${res.status}`
	throw new Error(`failed to get ticket: ${msg}`)
}

export async function connectTerminalStreams(options: ConnectTerminalStreamsOptions): Promise<TerminalStreams> {
	const baseUrl = options.client.baseUrl.replace(/\/$/, '')
	const wsPath = options.client.wsPath ?? '/exec'
	const wsFactory = options.client.wsFactory ?? defaultWsFactory()

	const ac = new AbortController()
	if (options.signal) {
		if (options.signal.aborted) {
			ac.abort()
		}
		else {
			options.signal.addEventListener('abort', () => ac.abort(), { once: true })
		}
	}

	let ticket = options.connect.ticket
	if (options.ticketRequest) {
		const r = await issueWsTicket(options.client, options.ticketRequest, ac.signal)
		ticket = r.ticket
	}
	if ((typeof ticket !== 'string' || ticket.trim().length === 0) && typeof options.connect.ticketProvider === 'function')
		ticket = await options.connect.ticketProvider(ac.signal)
	if (typeof ticket !== 'string' || ticket.trim().length === 0)
		throw new Error('ticket is required (provide connect.ticket/connect.ticketProvider or ticketRequest)')

	const wsUrl = toWsUrl(baseUrl, wsPath, options.connect.ticketInQuery === true ? ticket : undefined)
	let ws: WsLike
	try {
		ws = wsFactory(wsUrl)
	}
	catch (err) {
		throw new Error(`failed to create WebSocket: ${toErrorMessage(err)}`)
	}

	// Prefer deterministic binary in browsers.
	if (typeof ws.binaryType === 'string')
		ws.binaryType = 'arraybuffer'

	const openP = createOpenPromise(ws)

	let stateCtrl: Ctrl<TerminalSessionState> | null = null
	let framesCtrl: Ctrl<ServerFrame> | null = null
	let stdoutCtrl: Ctrl<Uint8Array> | null = null

	let state: TerminalSessionState = 'connecting'
	let pendingResize: { cols: number, rows: number } | null = options.connect.initialSize ?? null
	let initialResizeSent = false

	const stateStream = new ReadableStream<TerminalSessionState>({
		start(controller) {
			stateCtrl = controller
			controller.enqueue(state)
		},
		cancel() {
			stateCtrl = null
		},
	})

	const framesStream = new ReadableStream<ServerFrame>({
		start(controller) {
			framesCtrl = controller
		},
		cancel() {
			framesCtrl = null
		},
	})

	const stdoutStream = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutCtrl = controller
		},
		cancel() {
			stdoutCtrl = null
		},
	})

	const setState = (next: TerminalSessionState) => {
		if (state === next)
			return
		state = next
		if (stateCtrl)
			stateCtrl.enqueue(next)
	}

	const sendCtrl = async (frame: unknown) => {
		await openP
		ws.send(safeJsonStringify(frame))
	}

	const flushResizeIfPossible = async () => {
		if (!pendingResize)
			return
		if (initialResizeSent)
			return
		if (state !== 'authed' && state !== 'starting' && state !== 'started')
			return
		const { cols, rows } = pendingResize
		pendingResize = null
		initialResizeSent = true
		setState(state === 'authed' ? 'starting' : state)
		await sendCtrl({ type: 'resize', cols, rows })
	}

	const onMessage = async (ev: { data: unknown }) => {
		const u8 = await normalizeBinary(ev.data)
		if (u8) {
			if (stdoutCtrl)
				stdoutCtrl.enqueue(u8)
			return
		}

		if (typeof ev.data !== 'string')
			return

		let msg: unknown
		try {
			msg = JSON.parse(ev.data)
		}
		catch {
			return
		}

		const frame = msg as Partial<ServerFrame> | null
		if (!frame || typeof frame.type !== 'string')
			return

		if (framesCtrl)
			framesCtrl.enqueue(frame as ServerFrame)

		if (frame.type === 'ready')
			setState(state === 'authed' || state === 'starting' || state === 'started' ? state : 'ready')
		if (frame.type === 'authed') {
			setState('authed')
			void flushResizeIfPossible()
		}
		if (frame.type === 'started')
			setState('started')
		if (frame.type === 'error')
			setState('error')
	}

	const onClose = (_ev: WsCloseEvent) => {
		setState('closed')
		tryClose(stateCtrl)
		tryClose(framesCtrl)
		tryClose(stdoutCtrl)
	}

	const onError = (ev: unknown) => {
		const err = new Error(`WebSocket error: ${toErrorMessage(ev)}`)
		tryError(stateCtrl, err)
		tryError(framesCtrl, err)
		tryError(stdoutCtrl, err)
	}

	if (typeof ws.addEventListener === 'function') {
		ws.addEventListener('message', onMessage as never)
		ws.addEventListener('close', onClose as never)
		ws.addEventListener('error', onError as never)
	}
	else {
		ws.onmessage = onMessage as never
		ws.onclose = onClose
		ws.onerror = onError
	}

	// Auth after open (unless ticket is embedded in query).
	if (options.connect.ticketInQuery !== true) {
		void openP.then(async () => {
			await sendCtrl({ type: 'auth', ticket })
		}).catch(() => {})
	}

	// If the ticket is in query, server might authed quickly; still allow initial resize after authed.
	void openP.then(() => setState('connecting')).catch(() => {})

	const stdin = new WritableStream<Uint8Array>({
		async write(chunk) {
			await openP
			ws.send(chunk)
		},
		close() {
			try {
				ws.close()
			}
			catch {}
		},
		abort(reason) {
			try {
				ws.close(1000, typeof reason === 'string' ? reason : 'aborted')
			}
			catch {}
		},
	})

	const resize = (cols: number, rows: number) => {
		if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1)
			return
		if (!initialResizeSent)
			pendingResize = { cols, rows }
		else
			void sendCtrl({ type: 'resize', cols, rows }).catch(() => {})

		void flushResizeIfPossible()
	}

	const close = (code?: number, reason?: string) => {
		try {
			ws.close(code, reason)
		}
		catch {}
	}

	if (ac.signal.aborted) {
		close(1000, 'aborted')
	}
	else {
		ac.signal.addEventListener('abort', () => close(1000, 'aborted'), { once: true })
	}

	return {
		state: stateStream,
		frames: framesStream,
		stdout: stdoutStream,
		stdin,
		resize,
		close,
	}
}
