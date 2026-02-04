import type { RawData } from 'ws'
import { Buffer } from 'node:buffer'

export function rawToString(data: RawData): string {
	if (typeof data === 'string')
		return data
	if (data instanceof ArrayBuffer)
		return Buffer.from(data).toString('utf8')
	if (Array.isArray(data))
		return Buffer.concat(data).toString('utf8')
	// Buffer
	return data.toString('utf8')
}

export function rawToBuffer(data: RawData): Buffer {
	if (typeof data === 'string')
		return Buffer.from(data, 'utf8')
	if (data instanceof ArrayBuffer)
		return Buffer.from(data)
	if (Array.isArray(data))
		return Buffer.concat(data)
	return Buffer.isBuffer(data) ? data : Buffer.from(data)
}
