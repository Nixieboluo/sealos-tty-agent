import { DEBUG } from './config.ts'

export function debugLog(...args: unknown[]): void {
	if (DEBUG)
		console.warn('[tty-agent]', ...args)
}
