import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared plumbing for the learner-filesystem tools (ls / find / grep) —
 * sources v1 (2026-09-19): the agent locates and reads the learner's files
 * itself, so paths need no UI affordance (user decision: no attachments —
 * the learner references files in messages; the agent finds them).
 *
 * Safety posture (user-locked): READ-ONLY by construction — no shell-out,
 * no user-controlled process args, no mutation APIs anywhere here. The one
 * deliberate scope widening vs pi: relative paths and default roots resolve
 * against the LEARNER'S HOME, not a project cwd — the harness has no
 * meaningful working directory, and "find my notes" should just work.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/{ls,find,grep}.js): the
 * schemas, descriptions, output formats, and truncation notices are copied
 * verbatim except where semantics differ (home default, no .gitignore —
 * replaced by hard noise exclusions).
 */

/** 50KB — pi's DEFAULT_MAX_BYTES, the output ceiling for every fs tool. */
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** pi's grep line-truncation length (GREP_MAX_LINE_LENGTH). */
export const GREP_MAX_LINE_LENGTH = 500;
/** Wall-clock budget for tree walks (find/grep over a whole home dir). */
export const WALK_TIMEOUT_MS = 10_000;

/**
 * Directory names never entered during walks. node_modules/.git mirror pi's
 * fd/rg defaults; Library/.Trash are the home-root noise the user approved
 * (2026-09-19) — caches, app support, and the trash live under them.
 * Explicit paths (ls/read of ~/Library/…) are NOT filtered — only walks.
 */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "Library", ".Trash"]);

/** Resolve a tool path argument: absolute stays, relative/absent → home.
 *  (pi resolves against the project cwd; the harness's "project" is the
 *  learner's life, so the home directory is the anchor.) A leading `~` or
 *  `~/` is the home directory, as a shell would expand it — learners and
 *  models write paths that way. `~user` is not expanded. */
export function resolveSourcePath(p?: string): string {
	if (!p) return os.homedir();
	if (p === "~" || p.startsWith("~/") || p.startsWith(`~${path.sep}`)) return path.join(os.homedir(), p.slice(1));
	return path.isAbsolute(p) ? p : path.join(os.homedir(), p);
}

/** pi's formatSize idiom (50KB prints as "50.0KB"). */
export function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Cap output to MAX_OUTPUT_BYTES on whole lines, pi's truncateHead idiom. */
export function capOutput(lines: string[]): { content: string; truncated: boolean } {
	const out: string[] = [];
	for (const line of lines) {
		const candidate = [...out, line].join("\n");
		if (Buffer.byteLength(candidate, "utf-8") > MAX_OUTPUT_BYTES) {
			return { content: out.join("\n"), truncated: true };
		}
		out.push(line);
	}
	return { content: out.join("\n"), truncated: false };
}

/** Expand top-level brace alternatives: '*.{ts,tsx}' → ['*.ts', '*.tsx'].
 *  Nested braces are out of scope (pi's fd handles them; models rarely
 *  emit them — a non-expanding literal match is the graceful fallback). */
export function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const close = pattern.indexOf("}", open);
	if (close === -1) return [pattern];
	const before = pattern.slice(0, open);
	const after = pattern.slice(close + 1);
	const alts: string[] = [];
	for (const alt of pattern.slice(open + 1, close).split(",")) {
		alts.push(...expandBraces(before + alt + after));
	}
	return alts;
}

/** Glob → anchored RegExp. '*' stays within a segment, '**' crosses '/',
 *  '?' is one char, everything else literal. */
export function globToRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += "[\\s\\S]*";
				i++;
				if (glob[i + 1] === "/") i++; // '**/' also eats the slash
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/**
 * pi/fd's matching rule: a pattern with no slash matches against the
 * BASENAME at any depth; one with a slash matches the relative path, with
 * an implied leading "**-slash" prefix unless it is itself anchored (see
 * the code below — the literal sequence cannot appear in this comment
 * because it terminates block comments).
 */
export function matchGlob(relativePath: string, pattern: string): boolean {
	const posix = relativePath.split(path.sep).join("/");
	const basename = posix.split("/").pop() ?? posix;
	for (const alt of expandBraces(pattern)) {
		if (!alt.includes("/")) {
			if (globToRegex(alt).test(basename)) return true;
		} else {
			let effective = alt;
			if (!effective.startsWith("/") && !effective.startsWith("**/") && effective !== "**") {
				effective = `**/${effective}`;
			}
			if (effective.startsWith("/")) effective = effective.slice(1);
			if (globToRegex(effective).test(posix)) return true;
		}
	}
	return false;
}

/**
 * Depth-first walk under `root`, never entering EXCLUDED_DIR_NAMES.
 * `visit` receives absolute file paths; returning true STOPS the walk
 * (find's result limit). The deadline bounds a home-dir walk to
 * WALK_TIMEOUT_MS — partial results are the graceful degradation.
 */
export async function walkFiles(
	root: string,
	visit: (filePath: string) => boolean | Promise<boolean>,
	signal?: AbortSignal,
): Promise<{ timedOut: boolean; aborted: boolean }> {
	const deadline = Date.now() + WALK_TIMEOUT_MS;
	let timedOut = false;
	let aborted = false;
	if (signal?.aborted) return { timedOut: false, aborted: true };

	const walkDir = async (dir: string): Promise<boolean> => {
		if (Date.now() > deadline) {
			timedOut = true;
			return true; // stop
		}
		if (signal?.aborted) {
			aborted = true;
			return true; // stop — abort yields partial results, not a throw
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return false; // unreadable dir (permissions): skip, keep walking
		}
		for (const entry of entries) {
			if (Date.now() > deadline) {
				timedOut = true;
				return true;
			}
			if (signal?.aborted) {
				aborted = true;
				return true;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
				if (await walkDir(full)) return true;
			} else if (entry.isFile()) {
				if (await visit(full)) return true;
			}
			// symlinks/other: not followed (pi's fd doesn't follow either)
		}
		return false;
	};

	await walkDir(root);
	return { timedOut, aborted };
}

/** True if the first 8KB chunk contains a NUL byte — pi/rg's binary skip.
 *  UTF-16 text is NOT binary (fork fix, 2026-11-03): Windows PowerShell 5
 *  redirection writes UTF-16 LE, full of NULs — those files were silently
 *  skipped by grep. A sniffed UTF-16 prefix exempts the file. */
export async function isBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buf, 0, 8192, 0);
		const head = buf.subarray(0, bytesRead);
		if (sniffUtf16(head) !== null) return false;
		return head.includes(0);
	} finally {
		await handle.close();
	}
}

/**
 * UTF-16 detection (fork fix, 2026-11-03): a BOM decides; without one, the
 * NUL pattern of mostly-ASCII text decides — in UTF-16 LE every ASCII char
 * is followed by a 0x00 (odd offsets), in BE preceded by one (even
 * offsets). Thresholds keep real binaries (NULs scattered both ways) out.
 */
export function sniffUtf16(buf: Uint8Array): "utf-16le" | "utf-16be" | null {
	if (buf.length >= 2) {
		if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
		if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
	}
	const pairs = Math.floor(Math.min(buf.length, 4096) / 2);
	if (pairs < 2) return null;
	let evenNul = 0;
	let oddNul = 0;
	for (let i = 0; i < pairs; i++) {
		if (buf[2 * i] === 0) evenNul++;
		if (buf[2 * i + 1] === 0) oddNul++;
	}
	if (oddNul / pairs > 0.3 && evenNul / pairs < 0.05) return "utf-16le";
	if (evenNul / pairs > 0.3 && oddNul / pairs < 0.05) return "utf-16be";
	return null;
}

/**
 * Decode a learner text file (fork fix, 2026-11-03). Every reader used to
 * assume UTF-8, so UTF-16 files (PowerShell 5 `>` output) read as
 * NUL-riddled garbage and legacy Russian Windows-1251 texts as U+FFFD.
 * Order: BOM / UTF-16 sniff → UTF-8 (BOM stripped) → Windows-1251 when
 * the UTF-8 reading is mostly replacement characters (the dominant legacy
 * 8-bit encoding for this app's Cyrillic users; for other legacy encodings
 * it is still a better fallback than a wall of U+FFFD).
 */
export function decodeText(buf: Uint8Array): string {
	const utf16 = sniffUtf16(buf);
	if (utf16 !== null) {
		const hasBom = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
		return new TextDecoder(utf16).decode(hasBom ? buf.subarray(2) : buf);
	}
	const utf8 = new TextDecoder("utf-8", { ignoreBOM: false }).decode(buf);
	// Fall back only when invalid sequences are SYSTEMIC: one torn byte in a
	// real UTF-8 file (a truncated download) must not turn its Cyrillic into
	// mojibake. In Windows-1251 Russian text nearly every non-ASCII byte is
	// invalid UTF-8, so the replacement share of non-ASCII chars is high.
	let bad = 0;
	let nonAscii = 0;
	for (const ch of utf8) {
		if (ch.codePointAt(0)! > 0x7f) nonAscii++;
		if (ch === "�") bad++;
	}
	return bad > 0 && bad / nonAscii > 0.3 ? new TextDecoder("windows-1251").decode(buf) : utf8;
}

/** pi's GREP_MAX_LINE_LENGTH line truncation (no mid-word care, hard cap). */
export function truncateGrepLine(line: string): { text: string; wasTruncated: boolean } {
	if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}… [truncated]`, wasTruncated: true };
}
