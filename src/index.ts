import { PORT } from './config.ts'
import { createHttpServer } from './http-server.ts'
import { attachTerminalWebSocketServer } from './terminal-ws.ts'

const server = createHttpServer()
attachTerminalWebSocketServer(server)

server.listen(PORT, () => {
	console.warn(`sealos-tty-agent listening on http://localhost:${PORT}`)
})
