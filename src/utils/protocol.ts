import { z } from 'zod'

const ClientStdinTextSchema = z.object({
	type: z.literal('stdin'),
	data: z.string(),
}).strict()

const ClientAuthSchema = z.object({
	type: z.literal('auth'),
	ticket: z.string().trim().min(1),
}).strict()

const ClientResizeSchema = z.object({
	type: z.literal('resize'),
	cols: z.number().int().min(1),
	rows: z.number().int().min(1),
}).strict()

const ClientPingSchema = z.object({
	type: z.literal('ping'),
}).strict()

export const ClientFrameSchema = z.discriminatedUnion('type', [
	ClientStdinTextSchema,
	ClientAuthSchema,
	ClientResizeSchema,
	ClientPingSchema,
])

export type ClientFrame = z.infer<typeof ClientFrameSchema>

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
	return ClientFrameSchema.safeParse(value).success
}

export function safeParseClientFrame(value: unknown): { ok: true, frame: ClientFrame } | { ok: false, error: string } {
	const r = ClientFrameSchema.safeParse(value)
	if (r.success)
		return { ok: true, frame: r.data }

	const detail = r.error.issues
		.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
		.join('; ')
	return { ok: false, error: detail }
}
