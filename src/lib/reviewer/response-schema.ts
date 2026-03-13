import { z } from "zod";

export const reviewerResponseSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      category: z.string(),
      title: z.string(),
      description: z.string(),
      filePath: z.string().optional(),
      lineStart: z.number().int().optional(),
      lineEnd: z.number().int().optional(),
      evidence: z.string().optional(),
      recommendation: z.string(),
      confidence: z.number().min(0).max(1),
    })
  ),
  summary: z.string(),
});

export type ReviewerResponse = z.infer<typeof reviewerResponseSchema>;
