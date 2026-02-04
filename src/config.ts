import { readFile } from 'node:fs/promises'
import { z } from 'zod'

export type AppConfig = Readonly<{
	PORT: number

	WS_MAX_PAYLOAD: number
	WS_HEARTBEAT_INTERVAL_MS: number

	WS_AUTH_TIMEOUT_MS: number
	WS_TICKET_TTL_MS: number
	WS_TICKET_MAX_KUBECONFIG_BYTES: number

	/**
	 * When non-empty, requests with missing/unknown Origin will be rejected.
	 */
	WS_ALLOWED_ORIGINS: string[]

	DEBUG: boolean
}>

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const DEFAULT_CONFIG: AppConfig = Object.freeze({
	PORT: 3000,

	WS_MAX_PAYLOAD: 1024 * 1024,
	WS_HEARTBEAT_INTERVAL_MS: 30_000,

	WS_AUTH_TIMEOUT_MS: 10_000,
	WS_TICKET_TTL_MS: 60_000,
	WS_TICKET_MAX_KUBECONFIG_BYTES: 256 * 1024,

	WS_ALLOWED_ORIGINS: [],

	DEBUG: false,
})

const ConfigFileSchema = z.object({
	PORT: z.number().int().min(1).max(65535).optional(),

	WS_MAX_PAYLOAD: z.number().int().min(1).optional(),
	WS_HEARTBEAT_INTERVAL_MS: z.number().int().min(1).optional(),

	WS_AUTH_TIMEOUT_MS: z.number().int().min(1).optional(),
	WS_TICKET_TTL_MS: z.number().int().min(1).optional(),
	WS_TICKET_MAX_KUBECONFIG_BYTES: z.number().int().min(1).optional(),

	WS_ALLOWED_ORIGINS: z.array(z.string().trim().min(1)).optional(),

	DEBUG: z.boolean().optional(),
}).strict()

/**
 * Centralized runtime config, loaded from `config.json` at startup.
 *
 * IMPORTANT:
 * - Keep config parsing/validation centralized here.
 * - Consumers should read `Config.xxx` directly (no extra fallback logic).
 */
export const Config: Mutable<AppConfig> = { ...DEFAULT_CONFIG }

export async function loadConfig(): Promise<void> {
	// `src/config.ts` -> project root `config.json`
	const configUrl = new URL('../config.json', import.meta.url)

	let raw: string
	try {
		raw = await readFile(configUrl, 'utf8')
	}
	catch (err: unknown) {
		throw new Error(`[config] Failed to read config.json at ${configUrl.pathname}: ${err instanceof Error ? err.message : String(err)}`)
	}

	let json: unknown
	try {
		json = JSON.parse(raw)
	}
	catch {
		throw new Error('[config] config.json is not valid JSON.')
	}

	const parsed = ConfigFileSchema.safeParse(json)
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
			.join('; ')
		throw new Error(`[config] Invalid config.json: ${detail}`)
	}

	const v = parsed.data
	const next: AppConfig = {
		...DEFAULT_CONFIG,
		...v,
		WS_ALLOWED_ORIGINS: v.WS_ALLOWED_ORIGINS ?? DEFAULT_CONFIG.WS_ALLOWED_ORIGINS,
	}

	Object.assign(Config, next)
	Object.freeze(Config)
}
