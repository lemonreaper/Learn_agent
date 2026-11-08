/**
 * ChatGPT error mapping (fork, 2026-11-07). A learner hit the catch-all
 * "ChatGPT request failed" repeatedly with no way to tell why: plan-limit,
 * context-overflow, network and server errors all fell through to it. The
 * map now names them, and the catch-all carries a SAFE machine code (never
 * provider prose — the redaction rule in chatgpt-stream.test.ts stands).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatGPTErrorCode, chatGPTStreamError, describeTrace, networkCodeOf } from "../src/agent/chatgpt-stream.ts";

describe("networkCodeOf — the transport code the SDK would hide", () => {
	it("reads undici's cause.code, a nested cause, or err.code; never prose", () => {
		assert.equal(networkCodeOf(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), "ECONNRESET");
		assert.equal(networkCodeOf({ cause: { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } } }), "UND_ERR_CONNECT_TIMEOUT");
		assert.equal(networkCodeOf({ code: "ENOTFOUND" }), "ENOTFOUND");
		assert.equal(networkCodeOf({ cause: { code: "secret words here" } }), null);
		assert.equal(networkCodeOf(null), null);
	});
});

describe("chatGPTStreamError — named causes", () => {
	it("plan limits under every code, not only subscription_sharing_*", () => {
		for (const m of ["usage_limit_reached", "rate_limit_exceeded", "OpenAI API error 429", "subscription_sharing_usage_limit_exceeded"]) {
			assert.match(chatGPTStreamError(m), /usage limit reached/, m);
		}
	});

	it("context overflow is named — and is NOT reported as an unavailable model", () => {
		const m = "400 context_length_exceeded: This model's maximum context length is 400000 tokens";
		const out = chatGPTStreamError(m);
		assert.match(out, /too long for the selected ChatGPT model's context window/);
		assert.doesNotMatch(out, /unavailable/);
	});

	it("network failures point at the VPN, even when the text says 'closed'", () => {
		for (const m of ["fetch failed", "ECONNRESET", "connect ETIMEDOUT 104.18.1.1:443", "UND_ERR_SOCKET other side closed", "getaddrinfo ENOTFOUND api.openai.com"]) {
			assert.match(chatGPTStreamError(m), /Could not reach OpenAI/, m);
		}
	});

	it("the OpenAI SDK's own wording for transport failures (0.4.4 missed these)", () => {
		for (const m of ["Connection error.", "Request timed out.", "terminated"]) {
			assert.match(chatGPTStreamError(m), /^Could not reach OpenAI from this computer\./, m);
		}
		// With the transport code captured at the fetch seam, it is shown.
		assert.match(chatGPTStreamError("Connection error. ECONNRESET"), /^Could not reach OpenAI from this computer \(code: ECONNRESET\)\./);
	});

	it("OpenAI server errors", () => {
		for (const m of ["OpenAI API error 502", "server_error", "The engine is currently overloaded"]) {
			assert.match(chatGPTStreamError(m), /server error/, m);
		}
	});

	it("the upstream mappings still hold", () => {
		assert.match(chatGPTStreamError("invalid_grant"), /session expired/);
		assert.match(chatGPTStreamError("cancelled or catalog authority changed"), /cancelled/);
		assert.match(chatGPTStreamError("ChatGPT account catalog has no selected model"), /unavailable/);
		assert.match(chatGPTStreamError("incomplete terminal response"), /incomplete response/);
	});
});

describe("the catch-all carries a safe code, never provider prose", () => {
	it("snake_case code, Node code, or HTTP status — nothing else", () => {
		assert.equal(chatGPTErrorCode("invalid_request_error: secret scratch provider diagnostic"), "invalid_request_error");
		assert.equal(chatGPTErrorCode("EPROTO something"), "EPROTO");
		assert.equal(chatGPTErrorCode("status 418 secret words"), "418");
		assert.equal(chatGPTErrorCode("secret scratch provider diagnostic"), null);
	});

	it("the message shows the code and drops the prose", () => {
		const out = chatGPTStreamError("invalid_request_error: secret scratch provider diagnostic");
		assert.match(out, /^ChatGPT request failed \(code: invalid_request_error\)\./);
		assert.doesNotMatch(out, /secret/);
		assert.equal(
			chatGPTStreamError("something odd happened"),
			"ChatGPT request failed. Check your connection and ChatGPT usage, then retry. No API-key fallback was used.",
		);
	});
});

describe("transport trace in the message (0.4.6)", () => {
	it("connect failures say how long the attempt took", () => {
		const out = chatGPTStreamError("Connection error.", { stage: "connect", code: "ECONNREFUSED", elapsedS: 3, idleS: null, bytes: 0 });
		assert.match(out, /^Could not reach OpenAI from this computer \(code: ECONNREFUSED; connection failed after 3 s\)\./);
	});
	it("a mid-stream cut is NOT 'could not reach' — it names the cut and the silence before it", () => {
		const out = chatGPTStreamError("terminated", { stage: "stream", code: null, elapsedS: 75, idleS: 61, bytes: 2048 });
		assert.match(out, /^The connection to OpenAI was cut while the answer was streaming \(stream cut after 75 s, 61 s after the last data, 2048 bytes received\)\./);
		assert.match(out, /lower thinking level/);
	});
	it("describeTrace is numbers and codes only", () => {
		assert.equal(describeTrace({ stage: "stream", code: "UND_ERR_BODY_TIMEOUT", elapsedS: 300, idleS: 300, bytes: 512 }), "code: UND_ERR_BODY_TIMEOUT; stream cut after 300 s, 300 s after the last data, 512 bytes received");
	});
});
