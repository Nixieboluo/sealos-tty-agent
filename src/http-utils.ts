import type { IncomingMessage } from 'node:http'

export type ExecTarget = {
	namespace: string
	pod: string
	container?: string
}

export type ExecQuery = {
	ticket?: string
}

export function parseUrl(req: IncomingMessage): URL {
	const host = req.headers.host ?? 'localhost'
	const raw = req.url ?? '/'
	return new URL(raw, `http://${host}`)
}

export function parseExecQuery(req: IncomingMessage): { ok: true, query: ExecQuery } | { ok: false, error: string } {
	const url = parseUrl(req)
	const ticket = url.searchParams.get('ticket')
	const ticketValue = typeof ticket === 'string' && ticket.length > 0 ? ticket : undefined

	return {
		ok: true,
		query: { ticket: ticketValue },
	}
}
