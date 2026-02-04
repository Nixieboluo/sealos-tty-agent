import { createServer } from 'node:http'

import { getDemoHtml } from './demo.ts'
import { parseUrl } from './http-utils.ts'
import { safeJsonStringify, toErrorMessage } from './protocol.ts'

export function createHttpServer() {
	return createServer((req, res) => {
		const url = parseUrl(req)
		if (req.method === 'GET' && url.pathname === '/') {
			const body = safeJsonStringify({ name: 'sealos-tty-agent', ok: true })
			res.statusCode = 200
			res.setHeader('content-type', 'application/json; charset=utf-8')
			res.end(body)
			return
		}

		if (req.method === 'GET' && url.pathname === '/demo') {
			void (async () => {
				try {
					const html = await getDemoHtml()
					res.statusCode = 200
					res.setHeader('content-type', 'text/html; charset=utf-8')
					res.end(html)
				}
				catch (err: unknown) {
					res.statusCode = 500
					res.setHeader('content-type', 'text/plain; charset=utf-8')
					res.end(toErrorMessage(err))
				}
			})()
			return
		}

		res.statusCode = 404
		res.setHeader('content-type', 'text/plain; charset=utf-8')
		res.end('Not Found')
	})
}
