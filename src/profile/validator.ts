import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv from "ajv";
import _addFormats from "ajv-formats";

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
 */
export function validateProfileAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  return runValidator(getProfileJsonValidator(), data);
}

/**
 * Validate an execution config object directly against the canonical execution-config.schema.json.
 */
export function validateExecutionConfigAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  return runValidator(getExecutionConfigJsonValidator(), data);
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
