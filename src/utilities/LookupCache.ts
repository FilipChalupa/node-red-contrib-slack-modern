const timeToLive = 60 * 60 * 1000

// Caches lookups such as users.info and shares a pending request between callers
export class LookupCache {
	private readonly entries = new Map<
		string,
		{ value: Promise<unknown>; expiresAt: number }
	>()

	constructor(
		private readonly fetch: (id: string) => Promise<unknown>,
		private readonly warnOnce: (key: string, message: string) => void,
	) {}

	get(id: string): Promise<unknown> {
		const cached = this.entries.get(id)
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value
		}
		const value = this.fetch(id).catch((error) => {
			this.entries.delete(id)
			const code = error?.data?.error ?? error?.code ?? String(error)
			const needed = error?.data?.needed ? ` (needs ${error.data.needed})` : ''
			this.warnOnce(code, `Slack lookup failed: ${code}${needed}`)
			return undefined
		})
		this.entries.set(id, { value, expiresAt: Date.now() + timeToLive })
		return value
	}

	set(id: string, value: unknown) {
		this.entries.set(id, {
			value: Promise.resolve(value),
			expiresAt: Date.now() + timeToLive,
		})
	}

	delete(id: string) {
		this.entries.delete(id)
	}
}
