import { z } from "zod";
import { IsoDateTime, withPreview } from "./primitives.js";

export const BodyReading = z.object({
  id: z.string(),
  timestamp: IsoDateTime,
  weight_kg: z.number(),
  body_fat_percent: z.number().nullable(),
  lean_body_mass_kg: z.number().nullable(),
  source: z.string().nullable(),
});

export const BodyMeasurementsOut = z.object({
  readings: z.array(BodyReading),
  next_token: z.string().nullable(),
});
export type BodyMeasurementsOutT = z.infer<typeof BodyMeasurementsOut>;

export const BodyMeasurementLogOut = withPreview(z.object({
  logged: z.literal(true),
  timestamp: IsoDateTime,
  weight_kg: z.number(),
  body_fat_percent: z.number().nullable(),
  lean_body_mass_kg: z.number().nullable(),
}));

export const BodyMeasurementDeleteOut = withPreview(z.object({
  deleted: z.literal(true),
  reading_id: z.string(),
}));
