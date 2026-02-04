import { createHttpServer } from './http-server.ts'
import { attachTerminalWebSocketServer } from './terminal-ws.ts'
import { Config, loadConfig } from './utils/config.ts'
import { logInfo } from './utils/logger.ts'

async function main(): Promise<void> {
	await loadConfig()

	const server = createHttpServer()
	attachTerminalWebSocketServer(server)

	server.listen(Config.PORT, () => {
		logInfo('listening', { url: `http://localhost:${Config.PORT}` })
	})
}

void main()
