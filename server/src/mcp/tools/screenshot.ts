import { z } from "zod";
import { BridgeError } from "@proto/types";
import { checkVisual } from "../../window/visual.ts";
import { badArg, lines, row } from "../fmt.ts";
import { encodePng } from "../png.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface ShotResult {
  w?: number;
  h?: number;
  rgba?: string;
  contentId?: string;
  scale?: number;
  viewport?: { w: number; h: number };
  inset?: { x: number; y: number };
  warnings?: string[];
}

/** Channel values at or below this count as black (encoder noise). */
const BLACK_LEVEL = 8;

/** True when no pixel has any colour: the capture missed the renderer. */
export function isBlackFrame(rgba: Buffer): boolean {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i]! > BLACK_LEVEL || rgba[i + 1]! > BLACK_LEVEL || rgba[i + 2]! > BLACK_LEVEL) return false;
  }
  return true;
}

export const tool = defineTool({
  name: "screenshot",
  description:
    "Capture a Studio viewport as a PNG (context=client during a playtest; edit by default): frame=<path> points the camera at an instance and hide_ui hides ScreenGuis, both always undone after the capture, and size is `WxH` (default 960x540). The result states scale (image px per input px), refuses fast when Studio cannot paint (minimized, covered, locked; restore=true un-minimizes without taking focus), and warns about fullscreen opaque GUIs and AlwaysOnTop billboards the capture can miss.",
  schema: {
    context: z.enum(["edit", "server", "client"]).optional(),
    player: z.union([z.string(), z.number()]).optional(),
    frame: z.string().optional(),
    camera_focus: z.string().optional(),
    hide_ui: z.boolean().optional(),
    restore: z.boolean().optional(),
    size: z.string().regex(/^\d+x\d+$/).optional(),
    capture_timeout_ms: z.number().int().min(500).max(30_000).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const visual = await checkVisual(bridge.bound()?.placeName, { restore: args.restore });
    if (!visual.ok) throw new BridgeError("STUDIO", `screenshot refused: ${visual.reason}`);

    const context = args.context ?? "edit";
    const size = args.size ?? "960x540";
    const opts = callOpts(args, LONG_TIMEOUT_MS, args.player === undefined ? undefined : { player: args.player });
    // A play DataModel can capture but not read its capture back into pixels;
    // the edit DataModel can read a content id captured anywhere in Studio.
    const twoStep = context !== "edit";
    let data = (await bridge.call(
      "shot.capture",
      {
        target: "viewport",
        context,
        player: args.player,
        frame: args.frame ?? args.camera_focus,
        hide_ui: args.hide_ui,
        size,
        capture_timeout_ms: args.capture_timeout_ms,
        content_only: twoStep,
      },
      opts,
    )) as ShotResult;
    if (twoStep) {
      if (!data.contentId) throw badArg("play-context capture returned no content id");
      const pixels = (await bridge.call("shot.read", { contentId: data.contentId, size }, callOpts(args, LONG_TIMEOUT_MS))) as ShotResult;
      const scale = data.viewport?.w ? (pixels.w ?? 0) / data.viewport.w : undefined;
      data = { ...data, ...pixels, scale };
    }

    if (!data.rgba || !data.w || !data.h) throw badArg("plugin returned no pixels");
    const rgba = Buffer.from(data.rgba, "base64");
    const png = encodePng(data.w, data.h, rgba);
    const head = row(`${context} ${data.w}x${data.h} png ${png.length}B`, {
      viewport: data.viewport && `${Math.round(data.viewport.w)}x${Math.round(data.viewport.h)}`,
      scale: data.scale === undefined ? undefined : Math.round(data.scale * 1000) / 1000,
      inset: data.inset && `${data.inset.x},${data.inset.y}`,
      restored: visual.restored || undefined,
    });
    const black = isBlackFrame(rgba)
      ? ["capture is a fully black frame: CaptureService missed the renderer (seen with some renderers during playtests)"]
      : [];
    const notes = [...visual.warnings, ...(data.warnings ?? []), ...black].map((w) => `warn: ${w}`);
    return {
      content: [
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: lines(head, notes) },
      ],
    };
  },
});
