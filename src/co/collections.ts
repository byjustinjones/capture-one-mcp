import { runJxa } from "../jxa/bridge.js";

export interface CollectionSummary {
  name: string;
  id: string;
  kind: string;
  user: boolean;
  variantCount: number;
  folder: string | null;
  isCurrent: boolean;
}

export async function listCollections(includeCounts: boolean): Promise<CollectionSummary[]> {
  return runJxa<CollectionSummary[]>(
    `
    const d = requireDoc();
    const cols = d.collections();
    const current = d.currentCollection();
    const currentId = current ? String(current.id()) : null;
    const out = [];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      let count = -1;
      // Counting forces the collection to resolve its contents, which is slow
      // on large smart albums -- so it is opt-in.
      if (args.includeCounts) { try { count = c.variants().length; } catch (e) { count = -1; } }
      let folder = null;
      try { const f = c.folder(); folder = f ? String(f) : null; } catch (e) { /* albums have no folder */ }
      out.push({
        name: String(c.name()),
        id: String(c.id()),
        kind: String(c.kind()),
        user: Boolean(c.user()),
        variantCount: count,
        folder: folder,
        isCurrent: String(c.id()) === currentId,
      });
    }
    return out;
    `,
    { args: { includeCounts }, timeoutMs: includeCounts ? 120_000 : 30_000 },
  );
}

export async function setCurrentCollection(nameOrId: string): Promise<CollectionSummary> {
  return runJxa<CollectionSummary>(
    `
    const d = requireDoc();
    const wanted = String(args.nameOrId).toLowerCase();
    const cols = d.collections();
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (String(c.name()).toLowerCase() === wanted || String(c.id()) === args.nameOrId) {
        d.currentCollection = c;
        return {
          name: String(c.name()), id: String(c.id()), kind: String(c.kind()),
          user: Boolean(c.user()), variantCount: -1, folder: null, isCurrent: true,
        };
      }
    }
    throw new Error("No collection named or with id '" + args.nameOrId + "'");
    `,
    { args: { nameOrId }, mutating: true },
  );
}
