/**
 * Ambient type declarations for Web API globals available in Node 18+.
 *
 * The protocol package targets ES2022 without the "DOM" lib since it is not a
 * browser package.  These minimal declarations cover the subset of fetch /
 * streams / abort APIs used by the SSE client.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- fetch ---

declare function fetch(input: string | URL, init?: RequestInit): Promise<Response>

interface RequestInit {
	method?: string
	headers?: Record<string, string>
	body?: string | null
	signal?: AbortSignal | null
}

interface Response {
	ok: boolean
	status: number
	statusText: string
	body: ReadableStream<Uint8Array> | null
	json(): Promise<any>
	text(): Promise<string>
}

// --- ReadableStream (minimal) ---

interface ReadableStream<R = any> {
	getReader(): ReadableStreamDefaultReader<R>
}

interface ReadableStreamDefaultReader<R = any> {
	read(): Promise<ReadableStreamReadResult<R>>
	cancel(reason?: any): Promise<void>
	releaseLock(): void
}

type ReadableStreamReadResult<T> = { done: false; value: T } | { done: true; value: undefined }

// --- AbortController / AbortSignal ---

declare class AbortController {
	readonly signal: AbortSignal
	abort(reason?: any): void
}

interface AbortSignal {
	readonly aborted: boolean
	readonly reason: any
	addEventListener(
		type: string,
		listener: (...args: any[]) => any,
		options?: { once?: boolean },
	): void
	removeEventListener(type: string, listener: (...args: any[]) => any): void
}

// --- TextDecoder ---

declare class TextDecoder {
	constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean })
	decode(input?: Uint8Array | ArrayBuffer, options?: { stream?: boolean }): string
}

// --- URL ---

declare class URL {
	constructor(input: string, base?: string | URL)
	href: string
	searchParams: URLSearchParams
	toString(): string
}

interface URLSearchParams {
	set(name: string, value: string): void
	get(name: string): string | null
	delete(name: string): void
	toString(): string
}

// --- DOMException ---

declare class DOMException extends Error {
	constructor(message?: string, name?: string)
	readonly name: string
}

// --- Timers ---

declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any
