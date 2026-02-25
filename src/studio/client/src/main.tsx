import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router-dom"
import { applyFontSize } from "./lib/credentials"
import { router } from "./router"
import "./styles/index.css"

/* Apply saved font size preference before first paint */
applyFontSize()

const root = document.getElementById("root")
if (root) {
	createRoot(root).render(
		<StrictMode>
			<RouterProvider router={router} />
		</StrictMode>,
	)
}
