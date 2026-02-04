import type { IncomingMessage } from 'node:http'

import type { ExecTarget } from './http-utils.ts'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { WS_TICKET_MAX_KUBECONFIG_BYTES } from './config.ts'
import { getDemoHtml } from './demo.ts'
import { parseUrl } from './http-utils.ts'
import { safeJsonStringify, toErrorMessage } from './protocol.ts'
import { issueWsTicket } from './ws-ticket.ts'

async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		let total = 0
		req.on('data', (chunk: Buffer) => {
			total += chunk.length
			if (total > limitBytes) {
				reject(new Error('Payload too large.'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks)))
		req.on('error', reject)
	})
}

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

		if (req.method === 'POST' && url.pathname === '/ws-ticket') {
			void (async () => {
				try {
					const limit = Number.isFinite(WS_TICKET_MAX_KUBECONFIG_BYTES) && WS_TICKET_MAX_KUBECONFIG_BYTES > 0
						? WS_TICKET_MAX_KUBECONFIG_BYTES
						: 256 * 1024
					const body = await readBody(req, limit + 16 * 1024)
					const raw = body.toString('utf8')
					let payload: unknown
					try {
						payload = JSON.parse(raw)
					}
					catch {
						res.statusCode = 400
						res.setHeader('content-type', 'application/json; charset=utf-8')
						res.end(safeJsonStringify({ ok: false, error: 'Invalid JSON body.' }))
						return
					}

					if (payload == null || typeof payload !== 'object') {
						res.statusCode = 400
						res.setHeader('content-type', 'application/json; charset=utf-8')
						res.end(safeJsonStringify({ ok: false, error: 'Invalid request body.' }))
						return
					}

					const v = payload as Record<string, unknown>
					const kubeconfigRaw = v['kubeconfig']
					if (typeof kubeconfigRaw !== 'string' || kubeconfigRaw.trim().length === 0) {
						res.statusCode = 400
						res.setHeader('content-type', 'application/json; charset=utf-8')
						res.end(safeJsonStringify({ ok: false, error: 'Missing required field: kubeconfig' }))
						return
					}

					const namespace = typeof v['namespace'] === 'string' ? v['namespace'].trim() : ''
					const pod = typeof v['pod'] === 'string' ? v['pod'].trim() : ''
					const container = typeof v['container'] === 'string' ? v['container'].trim() : ''
					if (!namespace || !pod) {
						res.statusCode = 400
						res.setHeader('content-type', 'application/json; charset=utf-8')
						res.end(safeJsonStringify({ ok: false, error: 'Missing required fields: namespace, pod' }))
						return
					}

					const target: ExecTarget = {
						namespace,
						pod,
						container: container.length > 0 ? container : undefined,
					}

					const kubeconfig = kubeconfigRaw
					if (Buffer.byteLength(kubeconfig, 'utf8') > limit) {
						res.statusCode = 413
						res.setHeader('content-type', 'application/json; charset=utf-8')
						res.end(safeJsonStringify({ ok: false, error: 'kubeconfig too large.' }))
						return
					}

					const ip = req.socket.remoteAddress
					const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
					const issued = issueWsTicket(kubeconfig, target, { ip: typeof ip === 'string' ? ip : undefined, userAgent })

					res.statusCode = 200
					res.setHeader('content-type', 'application/json; charset=utf-8')
					res.end(safeJsonStringify({ ok: true, ...issued }))
				}
				catch (err: unknown) {
					const msg = toErrorMessage(err)
					res.statusCode = msg.includes('Payload too large') ? 413 : 500
					res.setHeader('content-type', 'application/json; charset=utf-8')
					res.end(safeJsonStringify({ ok: false, error: msg }))
				}
			})()
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
