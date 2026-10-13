import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { BodyMeasurementLogOut } from "../../schemas/body.js";
import { BODY_READINGS_PATH } from "../../projections/body_measurements.js";
import { preview, writeRejected } from "../../whoop/write_safety.js";
import { WhoopApiError, WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { jodaTimestamp } from "../../lib/dates.js";
import { fatFractionToPercent, fatPercentToFraction, round } from "../../lib/format.js";
import { toLocalIso } from "../../lib/timezone.js";

interface MeasurementInput {
  timestamp: string;
  weight_kg: number;
  /** Percentage, e.g. 18.5. */
  body_fat_percent?: number | undefined;
  lean_body_mass_kg?: number | undefined;
}

/** The app's ManualMeasurementRequestBody, snake_cased on the wire. */
interface MeasurementBody {
  timestamp: string;
  weight_kg: number;
  /** Fraction, e.g. 0.185 — the unit WHOOP stores and returns. */
  body_fat_percent: number | null;
  lean_body_mass_kg: number | null;
}

/**
 * Build the request body the app sends. Lean mass is weight minus fat mass
 * (WHOOP's own definition), so given one of body fat / lean mass the other
 * follows; given both, they must agree.
 */
export function buildMeasurementBody(input: MeasurementInput): MeasurementBody {
  const { weight_kg: weight, body_fat_percent: fatPct, lean_body_mass_kg: givenLean } = input;
  const timestamp = jodaTimestamp(input.timestamp);
  if (givenLean !== undefined && givenLean >= weight) {
    throw new Error(`Lean body mass (${givenLean} kg) must be below body weight (${weight} kg).`);
  }
  const leanFromFat = fatPct === undefined ? undefined : round(weight * (1 - fatPct / 100), 2);
  if (leanFromFat !== undefined && givenLean !== undefined && Math.abs(leanFromFat - givenLean) > 0.5) {
    throw new Error(`Body fat ${fatPct}% and lean mass ${givenLean} kg disagree for ${weight} kg (expected lean ≈ ${leanFromFat} kg). Pass one of them.`);
  }
  const lean = givenLean ?? leanFromFat ?? null;
  const fat = fatPct !== undefined ? fatPercentToFraction(fatPct)
    : lean !== null ? round(1 - lean / weight, 4)
    : null;
  return { timestamp, weight_kg: weight, body_fat_percent: fat, lean_body_mass_kg: lean };
}

export function registerBodyMeasurementLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_body_measurement_log",
    "WRITE: add a reading to the Weight and Lean Body Mass trends — weight, plus body fat % or lean body mass (other derived). Kilograms only. Separate from the profile weight (whoop_profile_update). The app keeps one reading per day, so a same-day reading may be replaced — check whoop_body_measurements first. Preview unless confirm:true.",
    {
      weight_kg: z.number().positive().describe("Body weight in kilograms."),
      lean_body_mass_kg: z.number().positive().optional().describe("Lean body mass in kilograms."),
      body_fat_percent: z.number().gt(0).lt(100).optional().describe("Body fat as a percentage, e.g. 18.5."),
      timestamp: z.iso.datetime({ offset: true }).optional().describe("When it was measured, ISO-8601 with offset. Defaults to now; sent in your local offset."),
      confirm: z.boolean().default(false),
    },
    async ({ weight_kg, lean_body_mass_kg, body_fat_percent, timestamp, confirm }) => {
      let body: MeasurementBody;
      try {
        body = buildMeasurementBody({
          // The app sends local wall-clock time with its offset; toLocalIso leaves non-UTC input as given.
          timestamp: toLocalIso(timestamp ?? new Date().toISOString()),
          weight_kg,
          lean_body_mass_kg,
          body_fat_percent,
        });
      } catch (e) {
        return { content: [{ type: "text", text: jsonOut({ error: (e as Error).message }) }], isError: true };
      }
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview("POST", BODY_READINGS_PATH, body)) }] };
      }
      try {
        await client.post(BODY_READINGS_PATH, body);
      } catch (error) {
        if (error instanceof WhoopApiError) return writeRejected("measurement", BODY_READINGS_PATH, error);
        throw error;
      }
      try {
        const out = BodyMeasurementLogOut.parse({
          logged: true,
          timestamp: body.timestamp,
          weight_kg: body.weight_kg,
          body_fat_percent: body.body_fat_percent === null ? null : fatFractionToPercent(body.body_fat_percent),
          lean_body_mass_kg: body.lean_body_mass_kg,
        });
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_body_measurement_log", e);
        throw e;
      }
    },
  );
}
