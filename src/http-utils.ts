import type { IncomingMessage } from 'node:http'

export type ExecQuery = {
	namespace: string
	pod: string
	container?: string
}

export function parseUrl(req: IncomingMessage): URL {
	const host = req.headers.host ?? 'localhost'
	const raw = req.url ?? '/'
	return new URL(raw, `http://${host}`)
}

export function parseExecQuery(req: IncomingMessage): { ok: true, query: ExecQuery } | { ok: false, error: string } {
	const url = parseUrl(req)
	const namespace = url.searchParams.get('namespace') ?? ''
	const pod = url.searchParams.get('pod') ?? ''
	const container = url.searchParams.get('container')
	const containerValue = typeof container === 'string' && container.length > 0 ? container : undefined

	if (!namespace)
		return { ok: false, error: 'Missing required query: namespace' }
	if (!pod)
		return { ok: false, error: 'Missing required query: pod' }

	return {
		ok: true,
		query: { namespace, pod, container: containerValue },
	}
}
