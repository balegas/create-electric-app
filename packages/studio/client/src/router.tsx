import { createBrowserRouter } from "react-router-dom"
import { AppShell } from "./layouts/AppShell"
import { HomePage } from "./pages/HomePage"
import { SessionPage } from "./pages/SessionPage"
import { SharedSessionPage } from "./pages/SharedSessionPage"

export const router = createBrowserRouter([
	{
		element: <AppShell />,
		children: [
			{ path: "/", element: <HomePage /> },
			{ path: "/session/:id", element: <SessionPage /> },
			{ path: "/shared/:code", element: <SharedSessionPage /> },
		],
	},
])
