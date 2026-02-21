interface SkeletonProps {
	variant?: "line" | "block"
	width?: string
}

export function Skeleton({ variant = "line", width }: SkeletonProps) {
	const className = variant === "block" ? "skeleton skeleton-block" : "skeleton skeleton-line"
	return <div className={className} style={width ? { width } : undefined} />
}
