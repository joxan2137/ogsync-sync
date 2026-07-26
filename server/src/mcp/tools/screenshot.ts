import { z } from "zod";
import { badArg } from "../fmt.ts";
import { encodePng } from "../png.ts";
import { callOpts, defineTool, LONG_TIMEOUT_MS, TIMEOUT_ARG } from "../tool.ts";

interface ShotResult {
  w?: number;
  h?: number;
  rgba?: string;
}

export const tool = defineTool({
  name: "screenshot",
  description:
    "Capture the Studio viewport as a PNG image. camera_focus frames an instance path first; size is `WxH` (default 960x540).",
  schema: {
    target: z.enum(["viewport"]).optional(),
    camera_focus: z.string().optional(),
    size: z.string().regex(/^\d+x\d+$/).optional(),
    timeout_ms: TIMEOUT_ARG,
  },
  async handler(bridge, _deps, args) {
    const data = (await bridge.call(
      "shot.capture",
      {
        target: args.target ?? "viewport",
        camera_focus: args.camera_focus,
        size: args.size ?? "960x540",
      },
      callOpts(args, LONG_TIMEOUT_MS),
    )) as ShotResult;

    if (!data.rgba || !data.w || !data.h) throw badArg("plugin returned no pixels");
    const png = encodePng(data.w, data.h, Buffer.from(data.rgba, "base64"));
    return {
      content: [
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: `viewport ${data.w}x${data.h} png ${png.length}B` },
      ],
    };
  },
});
