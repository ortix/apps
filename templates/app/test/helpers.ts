/** An ExecutionContext as Cloudflare Access would populate it, or without Access when identity is null. */
export function accessContext(identity: Record<string, unknown> | null | undefined): ExecutionContext {
	const access = identity === null ? undefined : { aud: "test-aud", getIdentity: async () => identity };
	return {
		waitUntil: () => {},
		passThroughOnException: () => {},
		props: {},
		...(access ? { access } : {}),
	} as unknown as ExecutionContext;
}

export const GITHUB_USER = { email: "me@example.com", name: "Me", idp: { id: "idp-1", type: "github" } };
