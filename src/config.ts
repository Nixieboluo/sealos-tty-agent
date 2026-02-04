export const PORT = Number(process.env['PORT'] ?? 3000)

export const WS_MAX_PAYLOAD = Number(process.env['WS_MAX_PAYLOAD'] ?? (1024 * 1024))
export const WS_HEARTBEAT_INTERVAL_MS = Number(process.env['WS_HEARTBEAT_INTERVAL_MS'] ?? 30_000)

export const DEBUG = process.env['TTY_AGENT_DEBUG'] === '1' || process.env['TTY_AGENT_DEBUG'] === 'true'
