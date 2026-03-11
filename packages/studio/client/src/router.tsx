import { createBrowserRouter } from "react-router-dom"
import { AppShell } from "./layouts/AppShell"
import { HomePage } from "./pages/HomePage"
import { RoomPage } from "./pages/RoomPage"
import { SessionPage } from "./pages/SessionPage"

export const router = createBrowserRouter([
	{
		element: <AppShell />,
		children: [
			{ path: "/", element: <HomePage /> },
			{ path: "/session/:id", element: <SessionPage /> },
			{ path: "/room/:id", element: <RoomPage /> },
		],
	},
])
