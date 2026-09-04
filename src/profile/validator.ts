import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv from "ajv";
import _addFormats from "ajv-formats";

const Ajv = (_Ajv as any).default ?? _Ajv;
const addFormats = (_addFormats as any).default ?? _addFormats;

let cachedValidator: any = null;

/**
 * Locate and load profile.schema.json from known filesystem locations.
 */
export function loadProfileJsonSchema(): Record<string, unknown> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../schemas/profile.schema.json"),
    resolve(currentDir, "../schemas/profile.schema.json"),
    resolve(currentDir, "../../../schemas/profile.schema.json"),
    resolve(process.cwd(), "schemas/profile.schema.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, "utf-8");
      return JSON.parse(content);
    }
  }

  throw new Error(
    `Unable to locate profile.schema.json. Searched:\n${candidates.join("\n")}`
  );
}

/**
 * Returns a compiled Ajv validator for profile.schema.json.
 */
export function getProfileJsonValidator(): any {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = loadProfileJsonSchema();
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

export interface JsonSchemaValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Validate a profile object directly against the canonical profile.schema.json.
 */
export function validateProfileAgainstJsonSchema(
  data: unknown
): JsonSchemaValidationResult {
  const validator = getProfileJsonValidator();
  const valid = validator(data);
  if (!valid) {
    const errors = (validator.errors || []).map(
      (err: any) => `${err.instancePath || "/"} ${err.message}`
    );
    return { valid: false, errors };
  }
  return { valid: true };
}
