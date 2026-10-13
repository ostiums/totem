import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { BodyMeasurementDeleteOut, BodyMeasurementLogOut, BodyMeasurementsOut } from "../../schemas/body.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopApiError, WhoopProjectionError, apiErrorDetail } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { toLocalIso } from "../../lib/timezone.js";
import { asArray, asNumber, asString, isObject } from "../../lib/walk.js";

// Weight + body composition readings behind Trends → Weight / Lean Body Mass.
// Found in the Android app (TrendsApi): POST adds, DELETE /{id} removes, and
// GET /trends/{graphKey}/readings lists every reading (WEIGHT and
// BODY_COMPOSITION return the same records).
const PATH = "/progression-service/v3/trends/WEIGHT/readings";

const round = (n: number, digits: number): number => Number(n.toFixed(digits));

/**
 * ISO-8601 with offset → the app's Joda pattern `yyyy-MM-dd'T'HH:mm:ss.SSSZ`
 * ("2026-10-13T09:30:00.000+0300"). The wall clock and offset are kept as given.
 */
export function jodaTimestamp(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) throw new Error(`Invalid timestamp "${iso}"; expected an ISO-8601 datetime with an offset.`);
  const [, minute, sec = "00", frac = "", zone] = m;
  const ms = frac.padEnd(3, "0").slice(0, 3);
  const offset = zone === "Z" ? "+0000" : zone!.replace(":", "");
  return `${minute}:${sec}.${ms}${offset}`;
}

export interface MeasurementInput {
  timestamp: string;
  weight_kg: number;
  /** Percentage, e.g. 18.5. */
  body_fat_percent?: number | undefined;
  lean_body_mass_kg?: number | undefined;
}

export interface MeasurementBody {
  timestamp: string;
  weight_kg: number;
  /** Fraction, e.g. 0.185 — the unit Whoop stores and returns. */
  body_fat_percent: number | null;
  lean_body_mass_kg: number | null;
}

/**
 * Build the request body the app sends. Given only one of body fat / lean mass,
 * the other is derived from weight (lean = weight × (1 − fat)) so the reading
 * is complete, as it is when the app imports one from a scale.
 */
export function buildMeasurementBody(input: MeasurementInput): MeasurementBody {
  const { weight_kg: weight, body_fat_percent: fatPct, lean_body_mass_kg: lean } = input;
  const timestamp = jodaTimestamp(input.timestamp);
  if (lean !== undefined && lean >= weight) {
    throw new Error(`Lean body mass (${lean} kg) must be below body weight (${weight} kg).`);
  }
  if (fatPct !== undefined && lean !== undefined) {
    const expectedLean = weight * (1 - fatPct / 100);
    if (Math.abs(expectedLean - lean) > 0.5) {
      throw new Error(`Body fat ${fatPct}% and lean mass ${lean} kg disagree for ${weight} kg (expected lean ≈ ${round(expectedLean, 1)} kg). Pass one of them.`);
    }
    return { timestamp, weight_kg: weight, body_fat_percent: round(fatPct / 100, 4), lean_body_mass_kg: lean };
  }
  if (fatPct !== undefined) {
    return { timestamp, weight_kg: weight, body_fat_percent: round(fatPct / 100, 4), lean_body_mass_kg: round(weight * (1 - fatPct / 100), 2) };
  }
  if (lean !== undefined) {
    return { timestamp, weight_kg: weight, body_fat_percent: round(1 - lean / weight, 4), lean_body_mass_kg: lean };
  }
  return { timestamp, weight_kg: weight, body_fat_percent: null, lean_body_mass_kg: null };
}

export interface BodyReadingT {
  id: string;
  timestamp: string;
  weight_kg: number;
  body_fat_percent: number | null;
  lean_body_mass_kg: number | null;
  source: string | null;
}

/** sections.records[].measurements[].content → flat readings, newest first (as served). */
export function projectReadings(raw: unknown): BodyReadingT[] {
  const sections = isObject(raw) && isObject(raw.sections) ? raw.sections : {};
  const out: BodyReadingT[] = [];
  for (const month of asArray(sections.records)) {
    for (const m of asArray(isObject(month) ? month.measurements : null)) {
      const content = isObject(m) && isObject(m.content) ? m.content : null;
      const details = content && isObject(content.weight_details_screen) ? content.weight_details_screen : null;
      const id = content ? asString(content.id) : null;
      const timestamp = details ? asString(details.timestamp) : null;
      const weight = asNumber(details?.weight_kg ?? content?.weight);
      if (!id || !timestamp || weight === null) continue;
      const fat = asNumber(details?.body_fat_percent);
      const lean = asNumber(details?.lean_body_mass_kg);
      out.push({
        id,
        timestamp,
        weight_kg: round(weight, 2),
        body_fat_percent: fat === null ? null : round(fat * 100, 1),
        lean_body_mass_kg: lean === null ? null : round(lean, 2),
        source: asString(details?.source ?? content?.source),
      });
    }
  }
  return out;
}

function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: jsonOut({ error: message }) }], isError: true };
}

export function registerBodyMeasurements(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_body_measurements",
    "Every recorded weight / body-composition reading (manual, Apple Health, Withings…): id, timestamp, weight kg, body fat %, lean body mass kg, source. Use the id with whoop_body_measurement_delete.",
    {},
    async () => {
      const projected = { readings: projectReadings(await client.get(PATH)) };
      try {
        const out = BodyMeasurementsOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_body_measurements", e);
        throw e;
      }
    },
  );
}

export function registerBodyMeasurementLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_body_measurement_log",
    "WRITE: add a weight reading to the Weight and Lean Body Mass trends, optionally with body fat % or lean body mass kg (the other is derived from weight). This is the trend reading the app's ADD MANUAL MEASUREMENT saves; the profile weight used for calorie math is separate (whoop_profile_update). Preview unless confirm:true.",
    {
      weight_kg: z.number().positive().describe("Body weight in kilograms."),
      lean_body_mass_kg: z.number().positive().optional().describe("Lean body mass in kilograms."),
      body_fat_percent: z.number().gt(0).lt(100).optional().describe("Body fat as a percentage, e.g. 18.5."),
      timestamp: z.iso.datetime({ offset: true }).optional().describe("When it was measured, ISO-8601 with offset. Defaults to now."),
      confirm: z.boolean().default(false),
    },
    async ({ weight_kg, lean_body_mass_kg, body_fat_percent, timestamp, confirm }) => {
      let body: MeasurementBody;
      try {
        body = buildMeasurementBody({
          timestamp: timestamp ?? toLocalIso(new Date().toISOString()),
          weight_kg,
          lean_body_mass_kg,
          body_fat_percent,
        });
      } catch (e) {
        return errorResult((e as Error).message);
      }
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview("POST", PATH, body)) }] };
      }
      try {
        await client.post(PATH, body);
      } catch (error) {
        if (error instanceof WhoopApiError) {
          return {
            content: [{ type: "text", text: jsonOut({
              error: "WHOOP rejected the measurement.",
              status: error.status,
              endpoint: PATH,
              reason: apiErrorDetail(error.body) ?? null,
            }) }],
            isError: true,
          };
        }
        throw error;
      }
      const out = BodyMeasurementLogOut.parse({
        logged: true as const,
        timestamp: body.timestamp,
        weight_kg: body.weight_kg,
        body_fat_percent: body.body_fat_percent === null ? null : round(body.body_fat_percent * 100, 1),
        lean_body_mass_kg: body.lean_body_mass_kg,
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}

export function registerBodyMeasurementDelete(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_body_measurement_delete",
    "WRITE / DESTRUCTIVE: delete one weight / body-composition reading by id (from whoop_body_measurements). Preview unless confirm:true.",
    {
      reading_id: z.string().min(1),
      confirm: z.boolean().default(false),
    },
    async ({ reading_id, confirm }) => {
      const path = `${PATH}/${encodeURIComponent(reading_id)}`;
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview("DELETE", path, { reading_id })) }] };
      }
      await client.delete(path);
      const out = BodyMeasurementDeleteOut.parse({ deleted: true as const, reading_id });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
