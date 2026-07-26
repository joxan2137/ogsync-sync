// File paths coming from a model are untrusted: everything the rbxm/asset tools
// touch must stay inside the working directory.

import { isAbsolute, relative, resolve } from "node:path";
import { badArg } from "./fmt.ts";

export function resolveInCwd(file: string, extensions?: readonly string[]): string {
  const root = process.cwd();
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw badArg(`file escapes the working directory: ${file}`);
  }
  if (extensions && !extensions.some((ext) => abs.toLowerCase().endsWith(ext))) {
    throw badArg(`file must end in ${extensions.join(" or ")}: ${file}`);
  }
  return abs;
}

export const RBXM_EXTENSIONS = [".rbxm", ".rbxmx"] as const;
