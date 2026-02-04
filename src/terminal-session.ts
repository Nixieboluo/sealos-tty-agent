import type { V1Status } from '@kubernetes/client-node'
import type { ExecTarget } from './http-utils.ts'
import type { ServerFrame } from './protocol.ts'
import type { WsStreams } from './ws-streams.ts'
import { pipeline } from 'node:stream'
import * as k8s from '@kubernetes/client-node'

import { loadKubeConfigFromString } from './k8s/kubeconfig.ts'
import { ResizableStdout } from './k8s/resizable-stdout.ts'
import { logError, logInfo, logWarn } from './logger.ts'
import { safeJsonStringify, toErrorMessage } from './protocol.ts'

export type WsSendable = string | Uint8Array

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
	}

	try {
		const k8sWs = await exec.exec(
			sess.target.namespace,
			sess.target.pod,
			sess.target.container ?? '',
			['/bin/sh', '-i'],
			stdout,
			stdout,
			sess.streams.stdin,
			true,
			statusCallback,
		) as unknown as { close: () => void }

		sess.started = true
		sess.starting = false
		sess.stdout = stdout
		sess.k8sWs = k8sWs

		logInfo('exec started', {
			id: conn.id,
			target: { namespace: sess.target.namespace, pod: sess.target.pod, container: sess.target.container },
		})
		sendCtrl(conn, { type: 'started' })
	}
	catch (err: unknown) {
		sess.starting = false
		cleanupSession(sess)

		logError('k8s exec failed', { id: conn.id, error: toErrorMessage(err) })

		sendCtrl(conn, { type: 'error', message: toErrorMessage(err) })
		try {
			conn.close(1011, 'k8s exec failed')
		}
		catch {}
	}
}
