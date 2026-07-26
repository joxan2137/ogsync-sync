import { describe, expect, test } from "bun:test";
import { type ApiDump, queryApiDump } from "./robloxdocs.ts";

// Trimmed shape of setup.rbxcdn.com/<guid>-API-Dump.json.
const DUMP: ApiDump = JSON.parse(`{
  "Classes": [
    {
      "Name": "Instance",
      "Superclass": "Object",
      "Members": [
        {
          "Name": "Name",
          "MemberType": "Property",
          "Security": { "Read": "None", "Write": "None" },
          "Serialization": { "CanLoad": true, "CanSave": true },
          "ValueType": { "Category": "Primitive", "Name": "string" }
        },
        {
          "Name": "Destroy",
          "MemberType": "Function",
          "Parameters": [],
          "ReturnType": { "Category": "Primitive", "Name": "void" },
          "Security": "None"
        }
      ]
    },
    {
      "Name": "Object",
      "Members": [
        {
          "Name": "ClassName",
          "MemberType": "Property",
          "Security": { "Read": "None", "Write": "None" },
          "Tags": ["ReadOnly", "NotReplicated"],
          "Serialization": { "CanLoad": false, "CanSave": false },
          "ValueType": { "Category": "Primitive", "Name": "string" }
        }
      ]
    },
    {
      "Name": "Humanoid",
      "Superclass": "Instance",
      "Tags": ["NotCreatable"],
      "Members": [
        {
          "Name": "WalkSpeed",
          "MemberType": "Property",
          "Security": { "Read": "None", "Write": "None" },
          "Serialization": { "CanLoad": true, "CanSave": true },
          "ValueType": { "Category": "Primitive", "Name": "float" }
        },
        {
          "Name": "InternalSpeed",
          "MemberType": "Property",
          "Security": { "Read": "None", "Write": "PluginSecurity" },
          "Serialization": { "CanLoad": false, "CanSave": false },
          "ValueType": { "Category": "Primitive", "Name": "float" }
        },
        {
          "Name": "MoveTo",
          "MemberType": "Function",
          "Parameters": [
            { "Name": "location", "Type": { "Category": "DataType", "Name": "Vector3" } },
            {
              "Name": "part",
              "Type": { "Category": "Class", "Name": "BasePart" },
              "Default": "nil"
            }
          ],
          "ReturnType": { "Category": "Primitive", "Name": "void" },
          "Security": "None"
        },
        {
          "Name": "Died",
          "MemberType": "Event",
          "Parameters": [],
          "Security": "None"
        }
      ]
    }
  ]
}`);

describe("queryApiDump class mode", () => {
  const out = queryApiDump(DUMP, "humanoid");

  test("headers the class with superclass and tags", () => {
    expect(out.split("\n")[0]).toBe("Humanoid : Instance  [NotCreatable]");
  });

  test("renders one member per line with signatures", () => {
    expect(out).toContain("func MoveTo(location: Vector3, part: BasePart = nil): void");
    expect(out).toContain("event Died()");
    expect(out).toContain("prop WalkSpeed: float");
  });

  test("flags security and non-serializable properties", () => {
    expect(out).toContain("prop InternalSpeed: float  [sec=r:None/w:PluginSecurity nosave]");
  });

  test("lists the inheritance chain once", () => {
    expect(out).toContain("inherits: Instance < Object");
  });
});

describe("queryApiDump member mode", () => {
  test("returns just the requested member", () => {
    expect(queryApiDump(DUMP, "Humanoid.WalkSpeed")).toBe("Humanoid.prop WalkSpeed: float");
  });

  test("resolves inherited members and names the owner", () => {
    expect(queryApiDump(DUMP, "Humanoid.ClassName")).toBe(
      "Humanoid.prop ClassName: string  [ReadOnly NotReplicated nosave] (from Object)",
    );
  });

  test("falls back to search when the member is unknown", () => {
    expect(queryApiDump(DUMP, "Humanoid.Nope")).toContain("no api match");
  });
});

describe("queryApiDump free text", () => {
  test("ranks exact class hits above substring member hits", () => {
    const hits = queryApiDump(DUMP, "speed").split("\n");
    expect(hits[0]).toBe("Humanoid.prop WalkSpeed: float");
    expect(hits).toContain("Humanoid.prop InternalSpeed: float");
  });

  test("finds classes by name", () => {
    expect(queryApiDump(DUMP, "human").split("\n")[0]).toBe("Humanoid (class)");
  });

  test("reports no match", () => {
    expect(queryApiDump(DUMP, "zzzzq")).toBe('no api match for "zzzzq"');
  });
});

describe("queryApiDump guide mode", () => {
  test("links the class page with a member anchor", () => {
    expect(queryApiDump(DUMP, "Humanoid.WalkSpeed", "guide")).toBe(
      "Humanoid : Instance\nhttps://create.roblox.com/docs/reference/engine/classes/Humanoid#WalkSpeed",
    );
  });

  test("falls back to doc search for unknown classes", () => {
    expect(queryApiDump(DUMP, "pathfinding tutorial", "guide")).toBe(
      "https://create.roblox.com/docs/search#q=pathfinding%20tutorial",
    );
  });
});
