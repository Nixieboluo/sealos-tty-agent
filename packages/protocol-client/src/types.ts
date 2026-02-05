export type WsReadyState = 0 | 1 | 2 | 3

export type WsCloseEvent = {
	code?: number
	reason?: string
	wasClean?: boolean
}

export type WsMessageEvent = {
	data: unknown
}

export type WsErrorEvent = unknown

/**
 * A minimal WebSocket-like interface, compatible with browsers and many WS polyfills.
 */
export type WsLike = {
	readonly readyState: WsReadyState
	send: (data: string | Uint8Array) => void
	close: (code?: number, reason?: string) => void
	addEventListener?: ((type: 'open', listener: () => void) => void) & ((type: 'message', listener: (ev: WsMessageEvent) => void) => void) & ((type: 'close', listener: (ev: WsCloseEvent) => void) => void) & ((type: 'error', listener: (ev: WsErrorEvent) => void) => void)
	removeEventListener?: ((type: 'open', listener: () => void) => void) & ((type: 'message', listener: (ev: WsMessageEvent) => void) => void) & ((type: 'close', listener: (ev: WsCloseEvent) => void) => void) & ((type: 'error', listener: (ev: WsErrorEvent) => void) => void)
	onopen?: (() => void) | null
	onmessage?: ((ev: WsMessageEvent) => void) | null
	onclose?: ((ev: WsCloseEvent) => void) | null
	onerror?: ((ev: WsErrorEvent) => void) | null
	// Browsers support binaryType; polyfills may ignore it.
	binaryType?: 'blob' | 'arraybuffer'
}

export type WsFactory = (url: string) => WsLike

export type FetchLike = (input: string, init?: {
	method?: string
	headers?: Record<string, string>
	body?: string
	signal?: AbortSignal
}) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>
