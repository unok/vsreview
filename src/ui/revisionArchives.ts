import type { ResolveOptions } from './reviewTargets';
import * as vscode from 'vscode';
import { isWithin, repoFile } from '../core/paths';
import type { DocumentRef } from '../core/documents';
import { RevisionArchiveStore } from '../git/revisionArchiveStore';
import { isRegularFileWithin, matchesFileContent } from '../git/paths';
import type { RepositoryAccess } from './repositories';
import type { RevisionSnapshots } from './revisionSnapshots';
import { confirmClear, showError, showWarning, errorMessage } from './common';
import { archiveLinkPathsSetting, archiveMaxCountSetting } from './revisionArchiveSettings';
import { RevisionArchivePermissions } from './revisionArchivePermissions';
import { RevisionArchiveDocuments } from './revisionArchiveDocuments';
import { allTabUris } from './tabs';

const FAILURE_DEDUPLICATION_MS = 5000;
const FAILURE_CACHE_LIMIT = 32;

export class RevisionArchives {
  private leases = 0;
  private readonly warned = new WeakSet<vscode.TextDocument>();
  private readonly failures = new Map<string, number>();
  private initialized: Promise<void> | undefined;
  private constructor(
    private readonly access: RepositoryAccess,
    private readonly permissions: RevisionArchivePermissions,
    private readonly archive?: { store: RevisionArchiveStore; documents: RevisionArchiveDocuments },
  ) {}
  static create(
    context: vscode.ExtensionContext,
    access: RepositoryAccess,
    snapshots: RevisionSnapshots,
  ): RevisionArchives {
    const permissions = new RevisionArchivePermissions(context.workspaceState);
    if (context.storageUri?.scheme !== 'file') {
      return new RevisionArchives(access, permissions);
    }
    const store = new RevisionArchiveStore(context.storageUri.fsPath, (message) => {
      void showWarning(message);
    });
    const archives = new RevisionArchives(access, permissions, {
      store,
      documents: new RevisionArchiveDocuments(context.workspaceState, store, access, snapshots, (error) =>
        archives.reportFailure(error),
      ),
    });
    return archives;
  }
  initialize(): Promise<void> {
    return (this.initialized ??= (this.archive?.store.initialize() ?? Promise.resolve()).catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    }));
  }
  private async ready(uris: readonly vscode.Uri[]): Promise<RevisionArchiveDocuments | undefined> {
    if (!this.archive?.documents.hasContext(uris)) {
      return this.archive?.documents;
    }
    try {
      await this.initialize();
      await this.archive?.documents.prepare(uris);
    } catch (error) {
      this.reportFailure(error);
    }
    return this.archive?.documents;
  }
  async uri(ref: DocumentRef): Promise<vscode.Uri | undefined> {
    try {
      if (!this.archive || ref.empty || !(await this.permissions.allowed(ref.repo))) {
        return undefined;
      }
      // 外部判定が欠けた PR も、head の内容を確認するまで展開しない。
      if (
        ref.side === 'new' &&
        ref.pullRequest &&
        ref.pullRequest.isCrossRepository !== false &&
        !(await this.permissions.allowed(ref.repo, {
          number: ref.pullRequest.number,
          head: ref.pullRequest.headRefOid,
        }))
      ) {
        return undefined;
      }
      await this.initialize();
      const root = await this.archive.store.get(this.access.client(ref.repo), ref.rev, archiveLinkPathsSetting());
      const path = repoFile(root, ref.path);
      if (!(await isRegularFileWithin(root, path))) {
        return undefined;
      }
      await this.archive.documents.remember(root, ref);
      return vscode.Uri.file(path);
    } catch (error) {
      this.reportFailure(error);
      return undefined;
    }
  }
  reportFailure(error: unknown): void {
    const message = errorMessage(error);
    const now = Date.now();
    if (now - (this.failures.get(message) ?? -Infinity) >= FAILURE_DEDUPLICATION_MS) {
      this.failures.set(message, now);
      if (this.failures.size > FAILURE_CACHE_LIMIT) {
        this.failures.delete(this.failures.keys().next().value!);
      }
      showError(error);
    }
  }
  async owns(uri: vscode.Uri): Promise<boolean> {
    return (await this.ready([uri]))?.owns(uri) ?? false;
  }
  async resolve(uri: vscode.Uri, options: ResolveOptions = {}): Promise<DocumentRef | undefined> {
    return (await this.ready([uri]))?.resolve(uri, options);
  }
  async rememberPair(left: vscode.Uri, right: vscode.Uri, ref: DocumentRef): Promise<void> {
    await this.archive?.documents.rememberPair(left, right, ref);
  }
  async pairRef(left: vscode.Uri, right: vscode.Uri): Promise<DocumentRef | undefined> {
    return (await this.ready([left, right]))?.pairRef(left, right);
  }
  async isSource(uri: vscode.Uri): Promise<boolean> {
    const root = (await this.ready([uri]))?.sourceRoot(uri);
    return root !== undefined && (await isRegularFileWithin(root, uri.fsPath));
  }
  async matchesContent(document: vscode.TextDocument, expected: string): Promise<boolean> {
    const root = (await this.ready([document.uri]))?.sourceRoot(document.uri);
    return (
      document.getText() === expected &&
      root !== undefined &&
      (await matchesFileContent(root, document.uri.fsPath, expected))
    );
  }
  async assertCommentable(document: vscode.TextDocument, expected: string): Promise<void> {
    if (!(await this.matchesContent(document, expected))) {
      throw new Error('展開したリビジョンの内容が変わりました。差分を開き直してください');
    }
  }

  async refs(uri: vscode.Uri): Promise<DocumentRef[]> {
    return (await this.ready([uri]))?.refs(uri) ?? [];
  }
  async warnIfEdited(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (event.contentChanges.length && (await this.owns(event.document.uri)) && !this.warned.has(event.document)) {
      this.warned.add(event.document);
      void showWarning(
        '展開したリビジョンは読み取り専用です。編集内容はレビューに使えません。差分を開き直してください',
      );
    }
  }
  async prune(uris?: readonly vscode.Uri[]): Promise<void> {
    if (this.leases || !this.archive) {
      return;
    }
    await this.initialize();
    const openUris = uris ?? allTabUris();
    await this.ready(openUris);
    const pinned = new Set(
      this.archive.documents
        .roots()
        .filter((root) => openUris.some((uri) => uri.scheme === 'file' && isWithin(root, uri.fsPath))),
    );
    const removed = await this.archive.store.prune(archiveMaxCountSetting(), pinned, () => this.leases > 0);
    await this.archive.documents.forget(removed);
  }
  async withLease<T>(action: () => Promise<T>): Promise<T> {
    this.leases++;
    try {
      return await action();
    } finally {
      this.leases--;
      void this.prune().catch((error: unknown) => this.reportFailure(error));
    }
  }
  async clear(): Promise<void> {
    if (!(await confirmClear('展開したリビジョンをすべて削除しますか？'))) {
      return;
    }
    await this.archive?.store.clear();
    await this.archive?.documents.forget(this.archive.documents.roots());
  }
  resetPermissions(): Promise<void> {
    return this.permissions.reset();
  }
}
