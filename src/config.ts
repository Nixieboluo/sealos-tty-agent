export const PORT = Number(process.env['PORT'] ?? 3000)

export const WS_MAX_PAYLOAD = Number(process.env['WS_MAX_PAYLOAD'] ?? (1024 * 1024))
export const WS_HEARTBEAT_INTERVAL_MS = Number(process.env['WS_HEARTBEAT_INTERVAL_MS'] ?? 30_000)

export const WS_AUTH_TIMEOUT_MS = Number(process.env['WS_AUTH_TIMEOUT_MS'] ?? 10_000)
export const WS_TICKET_TTL_MS = Number(process.env['WS_TICKET_TTL_MS'] ?? 60_000)
export const WS_TICKET_MAX_KUBECONFIG_BYTES = Number(process.env['WS_TICKET_MAX_KUBECONFIG_BYTES'] ?? (256 * 1024))

/**
 * Comma-separated allowlist. When set, requests with missing/unknown Origin will be rejected.
 * Example: "https://app.example.com,https://admin.example.com"
 */
export const WS_ALLOWED_ORIGINS = (process.env['WS_ALLOWED_ORIGINS'] ?? '').trim()

export const DEBUG = process.env['TTY_AGENT_DEBUG'] === '1' || process.env['TTY_AGENT_DEBUG'] === 'true'
