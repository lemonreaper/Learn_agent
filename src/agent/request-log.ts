import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, Model, StreamFunction } from "@earendil-works/pi-ai";

/**
 * THE MODEL-REQUEST LOG (fork, 2026-11-08, 0.4.7). A learner's long streams
 * were cut somewhere between the app and the provider, and the only trace in
 * main.log was a bare "terminated" — sometimes nothing at all (the demo
 * builder and every OpenRouter route logged no failures). Every production
 * model request now writes a short, numbered life story to the console
 * (→ userData/logs/main.log via the desktop shell):
 *
 *   [model #12] start · job job_x demo › demoBuilder · custom/@preset/x · thinking high · ~48 KB context
 *   [model #12] → POST openrouter.ai/api/v1/chat/completions (attempt 1, body 48 KB)
 *   [model #12] ← HTTP 200 after 0.4 s · generation gen-…
 *   [model #12] … streaming 60 s · 123 KB in 812 chunks · last data 1 s ago
 *   [model #12] ✗ stream cut after 248 s (code UND_ERR_SOCKET) · 3 s after the last data · …
 *   [model #12] error after 248.3 s · terminated
 *
 * WHO is asking comes from an AsyncLocalStorage label (withLogContext) set
 * by the chat turn, the job runner and the sub-agent runner — no signature
 * threading through the engine factory. Never logged: prompts, outputs,
 * keys, headers other than request ids. Error BODIES of non-2xx responses
 * are logged (≤ 800 chars) — this is the learner's own local log, and the
 * provider's own words are the diagnosis.
 *
 * Off under NODE_ENV=test unless LH_REQUEST_LOG=1 (tests opt in).
 */

const context = new AsyncLocalStorage<string>();

/** Run fn with a "who is calling" label; nested labels join with " › ". */
export function withLogContext<T>(label: string, fn: () => T): T {
	const parent = context.getStore();
	return context.run(parent ? `${parent} › ${label}` : label, fn);
}

export function currentLogLabel(): string {
	return context.getStore() ?? "unlabeled";
}

export function requestLogEnabled(): boolean {
	return process.env.LH_REQUEST_LOG === "1" || (process.env.NODE_ENV !== "test" && process.env.LH_REQUEST_LOG !== "0");
}

/** Pluggable sink (tests capture lines). */
let sink: (line: string) => void = (line) => console.info(line);
export function setRequestLogSink(next: ((line: string) => void) | null): void {
	sink = next ?? ((line) => console.info(line));
}

const HEARTBEAT_MS = 30_000;
let counter = 0;

const secs = (ms: number) => (ms / 1000).toFixed(1);
const roundS = (ms: number) => Math.round(ms / 1000);
export function kb(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** The transport code undici hides under err.cause (ECONNRESET, UND_ERR_SOCKET…). */
export function transportCode(err: unknown): string | null {
	const pick = (v: unknown): string | null => {
		const code = (v as { code?: unknown } | null | undefined)?.code;
		return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? code : null;
	};
	const e = err as { cause?: unknown } | null | undefined;
	return pick((e?.cause as { cause?: unknown } | undefined)?.cause) ?? pick(e?.cause) ?? pick(err);
}

function errText(err: unknown): string {
	if (err instanceof Error) {
		const cause = err.cause instanceof Error && err.cause.message !== err.message ? ` (${err.cause.message})` : "";
		return `${err.name !== "Error" ? `${err.name}: ` : ""}${err.message}${cause}`.slice(0, 300);
	}
	return String(err).slice(0, 300);
}

function bodySize(body: unknown): number | null {
	if (typeof body === "string") return Buffer.byteLength(body);
	if (body instanceof Uint8Array) return body.byteLength;
	if (body instanceof ArrayBuffer) return body.byteLength;
	return null;
}

function target(input: unknown): string {
	try {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		const url = new URL(raw);
		return `${url.host}${url.pathname}`;
	} catch {
		return "(unknown url)";
	}
}

type Fetch = typeof globalThis.fetch;

/**
 * Wrap a fetch so every attempt logs dispatch, headers, a heartbeat while
 * the body streams, and how the body ended (complete / cut / cancelled).
 * The SDK's own retries show up as attempt 2, 3….
 */
export function tracedFetch(delegate: Fetch, log: (line: string) => void): Fetch {
	let attempt = 0;
	return async (input, init) => {
		attempt++;
		const size = bodySize(init?.body);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		log(`→ ${method} ${target(input)} (attempt ${attempt}${size !== null ? `, body ${kb(size)}` : ""})`);
		const startedAt = Date.now();
		let res: Response;
		try {
			res = await delegate(input, init);
		} catch (err) {
			const aborted = init?.signal?.aborted === true;
			const code = transportCode(err);
			log(
				aborted
					? `⊘ request aborted by the app after ${secs(Date.now() - startedAt)} s (before any response)`
					: `✗ connect failed after ${secs(Date.now() - startedAt)} s${code ? ` (code ${code})` : ""} · ${errText(err)}`,
			);
			throw err;
		}
		const headersAt = Date.now();
		const ids = ["x-request-id", "cf-ray", "x-generation-id"]
			.map((h) => (res.headers.get(h) ? `${h} ${res.headers.get(h)}` : null))
			.filter(Boolean);
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.clone().text()).replace(/\s+/g, " ").slice(0, 800);
			} catch {
				/* unreadable error body */
			}
			log(`← HTTP ${res.status} after ${secs(headersAt - startedAt)} s${ids.length ? ` · ${ids.join(" · ")}` : ""}${detail ? ` · body: ${detail}` : ""}`);
			return res;
		}
		if (!res.body) {
			log(`← HTTP ${res.status} after ${secs(headersAt - startedAt)} s (no body)`);
			return res;
		}

		let bytes = 0;
		let chunks = 0;
		let firstByteAt = 0;
		let lastDataAt = headersAt;
		let longestGap = 0;
		let generation: string | null = null;
		let head = "";
		let headLogged = false;
		const decoder = new TextDecoder();
		const logHeaders = () => {
			if (headLogged) return;
			headLogged = true;
			log(`← HTTP ${res.status} after ${secs(headersAt - startedAt)} s${ids.length ? ` · ${ids.join(" · ")}` : ""}${generation ? ` · generation ${generation}` : ""}`);
		};
		const stats = () =>
			`${kb(bytes)} in ${chunks} chunk${chunks === 1 ? "" : "s"}` +
			(firstByteAt ? ` · first data after ${secs(firstByteAt - startedAt)} s` : " · no data") +
			` · longest silence ${roundS(longestGap)} s`;

		const heartbeat = setInterval(() => {
			logHeaders();
			log(`… streaming ${roundS(Date.now() - startedAt)} s · ${kb(bytes)} in ${chunks} chunks · last data ${roundS(Date.now() - lastDataAt)} s ago`);
		}, HEARTBEAT_MS);
		heartbeat.unref?.();
		let finished = false;
		const finish = (line: string) => {
			if (finished) return;
			finished = true;
			clearInterval(heartbeat);
			logHeaders();
			log(line);
		};

		const reader = res.body.getReader();
		const body = new ReadableStream<Uint8Array>({
			async pull(ctrl) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						finish(`✓ body complete after ${secs(Date.now() - startedAt)} s · ${stats()}`);
						return ctrl.close();
					}
					const now = Date.now();
					if (!firstByteAt) firstByteAt = now;
					longestGap = Math.max(longestGap, now - lastDataAt);
					lastDataAt = now;
					bytes += value.byteLength;
					chunks++;
					if (!headLogged && head.length < 4096) {
						head += decoder.decode(value, { stream: true });
						generation = head.match(/"id"\s*:\s*"(gen-[^"]+)"/)?.[1] ?? generation;
						if (generation || head.length >= 4096) logHeaders();
					}
					ctrl.enqueue(value);
				} catch (err) {
					const now = Date.now();
					const aborted = init?.signal?.aborted === true;
					const code = transportCode(err);
					finish(
						aborted
							? `⊘ body aborted by the app after ${secs(now - startedAt)} s · ${stats()}`
							: `✗ stream cut after ${secs(now - startedAt)} s${code ? ` (code ${code})` : ""} · ${roundS(now - lastDataAt)} s after the last data · ${stats()} · ${errText(err)}`,
					);
					ctrl.error(err);
				}
			},
			cancel(reason) {
				finish(`⊘ body cancelled by the app after ${secs(Date.now() - startedAt)} s · ${stats()}`);
				return reader.cancel(reason);
			},
		});
		return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
	};
}

function contextSize(ctx: unknown): string {
	try {
		return `~${kb(Buffer.byteLength(JSON.stringify(ctx)))} context`;
	} catch {
		return "context size unknown";
	}
}

function describeResult(m: AssistantMessage, startedAt: number): string {
	const u = m.usage;
	const tokens = u
		? ` · tokens in ${u.input}${u.cacheRead ? ` (+${u.cacheRead} cached)` : ""} out ${u.output}${typeof u.reasoning === "number" ? ` (reasoning ${u.reasoning})` : ""}`
		: "";
	const tools = (m.content ?? [])
		.filter((c): c is Extract<typeof c, { type: "toolCall" }> => (c as { type?: string }).type === "toolCall")
		.map((c) => (c as { name?: string }).name ?? "?");
	const took = secs(Date.now() - startedAt);
	if (m.stopReason === "error") return `error after ${took} s${tokens} · ${(m.errorMessage ?? "(no message)").slice(0, 500)}`;
	if (m.stopReason === "aborted") return `aborted after ${took} s${tokens}`;
	return `done after ${took} s · stop ${m.stopReason}${tokens}${tools.length ? ` · tools: ${tools.join(", ")}` : ""}`;
}

/** Wrap a production stream function so each request logs its life story. */
export function tracedStreamFn(streamFn: StreamFunction, describe: { thinking?: () => string | undefined } = {}): StreamFunction {
	return (model: Model<Api>, ctx, options) => {
		if (!requestLogEnabled()) return streamFn(model, ctx, options);
		const id = ++counter;
		const label = currentLogLabel();
		const log = (line: string) => sink(`[model #${id}] ${line}`);
		const startedAt = Date.now();
		const thinking = (options as { reasoning?: string } | undefined)?.reasoning ?? describe.thinking?.() ?? "off";
		log(`start · ${label} · ${model.provider}/${model.id} · thinking ${thinking} · ${contextSize(ctx)} · max out ${model.maxTokens}`);
		const fetch = tracedFetch(options?.fetch ?? globalThis.fetch, log);
		let stream: ReturnType<StreamFunction>;
		try {
			stream = streamFn(model, ctx, { ...options, fetch });
		} catch (err) {
			log(`threw before streaming · ${errText(err)}`);
			throw err;
		}
		void stream.result().then(
			(m) => log(describeResult(m, startedAt)),
			(err: unknown) => log(`failed after ${secs(Date.now() - startedAt)} s · ${errText(err)}`),
		);
		return stream;
	};
}

/** One line in the same log, under the same switch (agent / job lifecycle). */
export function logEvent(line: string): void {
	if (requestLogEnabled()) sink(line);
}
