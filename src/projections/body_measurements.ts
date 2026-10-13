import type { BodyMeasurementsOutT } from "../schemas/body.js";
import { asArray, asNumber, asString, isObject } from "../lib/walk.js";

// GET /progression-service/v3/trends/WEIGHT/readings (BODY_COMPOSITION/readings
// returns the same records): sections.records[] is one entry per month, each
// with measurements[].content{id, weight, source, weight_details_screen{
// timestamp, weight_kg, body_fat_percent, lean_body_mass_kg, source}}.
// body_fat_percent is a fraction on the wire (0.185 = 18.5%).

export const BODY_READINGS_PATH = "/progression-service/v3/trends/WEIGHT/readings";

const round = (n: number, digits: number): number => Number(n.toFixed(digits));

/** Wire fraction (0.185) → percentage for people (18.5). */
export const fatFractionToPercent = (fraction: number): number => round(fraction * 100, 1);

/** Percentage (18.5) → wire fraction (0.185). */
export const fatPercentToFraction = (percent: number): number => round(percent / 100, 4);

export function projectBodyMeasurements(raw: unknown): BodyMeasurementsOutT {
  const sections = isObject(raw) && isObject(raw.sections) ? raw.sections : {};
  const readings: BodyMeasurementsOutT["readings"] = [];
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
      readings.push({
        id,
        timestamp,
        weight_kg: round(weight, 2),
        body_fat_percent: fat === null ? null : fatFractionToPercent(fat),
        lean_body_mass_kg: lean === null ? null : round(lean, 2),
        source: asString(details?.source ?? content?.source),
      });
    }
  }
  return { readings, next_token: asString(sections.next_token) };
}
