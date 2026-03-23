import React from "react"
import { Box, Text } from "ink"

export interface Tab {
	id: string
	label: string
	badge?: "running" | "complete" | "needs-input" | "active" | "closed"
	hasGate?: boolean
}

interface TabBarProps {
	tabs: Tab[]
	activeIndex: number
}

const BADGE_COLORS: Record<string, string> = {
	running: "green",
	complete: "gray",
	"needs-input": "yellow",
	active: "cyan",
	closed: "gray",
}

export const TabBar = React.memo(function TabBar({ tabs, activeIndex }: TabBarProps) {
	return (
		<Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
			{tabs.map((tab, i) => {
				const isActive = i === activeIndex
				const color = tab.badge ? BADGE_COLORS[tab.badge] : undefined
				return (
					<React.Fragment key={tab.id}>
						<Text
							bold={isActive}
							inverse={isActive}
							color={isActive ? undefined : color}
						>
							{` [${i + 1}]${tab.label} `}
						</Text>
						{tab.hasGate && <Text color="yellow">!</Text>}
						<Text> </Text>
					</React.Fragment>
				)
			})}
			<Box flexGrow={1} />
			<Text dimColor>? help</Text>
		</Box>
	)
})
