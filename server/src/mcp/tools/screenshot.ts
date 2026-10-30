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
  scale?: number;
  viewport?: { w: number; h: number };
  inset?: { x: number; y: number };
  warnings?: string[];
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
    const data = (await bridge.call(
      "shot.capture",
      {
        target: "viewport",
        context,
        player: args.player,
        frame: args.frame ?? args.camera_focus,
        hide_ui: args.hide_ui,
        size: args.size ?? "960x540",
        capture_timeout_ms: args.capture_timeout_ms,
      },
      callOpts(args, LONG_TIMEOUT_MS, args.player === undefined ? undefined : { player: args.player }),
    )) as ShotResult;

    if (!data.rgba || !data.w || !data.h) throw badArg("plugin returned no pixels");
    const png = encodePng(data.w, data.h, Buffer.from(data.rgba, "base64"));
    const head = row(`${context} ${data.w}x${data.h} png ${png.length}B`, {
      viewport: data.viewport && `${Math.round(data.viewport.w)}x${Math.round(data.viewport.h)}`,
      scale: data.scale === undefined ? undefined : Math.round(data.scale * 1000) / 1000,
      inset: data.inset && `${data.inset.x},${data.inset.y}`,
      restored: visual.restored || undefined,
    });
    const notes = [...visual.warnings, ...(data.warnings ?? [])].map((w) => `warn: ${w}`);
    return {
      content: [
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: lines(head, notes) },
      ],
    };
  },
});
