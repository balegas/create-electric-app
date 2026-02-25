import { createBrowserRouter } from "react-router-dom"
import { AppShell } from "./layouts/AppShell"
import { HomePage } from "./pages/HomePage"
import { SessionPage } from "./pages/SessionPage"

export const router = createBrowserRouter([
	{
		element: <AppShell />,
		children: [
			{ path: "/", element: <HomePage /> },
			{ path: "/session/:id", element: <SessionPage /> },
		],
	},
])
