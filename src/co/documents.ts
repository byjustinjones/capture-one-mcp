import { dirname } from "node:path";
import { bindOpenedDocument, CaptureOneError, documentLock, runJxa, sameText } from "../jxa/bridge.js";

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
  `,
  // Lists every open document, so it is about none of them in particular and
  // must not latch the auto-pin onto whichever happens to be frontmost.
  { observeOnly: true });
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
  // A document's id is its folder path, which for a .cosessiondb or a
  // catalog's .cocatalogdb is the folder containing that file. A bound server
  // refuses to open anything else BEFORE opening it: opening changes the front
  // document, and every later call would then be refused anyway -- after an
  // irreversible format migration may already have run. The post-open check in
  // bindOpenedDocument is the authoritative one; this only fails early.
  const lock = documentLock();
  const expectedId = dirname(path);
  if (lock.documentId && !sameText(lock.documentId.replace(/\/+$/, ""), expectedId)) {
    throw new CaptureOneError(
      `Refusing to open '${path}': this server is bound to '${lock.documentId}' ` +
        `(${lock.mode === "fixed" ? "CAPTURE_ONE_MCP_DOCUMENT" : "auto binding"}), and opening another ` +
        "document would direct later variant ids at it. Reconnect the server to switch documents.",
      "WRONG_DOCUMENT",
    );
  }
  const opened = await runJxa<DocumentSummary>(
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
    // prompt to migrate an older document format. observeOnly: binding BEFORE
    // opening would latch the previously frontmost document; the opened one is
    // bound below instead.
    { args: { path }, timeoutMs: 120_000, mutating: true, observeOnly: true },
  );
  bindOpenedDocument(opened.id);
  return opened;
}
