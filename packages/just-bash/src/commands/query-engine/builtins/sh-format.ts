/**
 * Automa: jq `@sh`. Strings are single-quoted, other scalars use their JSON
 * text, and an array becomes its formatted scalars joined by spaces, as in
 * jq 1.7. Objects and nested arrays cannot be escaped for the shell.
 */
import type { QueryValue } from "../value-operations.js";

function shScalar(value: QueryValue): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "'\\''")}'`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const kind = Array.isArray(value) ? "array" : "object";
  throw new Error(
    `${kind} (${JSON.stringify(value)}) can not be escaped for shell`,
  );
}

export function formatSh(value: QueryValue): string {
  return Array.isArray(value) ? value.map(shScalar).join(" ") : shScalar(value);
}
