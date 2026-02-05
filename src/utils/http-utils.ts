import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import { safeJsonStringify } from '@labring/sealos-tty-client'

export const HTTP_JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

export const HTTP_ERRORS = {
	InvalidJsonBody: 'Invalid JSON body.',
	InvalidRequestBody: 'Invalid request body.',
	MissingKubeconfig: 'Missing required field: kubeconfig',
	MissingTargetFields: 'Missing required fields: namespace, pod',
	KubeconfigTooLarge: 'kubeconfig too large.',
	PayloadTooLarge: 'Payload too large.',
} as const

export type HttpErrorMessage = (typeof HTTP_ERRORS)[keyof typeof HTTP_ERRORS]

export type ExecTarget = {
	namespace: string
	pod: string
	container?: string
	/**
	 * Optional exec command override (argv array).
	 * When omitted, server will try common shells (bash/sh/ash).
	 */
	command?: string[]
}

export type ExecQuery = {
	ticket?: string
}

export function parseUrl(req: IncomingMessage): URL {
	const host = req.headers.host ?? 'localhost'
	const raw = req.url ?? '/'
	return new URL(raw, `http://${host}`)
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.statusCode = statusCode
	res.setHeader('content-type', HTTP_JSON_CONTENT_TYPE)
	res.end(safeJsonStringify(payload))
}

export function sendJsonError(res: ServerResponse, statusCode: number, error: string): void {
	sendJson(res, statusCode, { ok: false, error })
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		let total = 0
		req.on('data', (chunk: Buffer) => {
			total += chunk.length
			if (total > limitBytes) {
				reject(new Error(HTTP_ERRORS.PayloadTooLarge))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks)))
		req.on('error', reject)
	})
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
