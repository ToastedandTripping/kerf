import Papa from "papaparse";
import type { DesignObject, SerialConfig } from "../app/types";

/**
 * Extract unique placeholder names from a template string.
 * Placeholders use `{name}` syntax.
 */
export function extractPlaceholders(text: string): string[] {
  const regex = /\{([^}]+)\}/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    names.add(match[1]);
  }
  return Array.from(names);
}

/**
 * Replace all `{key}` placeholders in text with corresponding values.
 */
export function substitutePlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{([^}]+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}

/**
 * Generate an array of serial values based on config.
 * Each value is: prefix + zeroPadded(number) + suffix
 */
export function generateSerialValues(config: SerialConfig): string[] {
  const results: string[] = [];
  for (let i = 0; i < config.count; i++) {
    const num = config.start + i * config.increment;
    const sign = num < 0 ? "-" : "";
    const padded = String(Math.abs(num)).padStart(config.zeroPad, "0");
    results.push(`${config.prefix}${sign}${padded}${config.suffix}`);
  }
  return results;
}

/**
 * Check if a DesignObject's text contains any {placeholder} patterns.
 */
export function hasPlaceholders(obj: DesignObject): boolean {
  if (!obj.text) return false;
  return /\{[^}]+\}/.test(obj.text);
}

/**
 * Parse CSV text into headers and rows using PapaParse.
 */
export function parseCsv(csvText: string): { headers: string[]; rows: string[][] } {
  const result = Papa.parse<string[]>(csvText, {
    header: false,
    skipEmptyLines: true,
  });
  if (result.data.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = result.data[0].map((h: string) => h.trim());
  const rows = result.data.slice(1);
  return { headers, rows };
}
