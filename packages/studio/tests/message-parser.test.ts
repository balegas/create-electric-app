import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseRoomMessage } from "../src/bridge/message-parser.js"

describe("parseRoomMessage", () => {
	it("returns null when no @room or @name found", () => {
		const result = parseRoomMessage("Just some regular output", "alice")
		assert.equal(result, null)
	})

	it("parses @room broadcast message", () => {
		const result = parseRoomMessage("I did some work.\n@room Here are my findings.", "alice")
		assert.ok(result)
		assert.equal(result.to, undefined)
		assert.equal(result.body, "Here are my findings.")
		assert.equal(result.isReviewRequest, false)
		assert.equal(result.isGateRequest, false)
	})

	it("parses @name direct message", () => {
		const result = parseRoomMessage("@bob Please review this.", "alice", ["bob"])
		assert.ok(result)
		assert.equal(result.to, "bob")
		assert.equal(result.body, "Please review this.")
	})

	it("ignores @name when name is not in known participants", () => {
		const result = parseRoomMessage("@unknown Hello there.", "alice", ["bob"])
		assert.equal(result, null)
	})

	it("uses the last @room match", () => {
		const text = "@room First message\nDoing some work...\n@room Second message"
		const result = parseRoomMessage(text, "alice")
		assert.ok(result)
		assert.equal(result.body, "Second message")
	})

	it("detects REVIEW_REQUEST: prefix", () => {
		const result = parseRoomMessage("@room REVIEW_REQUEST: Code is ready. Branch: main.", "alice")
		assert.ok(result)
		assert.equal(result.isReviewRequest, true)
		assert.equal(result.body, "REVIEW_REQUEST: Code is ready. Branch: main.")
	})

	it("detects GATE: prefix", () => {
		const result = parseRoomMessage("@room GATE: Should we use Redis or Memcached?", "alice")
		assert.ok(result)
		assert.equal(result.isGateRequest, true)
		assert.equal(result.body, "GATE: Should we use Redis or Memcached?")
	})

	it("handles multiline body", () => {
		const text = "@room Here is my review:\n- Issue 1\n- Issue 2\n- Issue 3"
		const result = parseRoomMessage(text, "alice")
		assert.ok(result)
		assert.ok(result.body.includes("Issue 1"))
		assert.ok(result.body.includes("Issue 3"))
	})

	it("handles @room with no known participants list", () => {
		const result = parseRoomMessage("@room Hello everyone", "alice")
		assert.ok(result)
		assert.equal(result.to, undefined)
		assert.equal(result.body, "Hello everyone")
	})
})
