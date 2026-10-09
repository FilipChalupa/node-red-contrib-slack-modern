import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { EventEmitter } from 'node:events'
import type * as NodeRED from 'node-red'
import { LookupCache } from './LookupCache'

export interface SlackIncoming {
	// Socket Mode envelope type: events_api, interactive or slash_commands
	envelopeType: string
	// Event type for events_api (message, reaction_added, …), payload type otherwise
	type: string
	payload: Record<string, any>
	envelope: Record<string, any>
}

export type SlackConnectionStatus = NodeRED.NodeStatus

const statuses = {
	idle: { fill: 'grey', shape: 'ring', text: 'idle' },
	connecting: { fill: 'yellow', shape: 'ring', text: 'connecting' },
	connected: { fill: 'green', shape: 'dot', text: 'connected' },
	reconnecting: { fill: 'yellow', shape: 'ring', text: 'reconnecting' },
	disconnected: { fill: 'red', shape: 'ring', text: 'disconnected' },
	missingAppToken: { fill: 'red', shape: 'ring', text: 'missing app token' },
} satisfies Record<string, SlackConnectionStatus>

const slackFileHost = /(^|\.)slack\.com$/

export interface SlackIdentity {
	userId?: string
	botId?: string
}

export class SlackApp {
	readonly web: WebClient
	private socket: SocketModeClient | null = null
	private readonly emitter = new EventEmitter()
	private status: SlackConnectionStatus = statuses.idle
	private readonly users: LookupCache
	private readonly channels: LookupCache
	private identityPromise: Promise<SlackIdentity> | null = null

	constructor(
		private readonly botToken: string,
		private readonly appToken: string,
		private readonly node: NodeRED.Node,
	) {
		this.web = new WebClient(botToken, { retryConfig: { retries: 2 } })
		this.users = new LookupCache(async (id) => {
			const response = await this.web.users.info({ user: id })
			return response.user
		}, this.warnOnce)
		this.channels = new LookupCache(async (id) => {
			const response = await this.web.conversations.info({ channel: id })
			return response.channel
		}, this.warnOnce)
		this.emitter.setMaxListeners(0)
	}

	onIncoming(listener: (incoming: SlackIncoming) => void): () => void {
		this.emitter.on('incoming', listener)
		this.ensureSocket()
		return () => {
			this.emitter.off('incoming', listener)
		}
	}

	onStatus(listener: (status: SlackConnectionStatus) => void): () => void {
		this.emitter.on('status', listener)
		listener(this.status)
		return () => {
			this.emitter.off('status', listener)
		}
	}

	// Adds userObject and channelObject like the legacy node-red-contrib-slack did
	async enrich(payload: Record<string, any>): Promise<Record<string, any>> {
		const [userObject, channelObject] = await Promise.all([
			typeof payload.user === 'string'
				? this.users.get(payload.user)
				: undefined,
			typeof payload.channel === 'string'
				? this.channels.get(payload.channel)
				: undefined,
		])
		return {
			...payload,
			...(userObject ? { userObject } : {}),
			...(channelObject ? { channelObject } : {}),
		}
	}

	// Bot user and bot id of this app from auth.test, fetched once
	identity(): Promise<SlackIdentity> {
		this.identityPromise ??= this.web.auth.test().then(
			(response) => ({
				userId: response.user_id,
				botId: response.bot_id,
			}),
			(error) => {
				this.identityPromise = null
				throw error
			},
		)
		return this.identityPromise
	}

	// True for events caused by this app, e.g. its own messages and reactions
	async isOwn(payload: Record<string, any>): Promise<boolean> {
		const { userId, botId } = await this.identity()
		const authors = [payload, payload.message].filter(Boolean)
		return authors.some(
			(author) =>
				(botId && author.bot_id === botId) ||
				(userId && author.user === userId),
		)
	}

	async download(url: string) {
		const parsed = new URL(url)
		if (parsed.protocol !== 'https:' || !slackFileHost.test(parsed.hostname)) {
			// Never send the bot token anywhere else
			throw new Error(`Refusing to send Slack token to ${parsed.host}`)
		}
		const response = await fetch(parsed, {
			headers: { Authorization: `Bearer ${this.botToken}` },
		})
		const contentType = response.headers.get('content-type') ?? ''
		if (!response.ok) {
			throw new Error(`Download failed with status ${response.status}`)
		}
		if (contentType.startsWith('text/html')) {
			// Slack answers with its login page instead of 401
			throw new Error(
				'Slack returned an HTML page instead of the file. Is the files:read scope granted?',
			)
		}
		return {
			statusCode: response.status,
			contentType,
			payload: Buffer.from(await response.arrayBuffer()),
		}
	}

	async stop() {
		this.emitter.removeAllListeners()
		const socket = this.socket
		this.socket = null
		await socket?.disconnect()
	}

	private warned = new Set<string>()
	private warnOnce = (key: string, message: string) => {
		if (this.warned.has(key)) {
			return
		}
		this.warned.add(key)
		this.node.warn(message)
	}

	private setStatus(status: SlackConnectionStatus) {
		this.status = status
		this.emitter.emit('status', status)
	}

	private ensureSocket() {
		if (this.socket) {
			return
		}
		if (!this.appToken) {
			this.setStatus(statuses.missingAppToken)
			return
		}
		const socket = this.createSocket()
		this.socket = socket

		socket.on('connecting', () => this.setStatus(statuses.connecting))
		socket.on('connected', () => this.setStatus(statuses.connected))
		socket.on('reconnecting', () => this.setStatus(statuses.reconnecting))
		socket.on('disconnected', () => this.setStatus(statuses.disconnected))

		socket.on('slack_event', async ({ ack, type, body }) => {
			// Acknowledge right away, otherwise Slack redelivers the event
			try {
				await ack()
			} catch (error) {
				this.node.warn(`Failed to acknowledge Slack event: ${error}`)
			}
			if (type === 'events_api') {
				const { event, ...envelope } = body
				this.updateCaches(event)
				this.emitter.emit('incoming', {
					envelopeType: type,
					type: event.type,
					payload: event,
					envelope,
				} satisfies SlackIncoming)
			} else {
				this.emitter.emit('incoming', {
					envelopeType: type,
					type: body?.type ?? type,
					payload: body,
					envelope: {},
				} satisfies SlackIncoming)
			}
		})

		socket.start().catch((error) => {
			this.setStatus({ fill: 'red', shape: 'ring', text: 'error' })
			this.node.error(`Slack Socket Mode failed to start: ${error}`)
		})
	}

	protected createSocket() {
		return new SocketModeClient({ appToken: this.appToken })
	}

	private updateCaches(event: Record<string, any>) {
		if (event.type === 'user_change' && event.user?.id) {
			this.users.set(event.user.id, event.user)
		} else if (
			['channel_rename', 'channel_archive', 'channel_unarchive'].includes(
				event.type,
			)
		) {
			this.channels.delete(event.channel?.id ?? event.channel)
		}
	}
}
