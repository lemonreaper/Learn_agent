import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { chatGPTAbortController, chatGPTScope, chatGPTScopeCurrent, chatGPTLease, chatGPTDenial } from "./chatgpt-bridge.ts";
import type { AdmissionScope, ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { capturePreparedBackgroundPayload } from "./background-capture.ts";

const USAGE = "https://chatgpt.com/settings/usage";

/**
 * A SAFE diagnostic code from a provider error (fork, 2026-11-07): never
 * provider prose (the redaction rule stands), only machine tokens — a
 * snake_case error code, a Node/undici network code, or an HTTP status.
 * The catch-all message used to hide the real cause entirely.
 */
export function chatGPTErrorCode(message: string): string | null {
	return message.match(/\b[a-z]+(?:_[a-z]+){1,6}\b/)?.[0]
		?? message.match(/\b(?:E[A-Z]{3,}|UND_ERR_[A-Z_]+)\b/)?.[0]
		?? message.match(/\b[45]\d\d\b/)?.[0]
		?? null;
}

export function chatGPTStreamError(message: string): string {
	// FORK (2026-11-07): more plan-limit codes. ChatGPT plan limits surface
	// as usage_limit_reached / rate_limit_exceeded too, not only
	// subscription_sharing_usage_limit_exceeded — those fell through to the
	// generic "request failed" and looked like a connection problem.
	if (/subscription_sharing_usage_limit_exceeded|usage_limit|rate_limit|quota|429/.test(message)) return `ChatGPT plan usage limit reached. Manage usage at ${USAGE}. No API-key fallback was used.`;
	// FORK: a session that outgrew the model's window — BEFORE the /model/
	// check below, whose wording ("model's maximum context length") would
	// otherwise report a healthy model as unavailable.
	if (/context_length_exceeded|context window|maximum context|context length|too many tokens/i.test(message)) return "This session is now too long for the selected ChatGPT model's context window. Start a new session, or lower the compaction threshold in Settings → Agent so the history gets summarized sooner. No API-key fallback was used.";
	if (/scope|authorization_context|permission/.test(message)) return "ChatGPT plan permission is missing. Reconnect in Providers and authorize plan use. No API-key fallback was used.";
	if (/expired|invalid_grant|401|invalid_user/.test(message)) return "Your ChatGPT session expired. Reconnect in Providers. No API-key fallback was used.";
	if (/background|Background/.test(message)) return "ChatGPT background use is off in this app. Enable Allow background use for all ChatGPT accounts in Providers to run this work. No API-key fallback was used.";
	if (/eligible|403/.test(message)) return "This ChatGPT account or workspace does not permit this request. Check ChatGPT settings; reconnecting may not change eligibility.";
	// FORK: the app could not reach OpenAI at all — in practice a VPN that
	// dropped or covers only the browser (the app's requests do not follow a
	// system proxy). Checked BEFORE cancel/closed, which "socket closed" hits.
	// FORK (2026-11-08): the OpenAI SDK rewrites every transport failure as
	// "Connection error." / "Request timed out.", and a stream cut mid-body
	// surfaces as "terminated" — none carried a code, so 0.4.4 still fell
	// through to the catch-all. The real network code is captured at the
	// fetch seam (networkCodeOf) and appended to the message.
	if (/fetch failed|connection error|timed out|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR|socket|network|getaddrinfo|certificate|TLS/i.test(message)) {
		const code = chatGPTErrorCode(message);
		return `Could not reach OpenAI from this computer${code ? ` (code: ${code})` : ""}. If you use a VPN, make sure it is connected and routes ALL traffic (TUN / full tunnel), then retry. No API-key fallback was used.`;
	}
	if (/cancel|abort|closed|disconnect/i.test(message)) return "ChatGPT request cancelled or connection closed. No API-key fallback was used.";
	// FORK: OpenAI-side failures — nothing to fix locally.
	if (/\b5\d\d\b|server_error|overloaded|service_unavailable|temporarily unavailable/i.test(message)) return "OpenAI had a server error. Retry in a minute. No API-key fallback was used.";
	if (/catalog|model/.test(message)) return "The selected model is unavailable for this ChatGPT account. Refresh Providers and explicitly choose an available model. No API-key fallback was used.";
	if (/incomplete|terminal|interrupted|stop reason/.test(message)) return "ChatGPT returned an incomplete response. Retry when ready; no API-key fallback was used.";
	const code = chatGPTErrorCode(message);
	return `ChatGPT request failed${code ? ` (code: ${code})` : ""}. Check your connection and ChatGPT usage, then retry. No API-key fallback was used.`;
}

/** The machine code of a transport failure (fork, 2026-11-08): undici puts
 *  it on err.cause.code (ECONNRESET, UND_ERR_SOCKET, …), Node on err.code;
 *  a TLS failure names itself in err.cause.code too. Never prose. */
export function networkCodeOf(err: unknown): string | null {
	const pick = (v: unknown) => (typeof v === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(v) ? v : null);
	const e = err as { code?: unknown; cause?: { code?: unknown; cause?: { code?: unknown } } } | null;
	return pick(e?.cause?.code) ?? pick(e?.cause?.cause?.code) ?? pick(e?.code) ?? null;
}

/** Restrict the body at the final payload seam, even if caller samplingParams add fields. */
export function chatGPTPayload(raw: unknown, selectedModelId: string): Record<string, unknown> {
	const payload = raw as Record<string, unknown>;
	const out: Record<string, unknown> = { model: selectedModelId, store: false, stream: true };
	for (const key of ["instructions", "reasoning", "include", "text", "tool_choice", "parallel_tool_calls", "prompt_cache_key"]) {
		if (payload[key] !== undefined) out[key] = payload[key];
	}
	if (!Array.isArray(payload.input)) throw new Error("ChatGPT requires stateless input history");
	out.input = payload.input.map((item) => item?.role === "system" ? { ...item, role: "developer" } : item);
	if (Array.isArray(payload.tools) && payload.tools.length) {
		if (payload.tools.some((tool) => tool.type !== "function" && tool.type !== "custom")) throw new Error("Unsupported ChatGPT tool capability");
		out.tools = [{ type: "namespace", name: "learnharness", description: "LearnHarness local learning tools", tools: payload.tools }];
	}
	return out;
}

/** Only ChatGPT history is translated. Mixed API-key history keeps its actual identity. */
export function chatGPTHistory(context: TranscriptContext, logicalModel: Model<Api>): TranscriptContext {
	// Apply Pi's normal foreign-model signature treatment BEFORE the alias
	// becomes openai, or real API-key turns could look like subscription turns.
	const messages = transformMessages(context.messages, logicalModel);
	return { ...context, messages: messages.map((m) => m.role === "assistant" && m.provider === "chatgpt" ? { ...m, provider: "openai" } : m) };
}
function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: "chatgpt", model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function chatGPTStream(background: () => boolean, lifecycle?: ChatGPTDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = chatGPTAbortController(purpose);
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		void (async () => {
			let partial = empty(logicalModel);
			let completed = false;
			let failure = "";
			let scope: AdmissionScope | undefined;
			let committed = false;
			let terminal = false;
			let networkCode: string | null = null;
			const check = () => { if (signal.aborted || !scope || !chatGPTScopeCurrent(scope)) throw new Error("cancelled or catalog authority changed"); };
			try {
				if (logicalModel.provider !== "chatgpt") throw new Error("ChatGPT account catalog has no selected model");
				if (Object.keys(options?.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) throw new Error("Authorization override is forbidden");
				scope = chatGPTScope(logicalModel.id);
				lifecycle?.captured(scope);
				const credentials = await chatGPTLease(scope, purpose);
				check();
				// NEVER dispatch through Models under openai: that would expose ambient API-key fallback.
				const transport: Model<"openai-responses"> = { ...logicalModel, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", headers: undefined, samplingParams: undefined, compat: { ...logicalModel.compat, supportsDeveloperRole: true } };
				const delegate = options?.fetch ?? globalThis.fetch;
				const source = streamSimple(transport, chatGPTHistory(context, logicalModel), {
					...options,
					apiKey: credentials.accessToken,
					signal,
					maxRetries: 0,
					headers: { "OpenAI-Beta": null, ...options?.headers },
					fetch: (input, init) => {
						check();
						if (committed) throw new Error("ChatGPT does not retry admitted requests");
						lifecycle?.beforeDispatch(scope!);
						committed = true;
						// FORK: keep the transport's machine code before the SDK
						// replaces the error with "Connection error.".
						return delegate(input, init).catch((err: unknown) => {
							networkCode = networkCodeOf(err);
							throw err;
						});
					},
					onPayload: async (raw, model) => {
						const replacement = await options?.onPayload?.(raw, model);
						const payload = chatGPTPayload(replacement === undefined ? raw : replacement, logicalModel.id);
						check();
						capturePreparedBackgroundPayload(payload, logicalModel);
						return payload;
					},
					onProviderStreamEvent: async (raw, model) => {
						const event = raw as { type?: string; code?: string; error?: { code?: string }; response?: { error?: { code?: string }; status?: string } };
						if (event.type === "response.completed" && event.response?.status === "completed" && !event.response?.error) completed = true;
						if (["response.incomplete", "response.failed", "error"].includes(event.type ?? "") || event.response?.error) failure = event.code || event.error?.code || event.response?.error?.code || "incomplete terminal response";
						await options?.onProviderStreamEvent?.(raw, model);
					},
				});
				for await (const event of source) {
					const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
					// Copy the message, not its tool/reasoning blocks: IDs/signatures remain byte-for-byte intact.
					partial = { ...message, provider: "chatgpt" };
					if (event.type === "done") {
						if (!completed || failure) throw new Error(failure || "missing terminal response.completed");
						terminal = true;
						output.push({ ...event, message: partial });
					} else if (event.type === "error") {
						throw new Error(failure || event.error.errorMessage || "ChatGPT stream error");
					} else output.push({ ...event, partial });
				}
			} catch (err) {
				if (terminal) return;
				if (!committed) lifecycle?.noDispatch(await chatGPTDenial(scope, controller, options?.signal?.aborted === true, purpose));
				const raw = err instanceof Error ? err.message : "";
				partial = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: chatGPTStreamError(networkCode ? `${raw} ${networkCode}` : raw) };
				output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
			} finally { release(); output.end(); }
		})();
		return output;
	};
}
