/* eslint-disable no-console */

const PREFIX = '[tty-agent]'

export function logInfo(message: string, meta?: Record<string, unknown>): void {
	if (meta)
		console.log(PREFIX, message, meta)
	else
		console.log(PREFIX, message)
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
	if (meta)
		console.warn(PREFIX, message, meta)
	else
		console.warn(PREFIX, message)
}

export function logError(message: string, meta?: Record<string, unknown>): void {
	if (meta)
		console.error(PREFIX, message, meta)
	else
		console.error(PREFIX, message)
}
