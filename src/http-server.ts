import type { ExecTarget } from './http-utils.ts'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { z } from 'zod'
import { Config } from './config.ts'
import { HTTP_ERRORS, parseUrl, readBody, sendJson, sendJsonError } from './http-utils.ts'
import { toErrorMessage } from './protocol.ts'
import { issueWsTicket } from './ws-ticket.ts'

const WsTicketRequestSchema = z.object({
	kubeconfig: z.string().min(1).refine(s => s.trim().length > 0, { message: 'kubeconfig cannot be empty' }),
	namespace: z.string().trim().min(1),
	pod: z.string().trim().min(1),
	container: z.string().trim().min(1).optional(),
}).strict()

export function createHttpServer() {
	return createServer((req, res) => {
		const url = parseUrl(req)
		if (req.method === 'GET' && url.pathname === '/') {
			sendJson(res, 200, { name: 'sealos-tty-agent', ok: true })
			return
		}

		if (req.method === 'POST' && url.pathname === '/ws-ticket') {
			void (async () => {
				try {
					const limit = Config.WS_TICKET_MAX_KUBECONFIG_BYTES
					const body = await readBody(req, limit + 16 * 1024)
					const raw = body.toString('utf8')
					let payload: unknown
					try {
						payload = JSON.parse(raw)
					}
					catch {
						sendJsonError(res, 400, HTTP_ERRORS.InvalidJsonBody)
						return
					}

					if (payload == null || typeof payload !== 'object') {
						sendJsonError(res, 400, HTTP_ERRORS.InvalidRequestBody)
						return
					}

					const parsed = WsTicketRequestSchema.safeParse(payload)
					if (!parsed.success) {
						const paths = new Set(parsed.error.issues.map(i => i.path[0]).filter(Boolean))
						if (paths.has('kubeconfig')) {
							sendJsonError(res, 400, HTTP_ERRORS.MissingKubeconfig)
							return
						}
						if (paths.has('namespace') || paths.has('pod')) {
							sendJsonError(res, 400, HTTP_ERRORS.MissingTargetFields)
							return
						}
						sendJsonError(res, 400, HTTP_ERRORS.InvalidRequestBody)
						return
					}

					const { kubeconfig: kubeconfigRaw, namespace, pod, container } = parsed.data

					const target: ExecTarget = {
						namespace,
						pod,
						container: typeof container === 'string' && container.length > 0 ? container : undefined,
					}

					const kubeconfig = kubeconfigRaw
					if (Buffer.byteLength(kubeconfig, 'utf8') > limit) {
						sendJsonError(res, 413, HTTP_ERRORS.KubeconfigTooLarge)
						return
					}

					const ip = req.socket.remoteAddress
					const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
					const issued = issueWsTicket(kubeconfig, target, { ip: typeof ip === 'string' ? ip : undefined, userAgent })

					sendJson(res, 200, { ok: true, ...issued })
				}
				catch (err: unknown) {
					const msg = toErrorMessage(err)
					if (msg === HTTP_ERRORS.PayloadTooLarge) {
						sendJsonError(res, 413, HTTP_ERRORS.PayloadTooLarge)
						return
					}
					sendJsonError(res, 500, msg)
				}
			})()
			return
		}

		res.statusCode = 404
		res.setHeader('content-type', 'text/plain; charset=utf-8')
		res.end('Not Found')
	})
}
