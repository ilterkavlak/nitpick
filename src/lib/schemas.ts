import { z } from "zod";

export const prUrlSchema = z
  .string()
  .url()
  .regex(
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/,
    "Must be a valid GitHub PR URL"
  );

export const createArenaSchema = z.object({
  prUrl: prUrlSchema,
  selectedRoles: z
    .array(z.enum(["security", "performance", "architecture", "testing", "dx"]))
    .min(1, "Select at least one reviewer"),
});

export type CreateArenaInput = z.infer<typeof createArenaSchema>;

export const workerPayloadSchema = z.object({
  arenaId: z.string(),
  role: z.enum(["security", "performance", "architecture", "testing", "dx"]),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int().positive(),
  baseSha: z.string(),
  headSha: z.string(),
});
