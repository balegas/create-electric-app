import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [react()],
	root: __dirname,
	build: {
		outDir: "../../../dist/web/client",
		emptyOutDir: true,
	},
	server: {
		port: 4401,
		proxy: {
			"/api": "http://127.0.0.1:4400",
		},
	},
})
