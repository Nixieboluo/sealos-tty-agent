import { readFileSync } from 'node:fs'
import * as k8s from '@kubernetes/client-node'

/**
 * Load Kubernetes config without trusting browser-provided credentials.
 *
 * - In cluster: prefer ServiceAccount (RBAC-controlled)
 * - Outside: fallback to default kubeconfig resolution (~/.kube/config, $KUBECONFIG, etc.)
 */
function isTruthyEnv(value: string | undefined): boolean {
	if (typeof value !== 'string' || value.length === 0)
		return false
	const v = value.toLowerCase()
	return value === '1' || v === 'true' || v === 'yes'
}

function resolveTildePath(path: string): string {
	if (!path.startsWith('~/'))
		return path
	const home = process.env['HOME']
	if (typeof home !== 'string' || home.length === 0)
		return path
	return `${home}/${path.slice(2)}`
}

function inlineFileAsBase64(path: string, kind: string): string {
	const resolved = resolveTildePath(path)
	try {
		return readFileSync(resolved).toString('base64')
	}
	catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`Failed to read ${kind} from ${resolved}: ${msg}`)
	}
}

/**
 * Make kubeconfig self-contained and runtime-friendly by inlining file-based
 * credentials (caFile/certFile/keyFile) into *Data fields.
 *
 * This prevents TLS failures when running in environments where kubeconfig's
 * file paths are not accessible (e.g. in containers, remote agents, or when
 * kubeconfig is pasted via UI).
 */
function normalizeKubeConfig(kc: k8s.KubeConfig): void {
	for (const c of kc.clusters) {
		const m = c as unknown as { caData?: string, caFile?: string }
		if (m.caData == null && typeof m.caFile === 'string' && m.caFile.length > 0) {
			m.caData = inlineFileAsBase64(m.caFile, 'cluster CA certificate')
			m.caFile = undefined
		}
	}

	for (const u of kc.users) {
		const m = u as unknown as { certData?: string, certFile?: string, keyData?: string, keyFile?: string }
		if (m.certData == null && typeof m.certFile === 'string' && m.certFile.length > 0) {
			m.certData = inlineFileAsBase64(m.certFile, 'client certificate')
			m.certFile = undefined
		}
		if (m.keyData == null && typeof m.keyFile === 'string' && m.keyFile.length > 0) {
			m.keyData = inlineFileAsBase64(m.keyFile, 'client key')
			m.keyFile = undefined
		}
	}

	// Optional overrides for edge TLS setups.
	const cluster = kc.getCurrentCluster()
	if (cluster) {
		const m = cluster as unknown as { tlsServerName?: string, skipTLSVerify?: boolean }
		const tlsServerName = process.env['K8S_TLS_SERVER_NAME']
		if (typeof tlsServerName === 'string' && tlsServerName.length > 0)
			m.tlsServerName = tlsServerName

		if (isTruthyEnv(process.env['K8S_INSECURE_SKIP_TLS_VERIFY']))
			m.skipTLSVerify = true
	}
}

export function loadKubeConfig(): k8s.KubeConfig {
	const kc = new k8s.KubeConfig()

	const inCluster = Boolean(process.env['KUBERNETES_SERVICE_HOST'])
	if (inCluster) {
		kc.loadFromCluster()
	}
	else {
		kc.loadFromDefault()
	}

	normalizeKubeConfig(kc)
	return kc
}

export function loadKubeConfigFromString(kubeconfig: string): k8s.KubeConfig {
	const kc = new k8s.KubeConfig()
	kc.loadFromString(kubeconfig)
	normalizeKubeConfig(kc)
	return kc
}
