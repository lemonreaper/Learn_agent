/**
 * Learner-file text decoding (fork fix, 2026-11-03): read and grep used to
 * assume UTF-8, so a UTF-16 LE file — what Windows PowerShell 5 writes with
 * `>` — read as NUL-riddled garbage and was skipped by grep as "binary";
 * legacy Windows-1251 Russian text read as replacement characters.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { decodeText, isBinaryFile, sniffUtf16 } from "../src/agent/tools/fs-shared.ts";
import { grepTool } from "../src/agent/tools/grep.ts";
import { readTool } from "../src/agent/tools/read.ts";

const TEXT = "time: 03.11 20:43:15\r\nadapters up: Беспроводная сеть\r\n";

const utf16le = (s: string, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);
function utf16be(s: string): Buffer {
	const le = Buffer.from(s, "utf16le");
	const be = Buffer.alloc(le.length);
	for (let i = 0; i < le.length; i += 2) {
		be[i] = le[i + 1]!;
		be[i + 1] = le[i]!;
	}
	return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}
/** "Привет, мир" in Windows-1251. */
const CP1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x2c, 0x20, 0xec, 0xe8, 0xf0]);

describe("decodeText", () => {
	it("UTF-16 LE with a BOM (PowerShell 5 `>` output)", () => {
		assert.equal(decodeText(utf16le(TEXT)), TEXT);
	});
	it("UTF-16 LE without a BOM, sniffed from the NUL pattern", () => {
		assert.equal(sniffUtf16(utf16le("plain ascii text, quite long", false)), "utf-16le");
		assert.equal(decodeText(utf16le(TEXT, false)), TEXT);
	});
	it("UTF-16 BE with a BOM", () => {
		assert.equal(decodeText(utf16be(TEXT)), TEXT);
	});
	it("UTF-8, with or without a BOM (BOM stripped)", () => {
		assert.equal(decodeText(Buffer.from(TEXT, "utf-8")), TEXT);
		assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, "utf-8")])), TEXT);
	});
	it("invalid UTF-8 falls back to Windows-1251", () => {
		assert.equal(decodeText(CP1251), "Привет, мир");
	});
	it("one torn byte in real UTF-8 keeps the UTF-8 reading (no mojibake)", () => {
		const torn = Buffer.concat([Buffer.from("Гетероскедастичность и инструменты ", "utf-8"), Buffer.from([0xd0])]);
		const out = decodeText(torn);
		assert.match(out, /^Гетероскедастичность и инструменты /);
		assert.ok(out.endsWith("�"));
	});
	it("a binary prefix with scattered NULs is not mistaken for UTF-16", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x01, 0x00]);
		assert.equal(sniffUtf16(png), null);
	});
});

describe("read + grep on non-UTF-8 learner files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-enc-"));
	after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "ps-output.txt"), utf16le(TEXT));
	fs.writeFileSync(path.join(dir, "legacy.txt"), CP1251);
	fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00, 0x7f, 0x13]));

	async function text(tool: AgentTool<any>, params: unknown): Promise<string> {
		const r = await tool.execute!("c", params);
		return (r.content[0] as { text: string }).text;
	}

	it("read decodes a UTF-16 LE file to clean text (no NULs)", async () => {
		const out = await text(readTool, { path: path.join(dir, "ps-output.txt") });
		assert.match(out, /adapters up: Беспроводная сеть/);
		assert.ok(!out.includes("\u0000"));
	});

	it("read decodes Windows-1251", async () => {
		assert.match(await text(readTool, { path: path.join(dir, "legacy.txt") }), /Привет, мир/);
	});

	it("grep no longer skips UTF-16 files as binary — and finds Cyrillic in them", async () => {
		assert.equal(await isBinaryFile(path.join(dir, "ps-output.txt")), false);
		assert.equal(await isBinaryFile(path.join(dir, "blob.bin")), true, "real binaries are still skipped");
		const out = await text(grepTool, { path: dir, pattern: "Беспроводная" });
		assert.match(out, /ps-output\.txt/);
	});
});
