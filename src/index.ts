import { Config, loadConfig } from './config.ts'
import { createHttpServer } from './http-server.ts'
import { logInfo } from './logger.ts'
import { attachTerminalWebSocketServer } from './terminal-ws.ts'

async function main(): Promise<void> {
	await loadConfig()

	const server = createHttpServer()
	attachTerminalWebSocketServer(server)

	server.listen(Config.PORT, () => {
		logInfo('listening', { url: `http://localhost:${Config.PORT}` })
	})
}

void main()
