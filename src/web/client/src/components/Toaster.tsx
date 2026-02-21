import { Toaster as HotToaster } from "react-hot-toast"

export function Toaster() {
	return (
		<HotToaster
			position="bottom-right"
			toastOptions={{
				style: {
					background: "var(--bg-surface)",
					color: "var(--text)",
					border: "1px solid var(--border)",
					fontFamily: "var(--font-mono)",
					fontSize: "13px",
				},
				success: {
					iconTheme: {
						primary: "var(--green)",
						secondary: "var(--bg-surface)",
					},
				},
				error: {
					iconTheme: {
						primary: "var(--red)",
						secondary: "var(--bg-surface)",
					},
				},
			}}
		/>
	)
}
