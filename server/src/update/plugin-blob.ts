// Build-time seam, GENERATED: scripts/embed-plugin.ts overwrites this file with
// a module that imports dist/OGSync.rbxm via `with { type: "file" }` and returns
// its bytes. This stub keeps dev runs and `tsc --noEmit` working before the
// plugin has been built.
//
// Contract for the generator: keep this exact signature. Resolve to the plugin
// .rbxm bytes, or null when the binary was built without an embedded plugin —
// callers treat null as "nothing to install" and never as an error.

export async function getPluginBytes(): Promise<Uint8Array | null> {
  return null;
}
