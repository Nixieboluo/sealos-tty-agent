import { PassThrough } from 'node:stream'

/**
 * A Writable stream that is also "resizable" for Kubernetes exec TTY.
 * `@kubernetes/client-node` detects resizes via `rows/columns` + `on('resize')`.
 */
export class ResizableStdout extends PassThrough {
	rows = 24
	columns = 80

	resize(cols: number, rows: number): void {
		this.columns = cols
		this.rows = rows
		this.emit('resize')
	}
}
