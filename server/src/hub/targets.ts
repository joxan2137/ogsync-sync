// Target grammar shared by every tool, the CLI and ogsync.toml:
//
//   <place>[:<role>]   place = alias, place key, placeId or place name
//                      role  = edit | server | client | client-N
//
// Resolution never guesses: no target with several places connected, or a
// target matching more than one, is an explicit TARGET error listing the
// candidates.

import { BridgeError } from "../proto/types.ts";

export type TargetRole = "edit" | "server" | "client" | `client-${number}`;

export interface TargetSpec {
  place: string | null;
  role: TargetRole | null;
}

export interface PlaceIdentity {
  key: string;
  name: string;
  placeId: number;
}

const ROLE_PATTERN = /^(edit|server|client(?:-[1-9]\d*)?)$/;

export function parseTarget(raw: string | number | null | undefined): TargetSpec {
  if (raw === null || raw === undefined) return { place: null, role: null };
  const text = String(raw).trim();
  if (text === "") return { place: null, role: null };
  const colon = text.lastIndexOf(":");
  if (colon !== -1) {
    const role = text.slice(colon + 1).trim().toLowerCase();
    if (ROLE_PATTERN.test(role)) {
      const place = text.slice(0, colon).trim();
      return { place: place === "" ? null : place, role: role as TargetRole };
    }
  }
  if (ROLE_PATTERN.test(text.toLowerCase())) return { place: null, role: text.toLowerCase() as TargetRole };
  return { place: text, role: null };
}

export function formatTarget(spec: TargetSpec): string {
  return [spec.place ?? "", spec.role ? `:${spec.role}` : ""].join("") || "(none)";
}

/** Play/Run DataModels rename themselves ("Name @ 02 Aug 2026 15:49"); strip that and case. */
export function normalizePlaceName(name: string): string {
  return name.replace(/ @ .*$/, "").trim().toLowerCase();
}

/**
 * placeId is the only key stable across edit and play DataModels; unsaved
 * places (placeId 0) fall back to the normalized name.
 */
export function basePlaceKey(place: { placeId: number; placeName: string }): string {
  if (place.placeId > 0) return String(place.placeId);
  return normalizePlaceName(place.placeName);
}

export function describePlace(place: PlaceIdentity): string {
  return place.key === normalizePlaceName(place.name) ? place.key : `${place.key} (${place.name})`;
}

/** Throws BridgeError TARGET/NOPLUGIN; never falls back to "first connected". */
export function resolvePlace(
  spec: TargetSpec,
  places: readonly PlaceIdentity[],
  aliases: Readonly<Record<string, string>> = {},
): PlaceIdentity {
  if (spec.place === null) {
    if (places.length === 1) return places[0]!;
    if (places.length === 0) {
      throw new BridgeError("NOPLUGIN", "no Studio place connected; open it with the OGSync plugin enabled");
    }
    throw new BridgeError(
      "TARGET",
      `${places.length} places connected and no target given; pass target=<${candidates(places)}> or set bind.target_place in ogsync.toml`,
    );
  }
  const wanted = aliasFor(spec.place, aliases);
  const matches = places.filter((place) => matchesPlace(place, wanted));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    if (places.length === 0) {
      throw new BridgeError("NOPLUGIN", `no Studio place connected (target '${spec.place}'); open it with the OGSync plugin enabled`);
    }
    throw new BridgeError("TARGET", `no connected place matches target '${spec.place}'; connected: ${candidates(places)}`);
  }
  throw new BridgeError(
    "TARGET",
    `target '${spec.place}' matches ${matches.length} places (${candidates(matches)}); pass one of those keys`,
  );
}

function aliasFor(place: string, aliases: Readonly<Record<string, string>>): string {
  const lowered = place.toLowerCase();
  for (const [name, value] of Object.entries(aliases)) {
    if (name.toLowerCase() === lowered) return value;
  }
  return place;
}

function matchesPlace(place: PlaceIdentity, wanted: string): boolean {
  const lowered = wanted.trim().toLowerCase();
  if (place.key.toLowerCase() === lowered) return true;
  if (place.placeId > 0 && String(place.placeId) === lowered) return true;
  return normalizePlaceName(place.name) === normalizePlaceName(wanted);
}

function candidates(places: readonly PlaceIdentity[]): string {
  return places.map(describePlace).join(" | ");
}
