import type { Context, MiddlewareHandler } from "hono";

/** The signed-in person, as Cloudflare Access reports them. */
export interface User {
	email: string | undefined;
	name: string | undefined;
	/** The identity provider used to sign in, such as "github". */
	provider: string | undefined;
	/** Everything Access knows about the user, for apps that need more. */
	raw: Record<string, unknown>;
}

// Hono types executionCtx with its own minimal interface; the Workers one has `access`.
const accessOf = (c: Context) => (c.executionCtx as unknown as ExecutionContext).access;

/**
 * Refuses any request that Cloudflare Access did not authenticate.
 * Access already blocks unauthenticated visitors at the edge; this is the
 * second lock, in case the Worker is ever reachable another way.
 */
export const requireAccess = (): MiddlewareHandler => async (c, next) => {
	if (!accessOf(c)) return c.text("Forbidden\n", 403);
	await next();
};

/** The signed-in user, or undefined for service tokens (such as CI's smoke test). */
export async function currentUser(c: Context): Promise<User | undefined> {
	const identity = await accessOf(c)?.getIdentity();
	if (!identity) return undefined;
	return {
		email: identity.email,
		name: identity.name,
		provider: identity.idp?.type,
		raw: identity,
	};
}
