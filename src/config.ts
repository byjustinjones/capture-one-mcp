/**
 * Tool risk classification and the gate that acts on it.
 *
 * This server drives a real photo library, so every tool declares what it can
 * touch and the gate decides whether it is served at all. A tool above the
 * permitted tier is never registered, so it is invisible rather than
 * present-and-failing.
 */
export type RiskLevel =
  /** Pure query. Changes nothing. */
  | "read"
  /** Changes app view state only -- which document/collection is focused.
   *  No image data, metadata or library structure is touched. */
  | "view"
  /** Writes image adjustments, metadata, ratings, or library structure.
   *  Reversible via Capture One's own undo. */
  | "data"
  /** Irreversible: delete, reset adjustments, batch rename, upgrade engine. */
  | "destructive";

export interface ServerConfig {
  allowData: boolean;
  allowDestructive: boolean;
  /** Cap on variants pulled from Capture One in one call. Lowers the schema's
   *  own limit of 500; raising it above 500 has no effect. */
  maxVariants: number;
  /** Document binding: "off", a fixed document id, or "auto" (first touch). */
  documentPin: string | null;
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v?.toLowerCase() === "true";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): ServerConfig {
  // Read-only is the default posture: mutation must be opted into explicitly,
  // and irreversible verbs need a second, separate opt-in.
  const allowData = envFlag("CAPTURE_ONE_MCP_ALLOW_WRITE");
  return {
    allowData,
    allowDestructive: allowData && envFlag("CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE"),
    maxVariants: envInt("CAPTURE_ONE_MCP_MAX_VARIANTS", 500),
    documentPin: process.env["CAPTURE_ONE_MCP_DOCUMENT"]?.trim() || null,
  };
}

export function isAllowed(risk: RiskLevel, config: ServerConfig): boolean {
  switch (risk) {
    case "read":
    case "view":
      return true;
    case "data":
      return config.allowData;
    case "destructive":
      return config.allowDestructive;
  }
}
