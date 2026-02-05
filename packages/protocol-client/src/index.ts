export {
	ClientFrameSchema,
	isClientFrame,
	safeJsonStringify,
	safeParseClientFrame,
	toErrorMessage,
} from './protocol.js'
export type { ClientFrame, ServerFrame } from './protocol.js'

export type { ConnectTerminalStreamsOptions, TerminalStreams } from './streams.js'

export { connectTerminalStreams, issueWsTicket } from './streams.js'

export type {
	ErrorResponse,
	ProtocolClientOptions,
	TerminalSessionConnectOptions,
	TerminalSessionState,
	TicketTarget,
	WsTicketRequest,
	WsTicketResponse,
} from './streams.js'

export type { FetchLike, WsFactory, WsLike } from './types.js'
