import { runJxa } from "../jxa/bridge.js";

export interface CreateCandidatesInput {
  documentId: string;
  variantIds?: string[];
  useCurrentSelection?: boolean;
  /** Reject larger selections, never truncate. Default 10, maximum 50. */
  maxVariants?: number;
}
export interface CreateCandidatesResult {
  document: { id: string; name: string };
  status: "complete" | "incomplete";
  requested: number;
  copies: { originalId: string; candidateId: string; name: string; extension: string }[];
  unattemptedOriginalIds: string[];
  failure: null | { originalId: string; outcome: "not_attempted" | "unknown"; message: string };
  guidance: string;
}

/** Native clones preserve edits using Capture One's implementation.
 * Not transactional or idempotent: never retry an uncertain batch blindly. */
export async function createCandidates(input: CreateCandidatesInput): Promise<CreateCandidatesResult> {
  if (typeof input.documentId !== "string" || !input.documentId.trim()) {
    throw new Error("documentId is required to bind candidate copies to their source document.");
  }
  const maxVariants = input.maxVariants ?? 10;
  if (!Number.isInteger(maxVariants) || maxVariants < 1 || maxVariants > 50) {
    throw new Error("maxVariants must be an integer between 1 and 50.");
  }
  const selection = input.useCurrentSelection === true;
  if (selection === (input.variantIds !== undefined)) {
    throw new Error("Provide either variantIds or useCurrentSelection: true, exclusively.");
  }
  if (!selection && (!Array.isArray(input.variantIds) || !input.variantIds.length ||
      input.variantIds.length > maxVariants || input.variantIds.some(id => typeof id !== "string" || !id.trim()) ||
      new Set(input.variantIds).size !== input.variantIds.length)) {
    throw new Error("variantIds must be nonempty, unique strings within maxVariants.");
  }
  return runJxa<CreateCandidatesResult>(
    `
    const doc = requireDoc();
    const document = { id: String(doc.id()), name: String(doc.name()) };
    function assertDocument() {
      if (String(requireDoc().id()) !== args.documentId) {
        throw new Error("CO_MCP_WRONG_DOCUMENT: candidate document does not match requested document.");
      }
    }
    assertDocument();
    const wanted = args.useCurrentSelection
      ? co.selectedVariants().map(function (v) { return String(v.id()); })
      : args.variantIds.slice();
    if (!wanted.length || wanted.length > args.maxVariants) {
      throw new Error("Candidate source count must be between 1 and " + args.maxVariants + "; nothing was cloned.");
    }
    const unique = Object.create(null);
    for (let i = 0; i < wanted.length; i++) {
      if (unique[wanted[i]]) throw new Error("Duplicate source variant id; nothing was cloned.");
      unique[wanted[i]] = true;
    }
    const initialIds = doc.variants.id().map(String);
    for (let i = 0; i < wanted.length; i++) {
      if (initialIds.indexOf(wanted[i]) < 0) throw new Error("No variant with id '" + wanted[i] + "'; nothing was cloned.");
    }
    const result = { document: document, status: "complete", requested: wanted.length,
      copies: [], unattemptedOriginalIds: [], failure: null,
      guidance: "Edit candidate IDs only. Originals remain available; this tool never deletes variants. Cloning may change Capture One's selection." };
    for (let i = 0; i < wanted.length; i++) {
      let submitted = false;
      try {
        assertDocument();
        // New clones can shift indices, so resolve the source afresh each time.
        const currentIds = doc.variants.id().map(String);
        const at = currentIds.indexOf(wanted[i]);
        if (at < 0) throw new Error("Source variant disappeared before cloning.");
        const source = doc.variants[at];
        const info = describeVariant(source);
        submitted = true;
        const candidate = co.cloneVariant(source, { additiveSelect: false });
        const rawId = candidate.id();
        const candidateId = rawId == null ? "" : String(rawId);
        if (!candidateId || currentIds.indexOf(candidateId) >= 0 || doc.variants.id().map(String).indexOf(candidateId) < 0) {
          throw new Error("Clone did not return a new variant identity.");
        }
        result.copies.push({ originalId: wanted[i], candidateId: candidateId,
          name: info.name, extension: info.extension });
      } catch (e) {
        result.status = "incomplete";
        result.failure = { originalId: wanted[i], outcome: submitted ? "unknown" : "not_attempted", message: String(e) };
        result.unattemptedOriginalIds = wanted.slice(i + (submitted ? 1 : 0));
        result.guidance = "Keep the completed mappings. Inspect this document's variants before retrying: the failed clone may already exist. This batch is not atomic; do not retry the entire request.";
        break;
      }
    }
    return result;
    `,
    { args: { ...input, maxVariants }, timeoutMs: 120_000, mutating: true },
  );
}
