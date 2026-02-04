import type { V1Status } from '@kubernetes/client-node'
import type { ExecTarget } from './utils/http-utils.ts'
import type { ServerFrame } from './utils/protocol.ts'
import type { WsStreams } from './utils/ws-streams.ts'
import { pipeline } from 'node:stream'
import * as k8s from '@kubernetes/client-node'

import { loadKubeConfigFromString } from './utils/k8s/kubeconfig.ts'
import { ResizableStdout } from './utils/k8s/resizable-stdout.ts'
import { logError, logInfo, logWarn } from './utils/logger.ts'
import { safeJsonStringify, toErrorMessage } from './utils/protocol.ts'

export type WsSendable = string | Uint8Array

const COMMON_SHELL_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
	['/bin/bash', '-il'],
	['/usr/bin/bash', '-il'],
	['bash', '-il'],
	['/bin/sh', '-i'],
	['/usr/bin/sh', '-i'],
	['sh', '-i'],
	['/bin/ash', '-i'],
	['/usr/bin/ash', '-i'],
	['ash', '-i'],
]

function isCommandNotFoundError(message: string): boolean {
	const m = message.toLowerCase()
	return (
		m.includes('executable file not found')
		|| m.includes('no such file or directory')
		|| m.includes('not found')
		|| m.includes('stat /')
	)
}

export type WsConnection = {
	id: string
	send: (data: WsSendable) => void
	close: (code?: number, reason?: string) => void
}

export type Session = {
	started: boolean
	starting: boolean
	stdout?: ResizableStdout
	k8sWs?: { close: () => void }
	kubeconfig?: string
	target?: ExecTarget
	streams: WsStreams
}

export function sendCtrl(ws: WsConnection, payload: ServerFrame): void {
	ws.send(safeJsonStringify(payload))
}

export function cleanupSession(sess: Session): void {
	try {
		sess.stdout?.destroy()
	}
	catch {}
	try {
		sess.k8sWs?.close()
	}
	catch {}
	try {
		sess.streams.stdin.end()
	}
	catch {}
	try {
		sess.streams.ctrl.end()
	}
	catch {}
	try {
		sess.streams.wsOut.destroy()
	}
	catch {}

	sess.stdout = undefined
	sess.k8sWs = undefined
	sess.started = false
	sess.starting = false
}

export async function startExecIfNeeded(
	conn: WsConnection,
	sess: Session,
	size: { cols: number, rows: number },
): Promise<void> {
	if (sess.started || sess.starting)
		return

	sess.starting = true
	logInfo('exec starting', {
		id: conn.id,
		target: sess.target
			? { namespace: sess.target.namespace, pod: sess.target.pod, container: sess.target.container }
			: undefined,
		size,
	})

	if (typeof sess.kubeconfig !== 'string' || sess.kubeconfig.length === 0) {
		sess.starting = false
		sendCtrl(conn, {
			type: 'error',
			message: 'Missing kubeconfig. Authenticate first: send { "type": "auth", "ticket": "..." } as the first WebSocket message (or pass ticket via ?ticket=...).',
		})
		try {
			conn.close(1008, 'missing kubeconfig')
		}
		catch {}
		return
	}

	if (!sess.target) {
		sess.starting = false
		sendCtrl(conn, {
			type: 'error',
			message: 'Missing exec target. Request a ticket with namespace/pod/container first.',
		})
		try {
			conn.close(1008, 'missing target')
		}
		catch {}
		return
	}

	const kc = loadKubeConfigFromString(sess.kubeconfig)

	const stdout = new ResizableStdout()
	stdout.resize(size.cols, size.rows)

	const exec = new k8s.Exec(kc)

	// stdout/stderr -> wsOut (binary frames)
	pipeline(stdout, sess.streams.wsOut, (err) => {
		if (err)
			logWarn('wsOut pipeline error', { id: conn.id, error: toErrorMessage(err) })
	})

	const statusCallback = (status: V1Status) => {
		try {
			sendCtrl(conn, { type: 'status', status })
		}
		catch {}

		// When exec finishes, Kubernetes will report a terminal V1Status.
		// Close the client WebSocket so frontends can reliably treat it as "session ended".
		const s = (status as unknown as { status?: unknown })?.status
		if (s === 'Success') {
			logInfo('exec finished', { id: conn.id })
			try {
				conn.close(1000, 'exec finished')
			}
			catch {}
		}
		else if (s === 'Failure') {
			const msg = typeof (status as unknown as { message?: unknown })?.message === 'string'
				? (status as unknown as { message: string }).message
				: 'exec failed'
			try {
				sendCtrl(conn, { type: 'error', message: msg })
			}
			catch {}
			logWarn('exec finished (failure)', { id: conn.id })
			try {
				conn.close(1011, 'exec failed')
			}
			catch {}
		}
	}

	try {
		const custom = Array.isArray(sess.target.command) && sess.target.command.length > 0 ? sess.target.command : undefined
		const candidates = custom ? [custom] : COMMON_SHELL_COMMANDS

		let k8sWs: { close: () => void } | undefined
		let lastError = ''

		for (const cmd of candidates) {
			try {
				logInfo('exec command selected', { id: conn.id, cmd })
				k8sWs = await exec.exec(
					sess.target.namespace,
					sess.target.pod,
					sess.target.container ?? '',
					[...cmd],
					stdout,
					stdout,
					sess.streams.stdin,
					true,
					statusCallback,
				) as unknown as { close: () => void }
				break
			}
			catch (err: unknown) {
				lastError = toErrorMessage(err)
				// If user explicitly set command, do not fallback.
				if (custom) {
					throw err
				}
				// Only fallback on typical "command not found" errors.
				if (!isCommandNotFoundError(lastError))
					throw err

				logWarn('exec shell not found, trying next', { id: conn.id, cmd, error: lastError })
			}
		}

		if (!k8sWs) {
			sess.starting = false
			cleanupSession(sess)
			const tried = candidates.map(c => c.join(' ')).join(', ')
			sendCtrl(conn, { type: 'error', message: `No shell found in container. Tried: ${tried}` })
			try {
				conn.close(1008, 'no shell found')
			}
			catch {}
			return
		}

		sess.started = true
		sess.starting = false
		sess.stdout = stdout
		sess.k8sWs = k8sWs

		logInfo('exec started', {
			id: conn.id,
			target: { namespace: sess.target.namespace, pod: sess.target.pod, container: sess.target.container, command: sess.target.command },
		})
		sendCtrl(conn, { type: 'started' })
	}
	catch (err: unknown) {
		sess.starting = false
		cleanupSession(sess)

		logError('k8s exec failed', { id: conn.id, error: toErrorMessage(err) })

		const msg = toErrorMessage(err)
		sendCtrl(conn, { type: 'error', message: msg })
		try {
			conn.close(1011, 'k8s exec failed')
		}
		catch {}
	}
}
