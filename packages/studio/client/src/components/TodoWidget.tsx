import type { ConsoleEntry } from "../lib/event-types"

type TodoWidgetEntry = Extract<ConsoleEntry, { kind: "todo_widget" }>

interface TodoWidgetProps {
	entry: TodoWidgetEntry
}

const statusIcons: Record<string, string> = {
	pending: "\u25CB",
	in_progress: "\u25C9",
	completed: "\u2713",
}

function statusClass(status: string): string {
	switch (status) {
		case "completed":
			return "todo-status-done"
		case "in_progress":
			return "todo-status-progress"
		default:
			return "todo-status-pending"
	}
}

export function TodoWidget({ entry }: TodoWidgetProps) {
	const todos = Array.isArray(entry.todos) ? entry.todos : []
	const completed = todos.filter((t) => t.status === "completed").length
	const inProgress = todos.filter((t) => t.status === "in_progress").length
	const total = todos.length

	const parts: string[] = []
	if (completed > 0) parts.push(`${completed}/${total} done`)
	if (inProgress > 0) parts.push(`${inProgress} in progress`)
	if (parts.length === 0) parts.push(`${total} pending`)

	return (
		<details className="tool-inline" open>
			<summary>
				<span className="tool-inline-name">TodoWrite</span>
				<span className="tool-inline-summary">{parts.join(", ")}</span>
			</summary>
			<div className="tool-inline-body">
				<ul className="todo-list">
					{todos.map((todo) => (
						<li key={todo.id} className="todo-item">
							<span className={`todo-status-icon ${statusClass(todo.status)}`}>
								{statusIcons[todo.status] || statusIcons.pending}
							</span>
							<span className="todo-content">{todo.content}</span>
							{todo.priority && <span className="todo-priority">{todo.priority}</span>}
						</li>
					))}
				</ul>
			</div>
		</details>
	)
}
