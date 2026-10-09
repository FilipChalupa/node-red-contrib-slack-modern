const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const helper = require('node-red-node-test-helper')
const slackModern = require('../nodes/slack-modern.js')
const { SlackApp } = require('../nodes/utilities/SlackApp.js')

helper.init(require.resolve('node-red'))

const credentials = {
	app: { botToken: 'xoxb-test', appToken: 'xapp-test' },
}

const flow = (nodes) => [
	{ id: 'app', type: 'slack-modern-app', name: 'Test' },
	{ id: 'out', type: 'helper' },
	...nodes,
]

// Replaces the real Socket Mode client with an emitter the test controls
const fakeSocket = () => {
	const socket = new EventEmitter()
	const acks = []
	socket.start = async () => socket.emit('connected')
	socket.disconnect = async () => {}
	socket.deliver = (type, body) =>
		socket.emit('slack_event', {
			type,
			body,
			ack: async () => acks.push(type),
		})
	socket.acks = acks
	return socket
}

const nextError = (node) =>
	new Promise((resolve) => node.once('call:error', (call) => resolve(call.firstArg)))

const nextMessage = (node) =>
	new Promise((resolve) => node.once('input', (message) => resolve(message)))

describe('node-red-contrib-slack-modern', () => {
	let socket
	let originalCreateSocket

	beforeEach(async () => {
		socket = fakeSocket()
		originalCreateSocket = SlackApp.prototype.createSocket
		SlackApp.prototype.createSocket = () => socket
		await helper.startServer()
	})

	afterEach(async () => {
		SlackApp.prototype.createSocket = originalCreateSocket
		await helper.unload()
		await helper.stopServer()
	})

	it('registers all node types', async () => {
		await helper.load(
			slackModern,
			flow([
				{ id: 'in', type: 'slack-modern-in', app: 'app', wires: [['out']] },
				{ id: 'api', type: 'slack-modern-api', app: 'app', wires: [['out']] },
				{ id: 'file', type: 'slack-modern-file', app: 'app', wires: [['out']] },
			]),
			credentials,
		)
		for (const id of ['app', 'in', 'api', 'file']) {
			assert.ok(helper.getNode(id), `${id} should exist`)
		}
	})

	it('passes the full event with ts and thread_ts and enriches it', async () => {
		await helper.load(
			slackModern,
			flow([
				{
					id: 'in',
					type: 'slack-modern-in',
					app: 'app',
					events: '',
					enrich: true,
					wires: [['out']],
				},
			]),
			credentials,
		)
		const app = helper.getNode('app').slackApp
		const calls = []
		app.web.users.info = async ({ user }) => {
			calls.push(user)
			return { user: { id: user, real_name: 'Filip Chalupa' } }
		}
		app.web.conversations.info = async ({ channel }) => ({
			channel: { id: channel, name: 'bot_test' },
		})

		const received = nextMessage(helper.getNode('out'))
		socket.deliver('events_api', {
			team_id: 'T1',
			event_id: 'Ev1',
			event: {
				type: 'message',
				channel: 'C069EB7A8QG',
				user: 'U066SHJF82E',
				text: 'Ahoj',
				ts: '1791551502.949809',
				thread_ts: '1791551500.000100',
				files: [{ url_private: 'https://files.slack.com/x.png' }],
			},
		})
		const message = await received

		assert.equal(message.topic, 'message')
		assert.equal(message.payload.ts, '1791551502.949809')
		assert.equal(message.payload.thread_ts, '1791551500.000100')
		assert.equal(message.payload.files.length, 1)
		assert.equal(message.payload.userObject.real_name, 'Filip Chalupa')
		assert.equal(message.payload.channelObject.name, 'bot_test')
		assert.equal(message.slack.envelopeType, 'events_api')
		assert.equal(message.slack.envelope.event_id, 'Ev1')
		assert.deepEqual(socket.acks, ['events_api'])

		// Second message from the same user is served from cache
		const second = nextMessage(helper.getNode('out'))
		socket.deliver('events_api', {
			event: { type: 'message', channel: 'C1', user: 'U066SHJF82E', ts: '2' },
		})
		await second
		assert.deepEqual(calls, ['U066SHJF82E'])
	})

	it('filters event types and still sends events when lookups fail', async () => {
		await helper.load(
			slackModern,
			flow([
				{
					id: 'in',
					type: 'slack-modern-in',
					app: 'app',
					events: 'reaction_added, message',
					enrich: true,
					wires: [['out']],
				},
			]),
			credentials,
		)
		const app = helper.getNode('app').slackApp
		app.web.users.info = async () => {
			const error = new Error('missing_scope')
			error.data = { error: 'missing_scope', needed: 'users:read' }
			throw error
		}
		app.web.conversations.info = app.web.users.info

		const out = helper.getNode('out')
		const seen = []
		out.on('input', (message) => seen.push(message))

		socket.deliver('events_api', {
			event: { type: 'channel_created', channel: { id: 'C2' } },
		})
		socket.deliver('events_api', {
			event: { type: 'message', channel: 'C1', user: 'U1', ts: '3' },
		})
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.equal(seen.length, 1)
		assert.equal(seen[0].payload.ts, '3')
		assert.equal(seen[0].payload.userObject, undefined)
	})

	it('ignores events caused by the app itself', async () => {
		await helper.load(
			slackModern,
			flow([
				{
					id: 'in',
					type: 'slack-modern-in',
					app: 'app',
					enrich: false,
					ignoreOwn: true,
					wires: [['out']],
				},
			]),
			credentials,
		)
		const app = helper.getNode('app').slackApp
		let authCalls = 0
		app.web.auth.test = async () => {
			authCalls++
			return { ok: true, user_id: 'U0BOT', bot_id: 'B0BOT' }
		}

		const out = helper.getNode('out')
		const seen = []
		out.on('input', (message) => seen.push(message.payload.ts))

		const events = [
			{ type: 'message', user: 'U0BOT', bot_id: 'B0BOT', username: 'AI robot', ts: '1' },
			{ type: 'message', bot_id: 'B0BOT', subtype: 'bot_message', ts: '2' },
			{ type: 'message', subtype: 'message_changed', message: { bot_id: 'B0BOT' }, ts: '3' },
			{ type: 'reaction_added', user: 'U0BOT', ts: '4' },
			{ type: 'message', bot_id: 'B0OTHER', ts: '5' },
			{ type: 'message', user: 'U1', ts: '6' },
		]
		for (const event of events) {
			socket.deliver('events_api', { event })
		}
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.deepEqual(seen.sort(), ['5', '6'])
		assert.equal(authCalls, 1)
	})

	it('filters by channel name or ID', async () => {
		await helper.load(
			slackModern,
			flow([
				{
					id: 'in',
					type: 'slack-modern-in',
					app: 'app',
					enrich: false,
					channels: '#Jedna-paní-povídala, C0DEPLOY1',
					wires: [['out']],
				},
			]),
			credentials,
		)
		const app = helper.getNode('app').slackApp
		const names = { C0PANI001: 'jedna-paní-povídala', C0OPS0001: 'ops' }
		app.web.conversations.info = async ({ channel }) => ({
			channel: { id: channel, name: names[channel] },
		})

		const out = helper.getNode('out')
		const seen = []
		out.on('input', (message) => seen.push(message.payload.ts))

		const events = [
			{ type: 'message', channel: 'C0PANI001', ts: '1' },
			{ type: 'message', channel: 'C0DEPLOY1', ts: '2' },
			{ type: 'message', channel: 'C0OPS0001', ts: '3' },
			{ type: 'reaction_added', item: { channel: 'C0PANI001' }, ts: '4' },
			{ type: 'team_join', ts: '5' },
		]
		for (const event of events) {
			socket.deliver('events_api', { event })
		}
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.deepEqual(seen.sort(), ['1', '2', '4'])
	})

	for (const [messages, expected] of [
		['all', ['1', '2', '3', '4', '5', '6']],
		['new', ['1', '2', '3', '6']],
		['top-level', ['1', '3', '6']],
		['replies', ['2', '6']],
	]) {
		it(`filters messages: ${messages}`, async () => {
			await helper.load(
				slackModern,
				flow([
					{
						id: 'in',
						type: 'slack-modern-in',
						app: 'app',
						enrich: false,
						messages,
						wires: [['out']],
					},
				]),
				credentials,
			)
			const out = helper.getNode('out')
			const seen = []
			out.on('input', (message) => seen.push(message.payload.ts))

			const events = [
				{ type: 'message', ts: '1' },
				{ type: 'message', ts: '2', thread_ts: '1' },
				{ type: 'message', subtype: 'file_share', ts: '3' },
				{ type: 'message', subtype: 'message_changed', ts: '4' },
				{ type: 'message', subtype: 'channel_join', ts: '5' },
				{ type: 'reaction_added', ts: '6' },
			]
			for (const event of events) {
				socket.deliver('events_api', { event })
			}
			await new Promise((resolve) => setTimeout(resolve, 50))

			assert.deepEqual(seen.sort(), expected)
		})
	}

	it('calls the method from msg.topic with msg.payload as arguments', async () => {
		await helper.load(
			slackModern,
			flow([{ id: 'api', type: 'slack-modern-api', app: 'app', wires: [['out']] }]),
			credentials,
		)
		const app = helper.getNode('app').slackApp
		const calls = []
		app.web.apiCall = async (method, args) => {
			calls.push({ method, args })
			return { ok: true, ts: '42' }
		}

		const received = nextMessage(helper.getNode('out'))
		helper.getNode('api').receive({
			topic: 'reactions.add',
			payload: { channel: 'C1', timestamp: '1', name: 'clock1' },
			ts: 'kept',
		})
		const message = await received

		assert.deepEqual(calls, [
			{
				method: 'reactions.add',
				args: { channel: 'C1', timestamp: '1', name: 'clock1' },
			},
		])
		assert.deepEqual(message.payload, { ok: true, ts: '42' })
		assert.equal(message.ts, 'kept')
	})

	it('reports Slack API errors so catch nodes can handle them', async () => {
		await helper.load(
			slackModern,
			flow([
				{ id: 'api', type: 'slack-modern-api', app: 'app', wires: [['out']] },
			]),
			credentials,
		)
		const app = helper.getNode('app').slackApp
		app.web.apiCall = async () => {
			const error = new Error('An API error occurred: missing_scope')
			error.data = { error: 'missing_scope', needed: 'chat:write.customize' }
			throw error
		}

		const failed = nextError(helper.getNode('api'))
		helper.getNode('api').receive({ topic: 'chat.postMessage', payload: {} })
		assert.match(String(await failed), /chat\.postMessage: missing_scope \(needs chat:write\.customize\)/)
	})

	it('refuses to send the token outside slack.com', async () => {
		await helper.load(
			slackModern,
			flow([
				{ id: 'file', type: 'slack-modern-file', app: 'app', wires: [['out']] },
			]),
			credentials,
		)
		const failed = nextError(helper.getNode('file'))
		helper.getNode('file').receive({ url: 'https://evil.example/files.slack.com/x' })
		assert.match(String(await failed), /Refusing to send Slack token/)
	})

	it('downloads Slack files with the bot token', async () => {
		await helper.load(
			slackModern,
			flow([{ id: 'file', type: 'slack-modern-file', app: 'app', wires: [['out']] }]),
			credentials,
		)
		const originalFetch = global.fetch
		let request
		global.fetch = async (url, options) => {
			request = { url: String(url), options }
			return new Response(Buffer.from([1, 2, 3]), {
				status: 200,
				headers: { 'content-type': 'image/png' },
			})
		}
		try {
			const received = nextMessage(helper.getNode('out'))
			helper.getNode('file').receive({
				url: 'https://files.slack.com/files-pri/T1-F1/image.png',
			})
			const message = await received
			assert.equal(request.options.headers.Authorization, 'Bearer xoxb-test')
			assert.deepEqual([...message.payload], [1, 2, 3])
			assert.equal(message.contentType, 'image/png')
		} finally {
			global.fetch = originalFetch
		}
	})
})
