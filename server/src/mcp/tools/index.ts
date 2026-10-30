import type { ToolModule } from "../tool.ts";
import { tool as asset } from "./asset.ts";
import { tool as create } from "./create.ts";
import { tool as remove } from "./delete.ts";
import { tool as docs } from "./docs.ts";
import { tool as duplicate } from "./duplicate.ts";
import { tool as edit } from "./edit.ts";
import { tool as find } from "./find.ts";
import { tool as get } from "./get.ts";
import { tool as grep } from "./grep.ts";
import { tool as history } from "./history.ts";
import { tool as input } from "./input.ts";
import { tool as job } from "./job.ts";
import { tool as logs } from "./logs.ts";
import { tool as playtest } from "./playtest.ts";
import { tool as profile } from "./profile.ts";
import { tool as read } from "./read.ts";
import { tool as rbxm } from "./rbxm.ts";
import { tool as run } from "./run.ts";
import { tool as screenshot } from "./screenshot.ts";
import { tool as set } from "./set.ts";
import { tool as sync } from "./sync.ts";
import { tool as transform } from "./transform.ts";
import { tool as tree } from "./tree.ts";
import { tool as wait } from "./wait.ts";

export const TOOLS: readonly ToolModule[] = [
  run,
  read,
  edit,
  grep,
  tree,
  get,
  set,
  create,
  remove,
  duplicate,
  find,
  playtest,
  logs,
  screenshot,
  profile,
  input,
  asset,
  rbxm,
  docs,
  history,
  sync,
  wait,
  job,
  transform,
];
