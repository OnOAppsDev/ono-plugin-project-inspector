/**
 * markdown-text.ts — line-ending handling for Inspector Markdown (0.14.0).
 *
 * Git for Windows checks text files out with CRLF line endings when `core.autocrlf=true`
 * (its default), while the committed blobs — and every macOS / Linux checkout — keep LF.
 * The same committed document therefore reaches the helpers as two different strings.
 *
 * The rule, narrowly scoped:
 *   - PARSING and SEMANTIC COMPARISON of Inspector Markdown use `toLf()`: every CRLF pair
 *     becomes LF. A lone CR is left alone (out of scope), and nothing else changes.
 *   - WRITING never uses the normalized text: documents are edited by splicing into the
 *     original string, so bytes outside the intended edit — including each line's own
 *     ending, a UTF-8 BOM and the final newline — are preserved.
 *   - Git path output, protocol tokens, JSON and binary data are never passed through here.
 *
 * Canonical Markdown hash (`sha256-lf`): SHA-256 of the UTF-8 text with CRLF pairs
 * normalized to LF. For a document stored with LF (the usual case) it equals the hash of
 * its raw bytes — and of its Git blob — so every hash ever computed from an LF file is
 * unchanged, and a CRLF checkout of the same content hashes identically.
 */

import { createHash } from "crypto";

export const UTF8_BOM = "﻿";

/** The canonical artifact / body hash algorithm name (repo-knowledge `fingerprint.artifactHash`). */
export const CANONICAL_HASH = "sha256-lf";

/** CRLF pairs -> LF, for parsing and comparison only. Never written back to a document. */
export function toLf(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
}

/** Text to parse: LF line endings and no leading BOM (a BOM is never part of a heading). */
export function forParsing(text: string): string {
  const lf = toLf(text);
  return lf.startsWith(UTF8_BOM) ? lf.slice(1) : lf;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** The canonical (`sha256-lf`) hash of Markdown text. */
export function canonicalSha256(text: string): string {
  return sha256Text(toLf(text));
}

/** The line ending that terminates `line` (an element of `text.split("\n")`): "\r" when it is CRLF, else "". */
export const crOf = (line: string | undefined): "\r" | "" => (line !== undefined && line.endsWith("\r") ? "\r" : "");
