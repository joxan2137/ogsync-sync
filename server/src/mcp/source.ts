// Script text on the wire: LF-normalized, base64 over its UTF-8 bytes so JSON
// escaping cannot mangle NULs, lone CRs or long brackets, and staged in chunks
// once it outgrows one job. The plugin re-hashes what it decoded and what it
// wrote, so a source that arrives or lands differently fails loudly.

import { contentHash, normalizeSource, type Bridge, type CallOpts } from "@proto/types";

/** Base64 chars per job; a multiple of 4 so chunks split on whole groups. */
export const STAGE_CHUNK_CHARS = 64 * 1024;

export interface WireText {
  /** Fields to merge into the op args under `<field>_b64|_upload|_hash`. */
  fields: Record<string, string>;
  hash: string;
  chunks: number;
}

export function splitChunks(b64: string, size = STAGE_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += size) chunks.push(b64.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

/** Encodes `text` for op field `field`, staging it through script.stage when large. */
export async function wireText(
  bridge: Bridge,
  field: string,
  text: string,
  opts: CallOpts,
): Promise<WireText> {
  const lf = normalizeSource(text);
  const hash = contentHash(lf);
  const b64 = Buffer.from(lf, "utf8").toString("base64");
  if (b64.length <= STAGE_CHUNK_CHARS) {
    return { fields: { [`${field}_b64`]: b64, [`${field}_hash`]: hash }, hash, chunks: 1 };
  }
  const upload = crypto.randomUUID();
  const chunks = splitChunks(b64);
  for (const [i, data] of chunks.entries()) {
    await bridge.call("script.stage", { upload, index: i + 1, total: chunks.length, data }, opts);
  }
  return { fields: { [`${field}_upload`]: upload, [`${field}_hash`]: hash }, hash, chunks: chunks.length };
}
