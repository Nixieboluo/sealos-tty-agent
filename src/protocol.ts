export type ClientFrame
	= | { type: 'stdin', data: string }
		| { type: 'auth', ticket: string }
		| { type: 'resize', cols: number, rows: number }
		| { type: 'ping' }

export type ServerFrame
	= | { type: 'ready' }
		| { type: 'authed' }
		| { type: 'started' }
		| { type: 'stdout', data: string }
		| { type: 'status', status: unknown }
		| { type: 'error', message: string }
		| { type: 'pong' }

export function safeJsonStringify(value: unknown): string {
	const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)
	const json = JSON.stringify(value, replacer)
	return typeof json === 'string' ? json : ''
}

export function toErrorMessage(err: unknown): string {
	if (err instanceof Error)
		return err.message
	if (typeof err === 'string')
		return err

	if (err !== null && typeof err === 'object') {
		const e = err as Record<string, unknown>

		// DOM ErrorEvent-like
		const msg = e['message']
		if (typeof msg === 'string' && msg.length > 0)
			return msg

		const code = e['code']
		const name = e['name']

		const inner = e['error']
		if (inner instanceof Error && inner.message)
			return inner.message
		if (typeof inner === 'string' && inner.length > 0)
			return inner

		// Node-style errors sometimes carry `reason`
		const reason = e['reason']
		if (typeof reason === 'string' && reason.length > 0)
			return reason

		if (typeof name === 'string' && name.length > 0 && typeof code === 'string' && code.length > 0)
			return `${name} (${code})`
		if (typeof name === 'string' && name.length > 0)
			return name
		if (typeof code === 'string' && code.length > 0)
			return code
	}

	return safeJsonStringify(err)
}

export function isClientFrame(value: unknown): value is ClientFrame {
	if (value == null || typeof value !== 'object')
		return false

	const v = value as Record<string, unknown>
	if (v['type'] === 'auth')
		return typeof v['ticket'] === 'string'
	if (v['type'] === 'stdin')
		return typeof v['data'] === 'string'
	if (v['type'] === 'resize')
		return typeof v['cols'] === 'number' && typeof v['rows'] === 'number'
	if (v['type'] === 'ping')
		return true
	return false
}
