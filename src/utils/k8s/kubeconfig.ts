import * as k8s from '@kubernetes/client-node'

export function loadKubeConfigFromString(kubeconfig: string): k8s.KubeConfig {
	const kc = new k8s.KubeConfig()
	kc.loadFromString(kubeconfig)
	return kc
}
