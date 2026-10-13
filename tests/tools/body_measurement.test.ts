import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import {
  buildMeasurementBody,
  jodaTimestamp,
  projectReadings,
  registerBodyMeasurementLog,
  registerBodyMeasurementDelete,
  registerBodyMeasurements,
} from "../../src/tools/v2/body_measurement.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

function json(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("jodaTimestamp", () => {
  it("keeps the wall clock and offset in the app's yyyy-MM-dd'T'HH:mm:ss.SSSZ form", () => {
    expect(jodaTimestamp("2026-10-13T09:30:00+03:00")).toBe("2026-10-13T09:30:00.000+0300");
    expect(jodaTimestamp("2026-10-13T09:30:00.25-07:00")).toBe("2026-10-13T09:30:00.250-0700");
  });

  it("renders UTC as +0000", () => {
    expect(jodaTimestamp("2026-10-13T06:30:00Z")).toBe("2026-10-13T06:30:00.000+0000");
  });
});

describe("buildMeasurementBody", () => {
  const ts = "2026-10-13T09:30:00+03:00";

  it("sends weight alone with null body composition", () => {
    expect(buildMeasurementBody({ timestamp: ts, weight_kg: 80.5 })).toEqual({
      timestamp: "2026-10-13T09:30:00.000+0300",
      weight_kg: 80.5,
      body_fat_percent: null,
      lean_body_mass_kg: null,
    });
  });

  it("derives body fat (as a fraction) from lean body mass", () => {
    const body = buildMeasurementBody({ timestamp: ts, weight_kg: 80, lean_body_mass_kg: 64 });
    expect(body.lean_body_mass_kg).toBe(64);
    expect(body.body_fat_percent).toBeCloseTo(0.2, 10);
  });

  it("converts a body-fat percentage to the wire fraction and derives lean mass", () => {
    const body = buildMeasurementBody({ timestamp: ts, weight_kg: 80, body_fat_percent: 18.5 });
    expect(body.body_fat_percent).toBeCloseTo(0.185, 10);
    expect(body.lean_body_mass_kg).toBeCloseTo(65.2, 10);
  });

  it("rejects lean mass that is not below body weight", () => {
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 70, lean_body_mass_kg: 70 })).toThrow(/lean/i);
  });

  it("rejects body fat and lean mass that disagree", () => {
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 80, body_fat_percent: 18.5, lean_body_mass_kg: 70 })).toThrow(/disagree/i);
  });
});

const READINGS = {
  sections: {
    records: [
      {
        title: "Oct 2026",
        measurements: [
          {
            type: "MEASUREMENT_BOX",
            content: {
              id: "reading-1",
              weight: 80.69999694824219,
              source: "apple_health_kit",
              weight_details_screen: {
                timestamp: "2026-10-04T11:10:00.000+03:00",
                weight_kg: 80.69999694824219,
                body_fat_percent: 0.18500000236350522,
                lean_body_mass_kg: 65.77050018310547,
                source: "apple_health_kit",
              },
            },
          },
        ],
      },
      {
        title: "Aug 2026",
        measurements: [
          {
            type: "MEASUREMENT_BOX",
            content: {
              id: "reading-2",
              weight: 77,
              source: "manual",
              weight_details_screen: {
                timestamp: "2026-08-01T09:27:14.000+03:00",
                weight_kg: 77,
                body_fat_percent: null,
                lean_body_mass_kg: null,
                source: "manual",
              },
            },
          },
        ],
      },
    ],
    next_token: null,
  },
};

describe("projectReadings", () => {
  it("flattens month sections into readings with body fat as a rounded percentage", () => {
    expect(projectReadings(READINGS)).toEqual([
      { id: "reading-1", timestamp: "2026-10-04T11:10:00.000+03:00", weight_kg: 80.7, body_fat_percent: 18.5, lean_body_mass_kg: 65.77, source: "apple_health_kit" },
      { id: "reading-2", timestamp: "2026-08-01T09:27:14.000+03:00", weight_kg: 77, body_fat_percent: null, lean_body_mass_kg: null, source: "manual" },
    ]);
  });

  it("returns an empty list when the shape is absent", () => {
    expect(projectReadings({})).toEqual([]);
    expect(projectReadings(null)).toEqual([]);
  });
});

describe("body measurement tools through MCP", () => {
  it("previews without posting, then posts the app's body on confirm", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementLog(server, whoop));
    const args = { timestamp: "2026-10-13T09:30:00+03:00", weight_kg: 80, lean_body_mass_kg: 64 };

    const preview = json(await client.callTool({ name: "whoop_body_measurement_log", arguments: args }));
    expect(preview.preview).toBe(true);
    expect(post).not.toHaveBeenCalled();

    const result = await client.callTool({ name: "whoop_body_measurement_log", arguments: { ...args, confirm: true } });
    expect(result.isError).toBeFalsy();
    expect(post).toHaveBeenCalledWith("/progression-service/v3/trends/WEIGHT/readings", {
      timestamp: "2026-10-13T09:30:00.000+0300",
      weight_kg: 80,
      body_fat_percent: expect.closeTo(0.2, 10),
      lean_body_mass_kg: 64,
    });
    expect(json(result)).toMatchObject({ logged: true, weight_kg: 80, lean_body_mass_kg: 64, body_fat_percent: 20 });
  });

  it("returns a tool error instead of posting an impossible composition", async () => {
    const post = vi.fn();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementLog(server, whoop));
    const result = await client.callTool({
      name: "whoop_body_measurement_log",
      arguments: { timestamp: "2026-10-13T09:30:00+03:00", weight_kg: 60, lean_body_mass_kg: 75, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("lists readings from the WEIGHT readings endpoint", async () => {
    const get = vi.fn().mockResolvedValue(READINGS);
    const whoop = { get } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurements(server, whoop));
    const result = json(await client.callTool({ name: "whoop_body_measurements", arguments: {} }));
    expect(get).toHaveBeenCalledWith("/progression-service/v3/trends/WEIGHT/readings");
    expect((result.readings as unknown[]).length).toBe(2);
  });

  it("deletes a reading by id only on confirm", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const whoop = { delete: del } as unknown as WhoopClient;
    const client = await connect((server) => registerBodyMeasurementDelete(server, whoop));

    await client.callTool({ name: "whoop_body_measurement_delete", arguments: { reading_id: "reading-1" } });
    expect(del).not.toHaveBeenCalled();

    const result = json(await client.callTool({ name: "whoop_body_measurement_delete", arguments: { reading_id: "reading-1", confirm: true } }));
    expect(del).toHaveBeenCalledWith("/progression-service/v3/trends/WEIGHT/readings/reading-1");
    expect(result).toEqual({ deleted: true, reading_id: "reading-1" });
  });
});
