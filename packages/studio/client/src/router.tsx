import { createBrowserRouter, Navigate, useParams } from "react-router-dom"
import { AppShell } from "./layouts/AppShell"
import { HomePage } from "./pages/HomePage"
import { RoomPage } from "./pages/RoomPage"
import { SessionPage } from "./pages/SessionPage"

/** Redirect legacy /shared/:id/:code URLs to /room/:id */
function SharedSessionRedirect() {
	const { id } = useParams<{ id: string; code: string }>()
	return <Navigate to={`/room/${id}`} replace />
}

export const router = createBrowserRouter([
	{
		element: <AppShell />,
		children: [
			{ path: "/", element: <HomePage /> },
			{ path: "/session/:id", element: <SessionPage /> },
			{ path: "/shared/:id/:code", element: <SharedSessionRedirect /> },
			{ path: "/room/:id", element: <RoomPage /> },
		],
	},
])
