export type MessageFilter = 'all' | 'new' | 'top-level' | 'replies'

// Subtypes that still mean someone posted a new message
const newMessageSubtypes = new Set([
	'bot_message',
	'file_share',
	'me_message',
	'thread_broadcast',
])

const channelIdPattern = /^[CDG][A-Z0-9]{6,}$/

export const parseList = (value: string | undefined) =>
	(value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)

export const isChannelId = (value: string) => channelIdPattern.test(value)

export const normalizeChannelName = (name: string) =>
	name.replace(/^#/, '').trim().toLowerCase()

// Messages, reactions, slash commands and interactions keep the channel in different places
export const channelIdOf = (payload: Record<string, any>): string | undefined => {
	const candidate =
		payload.channel?.id ??
		payload.channel ??
		payload.item?.channel ??
		payload.channel_id
	return typeof candidate === 'string' ? candidate : undefined
}

const isThreadReply = (payload: Record<string, any>) =>
	typeof payload.thread_ts === 'string' && payload.thread_ts !== payload.ts

// Only applies to message events, other events always pass
export const matchesMessageFilter = (
	type: string,
	payload: Record<string, any>,
	filter: MessageFilter | undefined,
) => {
	if (!filter || filter === 'all' || type !== 'message') {
		return true
	}
	if (payload.subtype && !newMessageSubtypes.has(payload.subtype)) {
		return false
	}
	if (filter === 'top-level') {
		return !isThreadReply(payload)
	}
	if (filter === 'replies') {
		return isThreadReply(payload)
	}
	return true
}
