/**
 * The model-request log (fork, 0.4.7): every production request writes a
 * numbered life story to main.log, and the demo builder retries ONCE when
 * the connection drops. A learner's demo died with a bare "terminated" and
 * nothing in the log — these pin the lines that would have said where.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { currentLogLabel, setRequestLogSink, tracedFetch, tracedStreamFn, transportCode, withLogContext } from "../src/agent/request-log.ts";
import { isTransientFailure, runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import type { DemoRunResult, HeadlessApi } from "../src/agent/subagents/headless.ts";
import type { PiEngine } from "../src/agent/models.ts";

const lines: string[] = [];
before(() => {
	process.env.LH_REQUEST_LOG = "1";
	setRequestLogSink((line) => lines.push(line));
});
after(() => {
	delete process.env.LH_REQUEST_LOG;
	setRequestLogSink(null);
});

const enc = new TextEncoder();
function streamingResponse(parts: string[], failAfter?: { index: number; err: unknown }, status = 200): Response {
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(ctrl) {
			if (failAfter && i === failAfter.index) return ctrl.error(failAfter.err);
			if (i >= parts.length) return ctrl.close();
			ctrl.enqueue(enc.encode(parts[i++]!));
		},
	});
	return new Response(body, { status, headers: { "x-request-id": "req_1" } });
}

async function drain(res: Response): Promise<string> {
	return await res.text();
}

describe("tracedFetch — the transport story of one request", () => {
	it("a complete stream: dispatch, headers with the generation id, completion stats", async () => {
		const out: string[] = [];
		const f = tracedFetch(async () => streamingResponse(['data: {"id":"gen-abc123","choices":[]}\n\n', "data: [DONE]\n\n"]), (l) => out.push(l));
		const res = await f("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "x".repeat(2048) });
		await drain(res);
		assert.match(out[0]!, /^→ POST openrouter\.ai\/api\/v1\/chat\/completions \(attempt 1, body 2\.0 KB\)$/);
		assert.match(out[1]!, /^← HTTP 200 after \d+\.\d s · x-request-id req_1 · generation gen-abc123$/);
		assert.match(out[2]!, /^✓ body complete after \d+\.\d s · \d+ B in 2 chunks · first data after/);
	});

	it("a mid-stream cut names the transport code, bytes and silence", async () => {
		const out: string[] = [];
		const cut = new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
		const f = tracedFetch(async () => streamingResponse(["data: {}\n\n"], { index: 1, err: cut }), (l) => out.push(l));
		const res = await f("https://api.openai.com/v1/responses", { method: "POST" });
		await assert.rejects(drain(res));
		const last = out[out.length - 1]!;
		assert.match(last, /^✗ stream cut after \d+\.\d s \(code UND_ERR_SOCKET\) · \d+ s after the last data · 10 B in 1 chunk/);
		assert.match(last, /TypeError: terminated \(other side closed\)/);
	});

	it("a refused connection is a connect failure, with its code", async () => {
		const out: string[] = [];
		const f = tracedFetch(async () => {
			throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
		}, (l) => out.push(l));
		await assert.rejects(f("https://openrouter.ai/x", { method: "POST" }));
		assert.match(out[1]!, /^✗ connect failed after \d+\.\d s \(code ECONNRESET\) · TypeError: fetch failed$/);
	});

	it("an HTTP error logs the provider's own words", async () => {
		const out: string[] = [];
		const f = tracedFetch(async () => new Response('{"error":{"message":"No allowed providers"}}', { status: 404 }), (l) => out.push(l));
		const res = await f("https://openrouter.ai/x", { method: "POST" });
		assert.equal(res.status, 404, "the response is passed through untouched");
		assert.match(out[1]!, /^← HTTP 404 after .* body: \{"error":\{"message":"No allowed providers"\}\}$/);
	});

	it("SDK retries count as attempts", async () => {
		const out: string[] = [];
		const f = tracedFetch(async () => new Response("", { status: 500 }), (l) => out.push(l));
		await f("https://x.test/a", {});
		await f("https://x.test/a", {});
		assert.ok(out.some((l) => l.includes("(attempt 2")));
	});

	it("transportCode reads only machine codes", () => {
		assert.equal(transportCode({ cause: { cause: { code: "UND_ERR_BODY_TIMEOUT" } } }), "UND_ERR_BODY_TIMEOUT");
		assert.equal(transportCode({ cause: { code: "not a code" } }), null);
	});
});

describe("labels and the stream wrapper", () => {
	it("withLogContext nests labels", () => {
		assert.equal(currentLogLabel(), "unlabeled");
		withLogContext("job j1 demo", () => withLogContext("demoBuilder", () => assert.equal(currentLogLabel(), "job j1 demo › demoBuilder")));
	});

	it("each request logs start (with who asked) and its result; the fetch it hands down is traced", async () => {
		lines.length = 0;
		let handed: typeof fetch | undefined;
		const inner = ((_model, _ctx, options) => {
			handed = options?.fetch;
			const s = createAssistantMessageEventStream();
			const m = fauxAssistantMessage([fauxToolCall("write_demo", { html: "x" }, { id: "t1" })], { stopReason: "toolUse" });
			queueMicrotask(() => s.push({ type: "done", reason: "toolUse", message: m }));
			return s;
		}) as Parameters<typeof tracedStreamFn>[0];
		const traced = tracedStreamFn(inner);
		const model = { provider: "custom", id: "@preset/deepseek-learn", maxTokens: 128000 } as never;
		const stream = withLogContext("job j2 demo", () => traced(model, { messages: [] } as never, { reasoning: "high" } as never));
		await stream.result();
		await new Promise((r) => setImmediate(r));
		assert.match(lines[0]!, /^\[model #\d+\] start · job j2 demo · custom\/@preset\/deepseek-learn · thinking high · ~\d+ B context · max out 128000$/);
		assert.match(lines[1]!, /^\[model #\d+\] done after \d+\.\d s · stop toolUse · tokens in \d+ out \d+ · tools: write_demo$/);
		assert.ok(handed && handed !== globalThis.fetch, "a traced fetch is injected");
	});
});

// ─── the demo builder's one retry ────────────────────────────────────────────

const GOOD_HTML = "<!doctype html><html><body><canvas></canvas></body></html>";
const CLEAN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
function headless(): HeadlessApi {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => CLEAN,
		renderSvg: async () => Buffer.alloc(0),
	} as unknown as HeadlessApi;
}
function engine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const write = fauxAssistantMessage([fauxToolCall("write_demo", { html: GOOD_HTML } as ToolCall["arguments"], { id: "w" })], { stopReason: "toolUse" });
const run = fauxAssistantMessage([fauxToolCall("run_demo", {} as ToolCall["arguments"], { id: "r" })], { stopReason: "toolUse" });
const cut = fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });

describe("demo builder — one automatic retry on a dropped connection", () => {
	it("classifies transport failures, not model failures", () => {
		for (const m of ["terminated", "Connection error.", "The connection to OpenAI was cut while…", "fetch failed ECONNRESET"]) assert.ok(isTransientFailure(m), m);
		for (const m of ["invalid_request_error", "context_length_exceeded", "the builder never wrote a demo"]) assert.ok(!isTransientFailure(m), m);
	});

	it("a cut on the first attempt is retried from scratch and delivers", async () => {
		const activity: string[] = [];
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: engine([cut, write, run, fauxAssistantMessage("Notes.")]), headless: headless(), onActivity: (l) => activity.push(l) });
		assert.equal(result.html, GOOD_HTML);
		assert.ok(activity.includes("retrying after a dropped connection"));
	});

	it("two cuts in a row give up and say a retry happened", async () => {
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: engine([cut, cut]), headless: headless() });
		assert.equal(result.html, "");
		assert.equal(result.notes, "FAILED: the builder crashed — terminated (after one automatic retry)");
	});

	it("a cut AFTER a passing test delivers the tested demo instead of rebuilding", async () => {
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: engine([write, run, cut]), headless: headless() });
		assert.equal(result.html, GOOD_HTML);
	});

	it("a non-transport failure is not retried", async () => {
		const bad = fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request_error" });
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: engine([bad, write]), headless: headless() });
		assert.equal(result.notes, "FAILED: the builder crashed — invalid_request_error");
	});
});
