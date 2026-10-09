import * as NodeRED from 'node-red'
import { SlackApp } from './utilities/SlackApp'

interface SlackAppCredentials {
	botToken?: string
	appToken?: string
}

interface SlackAppNode extends NodeRED.Node<SlackAppCredentials> {
	slackApp?: SlackApp
}

interface SlackInNodeConfiguration extends NodeRED.NodeDef {
	app: string
	events: string
	enrich: boolean
}

interface SlackApiNodeConfiguration extends NodeRED.NodeDef {
	app: string
	method: string
}

interface SlackFileNodeConfiguration extends NodeRED.NodeDef {
	app: string
}

const errorMessage = (error: any) =>
	error?.data?.error
		? `${error.data.error}${error.data.needed ? ` (needs ${error.data.needed})` : ''}`
		: (error?.message ?? String(error))

export = function (RED: NodeRED.NodeAPI) {
	const getSlackApp = (node: NodeRED.Node, id: string) => {
		const appNode = RED.nodes.getNode(id) as SlackAppNode | null
		if (!appNode?.slackApp) {
			node.status({ fill: 'red', shape: 'ring', text: 'missing slack app' })
			return null
		}
		return appNode.slackApp
	}

	function SlackAppConfigNode(
		this: SlackAppNode,
		configuration: NodeRED.NodeDef,
	) {
		RED.nodes.createNode(this, configuration)
		const { botToken, appToken } = this.credentials ?? {}
		if (!botToken) {
			this.error('Bot token (xoxb-…) is missing.')
			return
		}
		this.slackApp = new SlackApp(botToken, appToken ?? '', this)

		this.on('close', (done: () => void) => {
			this.slackApp?.stop().finally(done)
		})
	}

	RED.nodes.registerType<
		SlackAppNode,
		NodeRED.NodeDef,
		unknown,
		SlackAppCredentials
	>(
		'slack-modern-app',
		SlackAppConfigNode,
		{
			credentials: {
				botToken: { type: 'password' },
				appToken: { type: 'password' },
			},
		},
	)

	function SlackInNode(
		this: NodeRED.Node,
		configuration: SlackInNodeConfiguration,
	) {
		RED.nodes.createNode(this, configuration)
		const slackApp = getSlackApp(this, configuration.app)
		if (!slackApp) {
			return
		}
		const allowedTypes = new Set(
			(configuration.events ?? '')
				.split(',')
				.map((type) => type.trim())
				.filter(Boolean),
		)

		const unsubscribeStatus = slackApp.onStatus((status) => this.status(status))
		const unsubscribeIncoming = slackApp.onIncoming(async (incoming) => {
			if (allowedTypes.size > 0 && !allowedTypes.has(incoming.type)) {
				return
			}
			try {
				const payload =
					configuration.enrich !== false
						? await slackApp.enrich(incoming.payload)
						: incoming.payload
				this.send({
					topic: incoming.type,
					payload,
					slack: {
						envelopeType: incoming.envelopeType,
						envelope: incoming.envelope,
					},
				} as NodeRED.NodeMessage)
			} catch (error) {
				this.error(errorMessage(error))
			}
		})

		this.on('close', () => {
			unsubscribeStatus()
			unsubscribeIncoming()
			this.status({})
		})
	}

	RED.nodes.registerType('slack-modern-in', SlackInNode)

	function SlackApiNode(
		this: NodeRED.Node,
		configuration: SlackApiNodeConfiguration,
	) {
		RED.nodes.createNode(this, configuration)
		const slackApp = getSlackApp(this, configuration.app)
		if (!slackApp) {
			return
		}

		this.on('close', () => {
			this.status({})
		})

		this.on('input', async (message: any, send, done) => {
			const method: string = configuration.method || message.topic
			if (!method) {
				done(new Error('Missing method. Set it in the node or in msg.topic.'))
				return
			}
			const args = message.payload ?? {}
			if (typeof args !== 'object' || Array.isArray(args)) {
				done(new Error('msg.payload must be an object with method arguments.'))
				return
			}
			this.status({ fill: 'blue', shape: 'dot', text: method })
			try {
				message.payload = await slackApp.web.apiCall(method, args)
				this.status({})
				send(message)
				done()
			} catch (error) {
				this.status({ fill: 'red', shape: 'ring', text: method })
				done(new Error(`${method}: ${errorMessage(error)}`))
			}
		})
	}

	RED.nodes.registerType('slack-modern-api', SlackApiNode)

	function SlackFileNode(
		this: NodeRED.Node,
		configuration: SlackFileNodeConfiguration,
	) {
		RED.nodes.createNode(this, configuration)
		const slackApp = getSlackApp(this, configuration.app)
		if (!slackApp) {
			return
		}

		this.on('close', () => {
			this.status({})
		})

		this.on('input', async (message: any, send, done) => {
			const url =
				message.url ??
				(typeof message.payload === 'string' ? message.payload : undefined)
			if (!url) {
				done(new Error('Missing file URL in msg.url (e.g. files[].url_private).'))
				return
			}
			this.status({ fill: 'blue', shape: 'dot', text: 'downloading' })
			try {
				const { payload, statusCode, contentType } =
					await slackApp.download(url)
				message.payload = payload
				message.statusCode = statusCode
				message.contentType = contentType
				this.status({})
				send(message)
				done()
			} catch (error) {
				this.status({ fill: 'red', shape: 'ring', text: 'failed' })
				done(new Error(errorMessage(error)))
			}
		})
	}

	RED.nodes.registerType('slack-modern-file', SlackFileNode)
}
