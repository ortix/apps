import { Hono } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";
import { currentUser, requireAccess } from "./access";

type AppEnv = { Bindings: Env };

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width,initial-scale=1" />
			<title>{title}</title>
			<link rel="stylesheet" href="/styles.css" />
		</head>
		<body>
			<main>{children}</main>
		</body>
	</html>
);

export const app = new Hono<AppEnv>();

app.use("*", requireAccess());

// CI calls this after every deploy.
app.get("/healthz", (c) => c.text("ok\n"));

app.get("/", async (c) => {
	const user = await currentUser(c);
	return c.html(
		<Layout title="template-app">
			<h1>template-app</h1>
			<p>Signed in as {user?.name ?? user?.email ?? "a service token"}.</p>
		</Layout>,
	);
});

export default app;
