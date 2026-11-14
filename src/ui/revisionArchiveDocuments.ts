import { selectReviewTarget, isWorkingTreeUri, type ResolveOptions } from './reviewTargets';
import * as vscode from 'vscode';
import { comparisonKey } from '../core/comparisons';
import { isDocumentRef, revisionRef, type DocumentRef } from '../core/documents';
import { isWithin, repoRelativePath } from '../core/paths';
import { revisionUri, resolveDocumentRef } from './revisions';
import { SerialQueue } from '../core/collections';
import type { RevisionArchiveStore } from '../git/revisionArchiveStore';
import type { RepositoryAccess } from './repositories';
import type { RevisionSnapshots, RevisionSnapshot } from './revisionSnapshots';
const PAIRS_KEY = 'vsreview.archivePairs';
const CONTEXTS_KEY = 'vsreview.archiveContexts';
interface ArchiveContext {
  root: string;
  ref: DocumentRef;
  snapshot?: RevisionSnapshot;
  failed?: boolean;
  links?: string[];
  preparing?: Promise<void> | undefined;
}
export class RevisionArchiveDocuments {
  private readonly pairs = new Map<string, DocumentRef>();
  private readonly contexts = new Map<string, ArchiveContext>();
  private readonly writes = new SerialQueue();
  constructor(
    private readonly state: vscode.Memento,
    private readonly store: RevisionArchiveStore,
    private readonly access: RepositoryAccess,
    private readonly snapshots: RevisionSnapshots,
    private readonly reportFailure: (error: unknown) => void,
  ) {
    const pairs = state.get<unknown>(PAIRS_KEY);
    if (Array.isArray(pairs)) {
      for (const pair of pairs) {
        if (
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === 'string' &&
          isDocumentRef(pair[1]) &&
          access.isKnown(pair[1].repo)
        ) {
          this.pairs.set(pair[0], pair[1]);
        }
      }
    }
    const saved = state.get<unknown>(CONTEXTS_KEY);
    if (Array.isArray(saved)) {
      for (const ref of saved) {
        if (isDocumentRef(ref) && access.isKnown(ref.repo)) {
          this.contextFor(store.rootFor(ref.repo, ref.rev), revisionRef(ref, ref.side));
        }
      }
    }
  }
  private contextFor(root: string, ref: DocumentRef): ArchiveContext {
    const key = JSON.stringify([root, comparisonKey(ref), ref.side]);
    let context = this.contexts.get(key);
    if (!context) {
      context = { root, ref };
      this.contexts.set(key, context);
    }
    return context;
  }
  async remember(root: string, ref: DocumentRef): Promise<void> {
    const context = this.contextFor(root, ref);
    context.links = await this.store.links(root);
    context.snapshot = await this.snapshots.get(ref);
    context.ref = ref;
    this.touch(context);
    await this.save();
  }
  hasContext(uris: readonly vscode.Uri[]): boolean {
    return [...this.contexts.values()].some(({ root }) =>
      uris.some((uri) => uri.scheme === 'file' && isWithin(root, uri.fsPath)),
    );
  }
  async prepare(uris: readonly vscode.Uri[]): Promise<void> {
    const removed: string[] = [];
    for (const context of this.contexts.values()) {
      if (!uris.some((uri) => uri.scheme === 'file' && isWithin(context.root, uri.fsPath))) {
        continue;
      }
      if (context.snapshot && !context.failed) {
        continue;
      }
      context.preparing ??= (async () => {
        try {
          if (!(await this.store.valid(context.root, context.ref.repo))) {
            removed.push(context.root);
          } else {
            context.links = await this.store.links(context.root);
            context.snapshot = await this.snapshots.get(context.ref);
          }
          context.failed = false;
        } catch (error) {
          context.failed = true;
          this.reportFailure(error);
        } finally {
          context.preparing = undefined;
        }
      })();
      await context.preparing;
    }
    if (removed.length) {
      await this.forget(removed);
    }
  }
  owns(uri: vscode.Uri): boolean {
    return (
      uri.scheme === 'file' && [...this.contexts.values()].some((context) => this.path(context, uri) !== undefined)
    );
  }
  sourceRoot(uri: vscode.Uri): string | undefined {
    return uri.scheme === 'file'
      ? [...this.contexts.values()].find((context) => this.path(context, uri) !== undefined)?.root
      : undefined;
  }
  private path({ root, links, ref, failed, snapshot }: ArchiveContext, uri: vscode.Uri): string | undefined {
    if (failed || !snapshot || !links || !this.access.isKnown(ref.repo) || !isWithin(root, uri.fsPath)) {
      return undefined;
    }
    const path = repoRelativePath(root, uri.fsPath);
    return links?.some((link) => path === link || path.startsWith(`${link}/`)) ? undefined : path;
  }
  refs(uri: vscode.Uri): DocumentRef[] {
    if (uri.scheme !== 'file' || uri.query) {
      return [];
    }
    const refs: DocumentRef[] = [];
    for (const context of this.contexts.values()) {
      const path = this.path(context, uri);
      if (path === undefined) {
        continue;
      }
      const { ref, snapshot } = context;
      refs.push(
        revisionRef(
          {
            ...ref,
            file: snapshot?.changes[ref.side].get(path) ?? (ref.path === path ? ref.file : { path, status: 'M' }),
          },
          ref.side,
        ),
      );
    }
    return refs;
  }
  private touch(context: ArchiveContext): void {
    const key = JSON.stringify([context.root, comparisonKey(context.ref), context.ref.side]);
    this.contexts.delete(key);
    this.contexts.set(key, context);
  }
  async resolve(uri: vscode.Uri, options: ResolveOptions): Promise<DocumentRef | undefined> {
    const diffs = options.diffs ?? [];
    const refs = this.refs(uri);
    const open = refs.filter((ref) => diffs.some((diff) => comparisonKey(diff.ref) === comparisonKey(ref)));
    // 開いている比較を優先し、通常タブだけなら最後に使った保存文脈を復元する。
    const candidates = open.length ? open : refs;
    const contexts = [...this.contexts.values()];
    const latest = [...contexts].reverse().find((context) => this.path(context, uri) !== undefined);
    const targets = candidates.map((ref) => {
      const context = contexts.find(
        (value) =>
          comparisonKey(value.ref) === comparisonKey(ref) &&
          value.ref.side === ref.side &&
          this.path(value, uri) !== undefined,
      );
      const matches = (diff: (typeof diffs)[number]): boolean => {
        if (comparisonKey(diff.ref) !== comparisonKey(ref)) {
          return false;
        }
        const onRight = contexts.some(
          (context) => isWithin(context.root, uri.fsPath) && isWithin(context.root, diff.right.fsPath),
        );
        return ref.side === (onRight ? 'new' : 'old');
      };
      return {
        ref,
        context,
        active: diffs.some((diff) => diff.active && matches(diff)),
        previous: open.length
          ? diffs.some((diff) => revisionUri(diff.ref, 'old').toString() === options.lastActiveDiff && matches(diff))
          : context === latest,
      };
    });
    const selected = selectReviewTarget(targets, options);
    if (
      selected?.context &&
      options.commit === undefined &&
      !options.comparison &&
      contexts.at(-1) !== selected.context
    ) {
      this.touch(selected.context);
      await this.save();
    }
    return selected?.ref;
  }
  async rememberPair(left: vscode.Uri, right: vscode.Uri, ref: DocumentRef): Promise<void> {
    for (const [key, saved] of this.pairs) {
      if (!this.hasContextFor(saved)) {
        this.pairs.delete(key);
      }
    }
    if (this.owns(left)) {
      this.pairs.set(JSON.stringify([left.toString(), right.toString()]), ref);
    }
    await this.save();
  }
  private hasContextFor(ref: DocumentRef): boolean {
    return [...this.contexts.values()].some(
      (context) => comparisonKey(context.ref) === comparisonKey(ref) && context.ref.side === ref.side,
    );
  }
  pairRef(left: vscode.Uri, right: vscode.Uri): DocumentRef | undefined {
    const candidates = this.refs(left).filter((ref) => ref.side === 'old');
    const remembered = this.pairs.get(JSON.stringify([left.toString(), right.toString()]));
    if (
      remembered &&
      candidates.some(
        (ref) => comparisonKey(ref) === comparisonKey(remembered) && ref.file.path === remembered.file.path,
      )
    ) {
      return remembered;
    }
    const modified = resolveDocumentRef(right, this.access);
    const rightRefs = modified ? [modified] : this.refs(right);
    const matches = candidates.filter(
      (ref) =>
        rightRefs.some(
          (other) =>
            other.side === 'new' && comparisonKey(other) === comparisonKey(ref) && other.file.path === ref.file.path,
        ) ||
        (!modified &&
          right.scheme === 'file' &&
          !ref.empty &&
          ref.file.status !== 'D' &&
          isWorkingTreeUri(ref.repo, ref.file.path, right)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  roots(): string[] {
    return [...new Set([...this.contexts.values()].map(({ root }) => root))];
  }
  async forget(roots: readonly string[]): Promise<void> {
    if (!roots.length) {
      return;
    }
    const removed = new Set(roots);
    for (const [key, { root }] of this.contexts) {
      if (removed.has(root)) {
        this.contexts.delete(key);
      }
    }
    for (const [key, ref] of this.pairs) {
      if (!this.hasContextFor(ref)) {
        this.pairs.delete(key);
      }
    }
    await this.save();
  }
  private save(): Promise<void> {
    return this.writes.run(async () => {
      await this.state.update(PAIRS_KEY, this.pairs.size ? [...this.pairs] : undefined);
      await this.state.update(
        CONTEXTS_KEY,
        this.contexts.size ? [...this.contexts.values()].map(({ ref }) => ref) : undefined,
      );
    });
  }
}
