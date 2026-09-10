import { runJxa } from "../jxa/bridge.js";

export interface DocumentSummary {
  name: string;
  id: string;
  kind: string;
  path: string;
  isCurrent: boolean;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  return runJxa<DocumentSummary[]>(`
    const docs = co.documents();
    const current = co.currentDocument();
    const currentId = current ? String(current.id()) : null;
    const out = [];
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      out.push({
        name: String(d.name()),
        id: String(d.id()),
        kind: String(d.kind()),
        path: String(d.path()),
        isCurrent: String(d.id()) === currentId,
      });
    }
    return out;
  `);
}

export async function getDocument(): Promise<Record<string, unknown>> {
  return runJxa<Record<string, unknown>>(`
    const d = requireDoc();
    function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback === undefined ? null : fallback; } }

    return {
      name: String(d.name()),
      id: String(d.id()),
      kind: String(d.kind()),
      // NOTE: path reports the folder CONTAINING the document, not the document
      // itself, so expose the real file path alongside it.
      path: safe(function () { return String(d.path()); }),
      documentPath: safe(function () { return String(d.id()) + "/" + String(d.name()); }),
      folder: safe(function () { return String(d.folder()); }),
      currentCollection: safe(function () { const c = d.currentCollection(); return c ? String(c.name()) : null; }),
      currentRecipe: safe(function () { const r = d.currentRecipe(); return r ? String(r.name()) : null; }),
      counts: {
        collections: safe(function () { return d.collections().length; }, -1),
        recipes: safe(function () { return d.recipes().length; }, -1),
        // Pending items in the processing queue.
        queuedJobs: safe(function () { return d.jobs().length; }, -1),
      },
      folders: {
        // Session folders; null on a catalog, which is expected rather than an error.
        captures: safe(function () { return String(d.captures()); }),
        selects: safe(function () { return String(d.selects()); }),
        output: safe(function () { return String(d.output()); }),
        trash: safe(function () { return String(d.trash()); }),
      },
      naming: {
        outputNameFormat: safe(function () { return String(d.outputNameFormat()); }),
        outputName: safe(function () { return String(d.outputName()); }),
        captureNameFormat: safe(function () { return String(d.captureNameFormat()); }),
        outputCounter: safe(function () { return d.outputCounter(); }),
        captureCounter: safe(function () { return d.captureCounter(); }),
      },
      processingQueueEnabled: safe(function () { return d.processingQueueEnabled(); }),
      filters: safe(function () { return d.filters(); }, []),
      selectedVariants: safe(function () { return co.selectedVariants().length; }, -1),
    };
  `);
}

export async function openDocument(path: string): Promise<DocumentSummary> {
  return runJxa<DocumentSummary>(
    `
    co.open(Path(args.path));
    delay(1);
    const d = co.currentDocument();
    if (!d) throw new Error("Capture One did not report an open document after opening " + args.path);
    return {
      name: String(d.name()), id: String(d.id()), kind: String(d.kind()),
      path: String(d.path()), isCurrent: true,
    };
    `,
    // Opening a catalog can be slow: Capture One may need to build previews or
    // prompt to migrate an older document format.
    { args: { path }, timeoutMs: 120_000, mutating: true },
  );
}
