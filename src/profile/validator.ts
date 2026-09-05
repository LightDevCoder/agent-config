import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv from "ajv";
import _addFormats from "ajv-formats";
import { Profile, ExecutionConfig, migrateReasoning } from "./schema.js";
import { HostCapabilities } from "../adapters/contract.js";

const Ajv = (_Ajv as any).default ?? _Ajv;
const addFormats = (_addFormats as any).default ?? _addFormats;

let cachedProfileValidator: any = null;
let cachedExecutionConfigValidator: any = null;
let cachedPreviewValidator: any = null;
let cachedApplyValidator: any = null;
let cachedValidationValidator: any = null;
let cachedCompanionContractValidator: any = null;

/**
 * Locate and load a schema JSON file from known filesystem locations.
 */
export function loadJsonSchema(filename: string): Record<string, unknown> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, `../../schemas/${filename}`),
    resolve(currentDir, `../schemas/${filename}`),
    resolve(currentDir, `../../../schemas/${filename}`),
    resolve(process.cwd(), `schemas/${filename}`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, "utf-8");
      return JSON.parse(content);
    }
  }

  throw new Error(
    `Unable to locate ${filename}. Searched:\n${candidates.join("\n")}`
  );
}

/**
 * Locate and load profile.schema.json from known filesystem locations.
 */
export function loadProfileJsonSchema(): Record<string, unknown> {
  return loadJsonSchema("profile.schema.json");
}

/**
 * Locate and load execution-config.schema.json from known filesystem locations.
 */
export function loadExecutionConfigJsonSchema(): Record<string, unknown> {
  return loadJsonSchema("execution-config.schema.json");
}

/**
 * Locate and load preview.schema.json from known filesystem locations.
 */
export function loadPreviewJsonSchema(): Record<string, unknown> {
  return loadJsonSchema("preview.schema.json");
}

/**
 * Locate and load apply.schema.json from known filesystem locations.
 */
export function loadApplyJsonSchema(): Record<string, unknown> {
  return loadJsonSchema("apply.schema.json");
}

/**
 * Locate and load validation.schema.json from known filesystem locations.
 */
export function loadValidationJsonSchema(): Record<string, unknown> {
  return loadJsonSchema("validation.schema.json");
}

/**
 * Locate and load companion-contract.schema.json from known filesystem locations.
 */
export function loadCompanionContractJsonSchema(): Record<string, unknown> {
  return loadJsonSchema("companion-contract.schema.json");
}

function createAjv(): any {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Returns a compiled Ajv validator for profile.schema.json.
 */
export function getProfileJsonValidator(): any {
  if (!cachedProfileValidator) {
    const ajv = createAjv();
    const schema = loadProfileJsonSchema();
    cachedProfileValidator = ajv.compile(schema);
  }
  return cachedProfileValidator;
}

/**
 * Returns a compiled Ajv validator for execution-config.schema.json.
 */
export function getExecutionConfigJsonValidator(): any {
  if (!cachedExecutionConfigValidator) {
    const ajv = createAjv();
    const schema = loadExecutionConfigJsonSchema();
    cachedExecutionConfigValidator = ajv.compile(schema);
  }
  return cachedExecutionConfigValidator;
}

/**
 * Returns a compiled Ajv validator for preview.schema.json.
 */
export function getPreviewJsonValidator(): any {
  if (!cachedPreviewValidator) {
    const ajv = createAjv();
    const schema = loadPreviewJsonSchema();
    cachedPreviewValidator = ajv.compile(schema);
  }
  return cachedPreviewValidator;
}

/**
 * Returns a compiled Ajv validator for apply.schema.json.
 */
export function getApplyJsonValidator(): any {
  if (!cachedApplyValidator) {
    const ajv = createAjv();
    const schema = loadApplyJsonSchema();
    cachedApplyValidator = ajv.compile(schema);
  }
  return cachedApplyValidator;
}

/**
 * Returns a compiled Ajv validator for validation.schema.json.
 */
export function getValidationJsonValidator(): any {
  if (!cachedValidationValidator) {
    const ajv = createAjv();
    const schema = loadValidationJsonSchema();
    cachedValidationValidator = ajv.compile(schema);
  }
  return cachedValidationValidator;
}

/**
 * Returns a compiled Ajv validator for companion-contract.schema.json.
 */
export function getCompanionContractJsonValidator(): any {
  if (!cachedCompanionContractValidator) {
    const ajv = createAjv();
    const schema = loadCompanionContractJsonSchema();
    cachedCompanionContractValidator = ajv.compile(schema);
  }
  return cachedCompanionContractValidator;
}

export interface JsonSchemaValidationResult {
  valid: boolean;
  errors?: string[];
}

function runValidator(validator: any, data: unknown): JsonSchemaValidationResult {
  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Input must be a non-null object"],
    };
  }
  const valid = validator(data);
  if (!valid) {
    const errors = (validator.errors || []).map(
      (err: any) => `${err.instancePath || "/"} ${err.message}`
    );
    return { valid: false, errors };
  }
  return { valid: true };
}

/**
 * Validate a profile object directly against the canonical profile.schema.json.
 * Safely strips legacy models.available so legacy profiles can be migrated without failing.
 */
export function validateProfileAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  let target = data;
  if (data && typeof data === "object" && "models" in (data as any)) {
    const copy = { ...(data as any) };
    delete copy.models;
    target = copy;
  }
  return runValidator(getProfileJsonValidator(), target);
}

/**
 * Validate an execution config object directly against the canonical execution-config.schema.json.
 * Migrates legacy string effort fields into canonical reasoning before validation.
 */
export function validateExecutionConfigAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  let target = data;
  if (data && typeof data === "object") {
    const copy = { ...(data as any) };
    if (copy.controller) copy.controller = migrateReasoning(copy.controller);
    if (copy.execution) copy.execution = migrateReasoning(copy.execution);
    if (copy.helper) copy.helper = migrateReasoning(copy.helper);
    if (copy.review) copy.review = migrateReasoning(copy.review);
    if (Array.isArray(copy.work_items)) {
      copy.work_items = copy.work_items.map(migrateReasoning);
    }
    target = copy;
  }
  return runValidator(getExecutionConfigJsonValidator(), target);
}

export interface ExecutionConfigValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Validates an ExecutionConfig against both user Profile authorization and Host availability evidence.
 * Strict invariants:
 * 1. User authorization is established solely through explicit user selection: single_model.model or tiers[tier].model.
 * 2. Host availability must be evidenced by runtime/config inspection or explicit user-confirmed Host evidence. Profile grant alone never counts as availability evidence.
 * 3. Both authorization and availability must be true!
 * 4. Capabilities (subagents, threads, parallelism, model_selection) are verified; if capability state is 'unknown', fail closed with rejection.
 */
export function validateExecutionConfig(
  config: ExecutionConfig | unknown,
  profile: Profile,
  hostCapabilities: HostCapabilities
): ExecutionConfigValidationResult {
  const errors: string[] = [];

  if (!config || typeof config !== "object") {
    return {
      valid: false,
      errors: ["Execution config must be a non-null object"],
    };
  }

  const cfg = config as any;

  // 1. Collect all selected models across all roles in config
  const selectedModels: Array<{ role: string; model: string }> = [];
  if (cfg.controller?.model) {
    selectedModels.push({ role: "controller", model: cfg.controller.model });
  }
  if (cfg.execution?.model) {
    selectedModels.push({ role: "execution", model: cfg.execution.model });
  }
  if (cfg.helper?.model) {
    selectedModels.push({ role: "helper", model: cfg.helper.model });
  }
  if (cfg.review?.model) {
    selectedModels.push({ role: "review", model: cfg.review.model });
  }
  if (Array.isArray(cfg.work_items)) {
    cfg.work_items.forEach((item: any, idx: number) => {
      if (item?.model) {
        selectedModels.push({
          role: `work_item[${item.ticket_id || idx}]`,
          model: item.model,
        });
      }
    });
  }

  // 2. User Authorization:
  // User authorization is established solely through explicit user selection:
  // single_model.model or tiers[tier].model.
  const authorizedModels = new Set<string>();
  if (profile.model_mode === "single" && profile.single_model) {
    authorizedModels.add(profile.single_model.model);
  } else if (profile.model_mode === "multi" && profile.tiers) {
    const tierKeys = ["routine", "standard", "high", "review"] as const;
    for (const key of tierKeys) {
      const tierMapping = profile.tiers[key];
      if (tierMapping?.model) {
        authorizedModels.add(tierMapping.model);
      }
    }
  }

  for (const { role, model } of selectedModels) {
    if (!authorizedModels.has(model)) {
      errors.push(
        `Model '${model}' in role '${role}' is not explicitly authorized in user profile (authorized: ${Array.from(authorizedModels).join(", ") || "none"}).`
      );
    }
  }

  // 3. Host Availability Evidence:
  // Host availability must be evidenced by runtime/config inspection or explicit user-confirmed Host evidence.
  // Profile grant alone never counts as availability evidence.
  const evidencedAvailableModels = new Set<string>();
  const rawHostModels =
    hostCapabilities.available_models ||
    (hostCapabilities as any).models ||
    [];

  for (const hm of rawHostModels) {
    if (typeof hm === "string") {
      evidencedAvailableModels.add(hm);
    } else if (hm && typeof hm === "object" && hm.id) {
      if (hm.state === "available") {
        evidencedAvailableModels.add(hm.id);
      }
    }
  }

  for (const { role, model } of selectedModels) {
    if (!evidencedAvailableModels.has(model)) {
      errors.push(
        `Model '${model}' in role '${role}' is not evidenced as available on host '${hostCapabilities.host_id}' (evidenced available: ${Array.from(evidencedAvailableModels).join(", ") || "none"}). Profile grant alone does not count as availability evidence.`
      );
    }
  }

  // 4. Capability verification (subagents, threads, parallelism, model_selection):
  // If capability state is "unknown", fail closed with error/rejection!
  const hostCaps = hostCapabilities.capabilities || ({} as any);
  const profileCaps = profile.capabilities || ({} as any);

  // Check subagents
  const requiresSubagents =
    cfg.topology?.type === "controller-workers" ||
    cfg.topology?.type === "parallel-workers" ||
    Boolean(cfg.topology?.subagent_contexts) ||
    Boolean(cfg.helper);

  if (requiresSubagents) {
    const hostSubagentState = hostCaps.subagents?.state;
    const profileSubagentState = profileCaps.subagents;
    if (hostSubagentState === "unknown" || profileSubagentState === "unknown") {
      errors.push(
        `Capability 'subagents' has state 'unknown' on host or profile. Fail-closed rejection: subagents must be verified available before execution.`
      );
    } else if (hostSubagentState === "unavailable" || profileSubagentState === "unavailable") {
      errors.push(
        `Capability 'subagents' is unavailable on host or profile.`
      );
    }
  }

  // Check parallelism / concurrency / threads
  const requiresParallelism =
    (cfg.topology?.concurrency && cfg.topology.concurrency > 1) ||
    cfg.topology?.type === "parallel-workers";

  if (requiresParallelism) {
    const hostParallelState = hostCaps.parallelism?.state;
    const profileParallelState = profileCaps.parallelism;
    const hostThreadState = hostCaps.threads?.state;
    const profileThreadState = profileCaps.threads;

    if (
      hostParallelState === "unknown" ||
      profileParallelState === "unknown" ||
      hostThreadState === "unknown" ||
      profileThreadState === "unknown"
    ) {
      errors.push(
        `Concurrency / parallelism capability has state 'unknown' on host or profile. Fail-closed rejection: concurrency > 1 requires verified parallelism.`
      );
    } else if (
      hostParallelState === "unavailable" &&
      hostThreadState === "unavailable"
    ) {
      errors.push(
        `Parallelism and threads capabilities are unavailable on host for concurrency > 1.`
      );
    }
  }

  // Fail-closed on unknown model_selection for multi-model mode
  if (cfg.model_mode === "multi") {
    const modelSelState = hostCaps.model_selection?.state;
    if (modelSelState === "unknown") {
      errors.push(
        `Capability 'model_selection' has state 'unknown' on host. Fail-closed rejection: multi-model mode requires verified model selection.`
      );
    } else if (modelSelState === "unavailable") {
      errors.push(
        `Capability 'model_selection' is unavailable on host for multi-model mode.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Validate a preview result object directly against the canonical preview.schema.json.
 */
export function validatePreviewAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  return runValidator(getPreviewJsonValidator(), data);
}

/**
 * Validate an apply result object directly against the canonical apply.schema.json.
 */
export function validateApplyAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  return runValidator(getApplyJsonValidator(), data);
}

/**
 * Validate a validation result object directly against the canonical validation.schema.json.
 */
export function validateValidationAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  return runValidator(getValidationJsonValidator(), data);
}

/**
 * Validate a companion contract object directly against the canonical companion-contract.schema.json.
 */
export function validateCompanionContractAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  return runValidator(getCompanionContractJsonValidator(), data);
}
