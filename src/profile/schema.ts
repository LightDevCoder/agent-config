import { z } from "zod";

/**
 * Effort policy: either an abstract policy ('highest-supported', etc.)
 * or an explicit concrete string value matching host capabilities.
 */
export const EffortPolicySchema = z.union([
  z.object({
    policy: z.enum(["highest-supported", "default", "lowest-supported", "custom"]),
  }),
  z.object({
    value: z.string().min(1),
  }),
]);
export type EffortPolicy = z.infer<typeof EffortPolicySchema>;

/**
 * Host scope preventing profile leakage across workspaces or hosts.
 */
export const HostScopeSchema = z.object({
  type: z.enum(["project", "global"]),
  workspace: z.string().min(1),
});
export type HostScope = z.infer<typeof HostScopeSchema>;

/**
 * Host identifier binding.
 */
export const HostBindingSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  provider: z.string().optional(),
  platform: z.string().optional(),
});
export type HostBinding = z.infer<typeof HostBindingSchema>;

/**
 * Tier mapping: user-confirmed model identifier and effort policy.
 * Automatic intelligence guessing or ranking is strictly forbidden.
 */
export const TierMappingSchema = z.object({
  model: z.string().min(1),
  effort: EffortPolicySchema.optional(),
  source: z.literal("user-confirmed"),
});
export type TierMapping = z.infer<typeof TierMappingSchema>;

/**
 * Single-model configuration without artificial tier routing.
 */
export const SingleModelConfigSchema = z.object({
  model: z.string().min(1),
  execution_effort: EffortPolicySchema.optional(),
  review_effort: EffortPolicySchema.optional(),
});
export type SingleModelConfig = z.infer<typeof SingleModelConfigSchema>;

/**
 * Tiers object mapping difficulty levels to user-confirmed tier mappings.
 */
export const TiersSchema = z.object({
  routine: TierMappingSchema,
  standard: TierMappingSchema,
  high: TierMappingSchema,
  review: TierMappingSchema,
});
export type Tiers = z.infer<typeof TiersSchema>;

/**
 * Complete user-confirmed Agent Config profile.
 */
export const ProfileSchema = z
  .object({
    profile_version: z.number().int().min(1).default(1),
    host: HostBindingSchema,
    scope: HostScopeSchema,
    model_mode: z.enum(["single", "multi"]),
    models: z
      .object({
        available: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    single_model: SingleModelConfigSchema.optional(),
    tiers: TiersSchema.optional(),
    capabilities: z
      .object({
        subagents: z.enum(["available", "unavailable", "unknown"]).optional(),
        threads: z.enum(["available", "unavailable", "unknown"]).optional(),
        parallelism: z.enum(["available", "unavailable", "unknown"]).optional(),
        concurrency: z.number().int().min(1).optional(),
      })
      .optional(),
    created_at: z.string().datetime().optional(),
    updated_at: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      if (data.model_mode === "single") {
        return !!data.single_model;
      }
      if (data.model_mode === "multi") {
        return !!data.tiers;
      }
      return false;
    },
    {
      message:
        "Single-model mode requires 'single_model', multi-model mode requires 'tiers'.",
    }
  );
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * AgentProfile is an alias for Profile across host adapter and runtime boundaries.
 */
export type AgentProfile = Profile;
export const AgentProfileSchema = ProfileSchema;

/**
 * Execution topology schema.
 */
export const ExecutionTopologySchema = z.object({
  type: z.enum([
    "single-session",
    "controller-workers",
    "serial-tickets",
    "parallel-workers",
  ]),
  concurrency: z.number().int().min(1),
  fresh_contexts: z.boolean().optional(),
  subagent_contexts: z.boolean().optional(),
});
export type ExecutionTopology = z.infer<typeof ExecutionTopologySchema>;

/**
 * Execution context locator and model/effort configuration.
 */
export const ExecutionContextConfigSchema = z.object({
  model: z.string().min(1),
  effort: z.string().min(1),
  effort_policy: z.string().optional(),
  context: z.string().min(1),
});
export type ExecutionContextConfig = z.infer<typeof ExecutionContextConfigSchema>;

/**
 * Work item execution specification for decomposed task graphs.
 */
export const WorkItemConfigSchema = z.object({
  ticket_id: z.string().min(1),
  difficulty: z.enum(["routine", "moderate", "demanding", "critical"]),
  tier: z.enum(["routine", "standard", "high", "review"]).nullable().optional(),
  model: z.string().min(1),
  effort: z.string().min(1),
  effort_policy: z.string().optional(),
  context: z.string().min(1),
  dependencies: z.array(z.string()).optional(),
  review_strategy: z
    .enum(["controller-review", "self-check", "independent-review"])
    .optional(),
});
export type WorkItemConfig = z.infer<typeof WorkItemConfigSchema>;

/**
 * Review context and model configuration.
 */
export const ExecutionReviewConfigSchema = z.object({
  strategy: z.enum(["controller-review", "self-check", "independent-review"]),
  tier: z.enum(["routine", "standard", "high", "review"]).optional(),
  model: z.string().min(1),
  effort: z.string().min(1),
  effort_policy: z.string().optional(),
  context: z.string().min(1),
});
export type ExecutionReviewConfig = z.infer<typeof ExecutionReviewConfigSchema>;

/**
 * Execution configuration preview snapshot metadata.
 */
export const ExecutionPreviewSchema = z.object({
  preview_id: z.string().min(1),
  created_at: z.string().optional(),
  mutation_targets: z.array(z.string()).optional(),
  diff: z.string(),
});
export type ExecutionPreview = z.infer<typeof ExecutionPreviewSchema>;

/**
 * Canonical execution configuration schema consumed by host adapters.
 */
export const ExecutionConfigSchema = z
  .object({
    task_shape: z.enum(["single-pass", "decomposed"]),
    model_mode: z.enum(["single", "multi"]),
    readiness: z.enum([
      "executable",
      "needs-project-tickets",
      "waiting-on-frontier",
      "blocked-gate",
    ]),
    reason: z.string().optional(),
    topology: ExecutionTopologySchema,
    controller: ExecutionContextConfigSchema.optional(),
    execution: ExecutionContextConfigSchema.optional(),
    helper: ExecutionContextConfigSchema.optional(),
    work_items: z.array(WorkItemConfigSchema).optional(),
    review: ExecutionReviewConfigSchema,
    preview: ExecutionPreviewSchema.optional(),
  })
  .passthrough();
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
