import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { sessions } from "./routes/sessions.js"
import { progress } from "./routes/progress.js"
import { download } from "./routes/download.js"

const app = new Hono()

app.use("*", logger())
app.use(
	"*",
	cors({
		origin: [
			"https://electric-agent.pages.dev",
			"http://localhost:5173",
		],
	}),
)

app.get("/health", (c) => c.json({ status: "ok" }))

app.route("/api/sessions", sessions)
app.route("/api/progress", progress)
app.route("/api/download", download)

const port = Number(process.env.PORT) || 8080
console.log(`electric-agent-api listening on :${port}`)

export default {
	port,
	fetch: app.fetch,
}
