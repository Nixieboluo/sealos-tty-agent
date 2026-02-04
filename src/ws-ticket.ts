import type { ExecTarget } from './http-utils.ts'
import { randomUUID } from 'node:crypto'
import { Config } from './config.ts'

export type TicketIssueMeta = {
	ip?: string
	userAgent?: string
}

type TicketRecord = {
	kubeconfig: string
	target: ExecTarget
	expiresAt: number
	used: boolean
	meta: TicketIssueMeta
}

const store = new Map<string, TicketRecord>()

function now(): number {
	return Date.now()
}

function cleanupExpiredTickets(): void {
	const t = now()
	for (const [key, rec] of store) {
		if (rec.used || rec.expiresAt <= t)
			store.delete(key)
	}
}

/**
 * Issue a one-time ticket. The ticket should be short-lived and consumed once.
 */
export function issueWsTicket(
	kubeconfig: string,
	target: ExecTarget,
	meta: TicketIssueMeta,
): { ticket: string, expiresAt: number } {
	cleanupExpiredTickets()

	const ticket = randomUUID()
	const expiresAt = now() + Config.WS_TICKET_TTL_MS

	store.set(ticket, {
		kubeconfig,
		target,
		expiresAt,
		used: false,
		meta,
	})

	return { ticket, expiresAt }
}

export type ConsumeResult
	= | { ok: true, kubeconfig: string, target: ExecTarget }
		| { ok: false, error: string }

/**
 * Consume a ticket once. On success, the ticket is immediately invalidated.
 */
export function consumeWsTicket(ticket: string, _meta: TicketIssueMeta): ConsumeResult {
	cleanupExpiredTickets()

	const rec = store.get(ticket)
	if (!rec)
		return { ok: false, error: 'Invalid or expired ticket.' }
	if (rec.used)
		return { ok: false, error: 'Ticket already used.' }
	if (rec.expiresAt <= now()) {
		store.delete(ticket)
		return { ok: false, error: 'Ticket expired.' }
	}

	// Optional binding checks: if ticket was issued with IP/UA, enforce exact match.
	// if (rec.meta.ip && meta.ip && rec.meta.ip !== meta.ip)
	// 	return { ok: false, error: 'Ticket IP mismatch.' }
	// if (rec.meta.userAgent && meta.userAgent && rec.meta.userAgent !== meta.userAgent)
	// 	return { ok: false, error: 'Ticket User-Agent mismatch.' }

	rec.used = true
	store.delete(ticket)
	return { ok: true, kubeconfig: rec.kubeconfig, target: rec.target }
}
