import type { OpenDiff } from './reviewTargets';
import { normalTabUris } from './tabs';
import type { RevisionArchives } from './revisionArchives';
import { showRepositoryError, type RepositoryAccess } from './repositories';
import { fileSide, type FileSide, type ChangedFile, type TreeEntry } from '../core/gitParsing';
import * as vscode from 'vscode';
import { posix } from 'node:path';
import { comparisonKey } from '../core/comparisons';
import {
  revisionRef,
  sideRevision,
  type FileTarget,
  type CommitTarget,
  type ChangeMaps,
  type DocumentRef,
} from '../core/documents';
import { shortHash } from '../core/presentation';
import type { ReviewDocuments } from './documents';
import { statusLabel, folderStatus } from '../core/decorations';
import { statusUri } from './decorations';
import { showError } from './common';
import { isRecord } from '../core/validation';
import { compareNames, PromiseCache } from '../core/collections';
import { RevisionSnapshots, type RevisionSnapshot } from './revisionSnapshots';

interface FileSnapshot {
  target: CommitTarget;
  changes: ChangeMaps;
  roots: FileRoot[];
  children: PromiseCache<FileNode[]>;
  failed: Set<string>;
}
interface FileRoot {
  kind: 'root';
  side: FileSide;
  path: '';
  rev: string;
  empty: boolean;
  snapshot: FileSnapshot;
}
export type FileNode = FileRoot | (TreeEntry & { root: FileRoot; parent: FileNode });
const NO_DIFF = '差分を開くと表示します';

export class FilesTree implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
  private readonly treeDataChanged = new vscode.EventEmitter<FileNode | undefined>();
  readonly onDidChangeTreeData = this.treeDataChanged.event;
  private attachedView: vscode.TreeView<FileNode> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly nodes = new WeakSet<object>();
  private readonly snapshots: RevisionSnapshots;
  private readonly snapshotStates = new WeakMap<RevisionSnapshot, FileSnapshot>();
  private selectedFile: DocumentRef | undefined;
  private invalidated = false;
  private failed: string | undefined;
  private scheduled: Promise<void> | undefined;
  private pendingDiffs: readonly OpenDiff[] | undefined;
  private revealed: string | undefined;
  private current: FileSnapshot | undefined;
  private active: DocumentRef | undefined;
  private generation = 0;
  private disposed = false;
  private constructor(
    private readonly documents: ReviewDocuments,
    private readonly access: RepositoryAccess,
    snapshots: RevisionSnapshots,
    private readonly archives: Pick<RevisionArchives, 'withLease'>,
  ) {
    this.snapshots = snapshots;
  }
  get view(): vscode.TreeView<FileNode> {
    if (!this.attachedView) {
      throw new Error('Files ビューが未登録です');
    }
    return this.attachedView;
  }
  static register(
    documents: ReviewDocuments,
    access: RepositoryAccess,
    snapshots: RevisionSnapshots,
    archives: Pick<RevisionArchives, 'withLease'>,
  ): FilesTree {
    const tree = new FilesTree(documents, access, snapshots, archives);
    tree.attachView(vscode.window.createTreeView('vsreview.files', { treeDataProvider: tree }));
    return tree;
  }
  private attachView(view: vscode.TreeView<FileNode>): void {
    this.attachedView = view;
    view.message = NO_DIFF;
    this.disposables.push(
      view,
      view.onDidChangeVisibility(() => {
        this.revealed = undefined;
        void this.synchronize().catch(showError);
      }),
    );
  }
  synchronize(options: { refresh?: boolean; diffs?: readonly OpenDiff[] } = {}): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.invalidated ||= options.refresh ?? false;
    if (options.refresh) {
      this.failed = undefined;
    }
    ++this.generation;
    this.pendingDiffs = options.diffs;
    // 同じタブ操作で届く editor/tabs/groups の通知を一つの同期にまとめる。
    this.scheduled ??= Promise.resolve().then(async () => {
      this.scheduled = undefined;
      const diffs = this.pendingDiffs;
      this.pendingDiffs = undefined;
      await this.update(this.generation, diffs);
    });
    return this.scheduled;
  }
  private async selectRef(diffs: readonly OpenDiff[]): Promise<DocumentRef | undefined> {
    const selected = this.selectedFile;
    const sameSnapshot = (ref: DocumentRef) => selected !== undefined && comparisonKey(ref) === comparisonKey(selected);
    const uri = vscode.window.activeTextEditor?.document.uri;
    const active = uri && (await this.documents.resolve(uri, { diffs }));
    const activeDiff = diffs.find(({ active }) => active)?.ref;
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (
      active &&
      (diffs.some(({ ref }) => comparisonKey(ref) === comparisonKey(active)) ||
        (uri && (await this.documents.isExpanded(uri)))) &&
      (!activeDiff ||
        comparisonKey(activeDiff) === comparisonKey(active) ||
        (activeTab instanceof vscode.TabInputText && activeTab.uri.toString() === uri?.toString()))
    ) {
      return active;
    }
    if (activeDiff) {
      return activeDiff;
    }
    const openRefs = await Promise.all(
      normalTabUris().map(async (uri) => ({
        ref: await this.documents.resolve(uri, { diffs }),
        expanded: await this.documents.isExpanded(uri),
      })),
    );
    const stillOpen =
      selected &&
      openRefs.some(({ ref }) => ref && sameSnapshot(ref) && ref.side === selected.side && ref.path === selected.path);
    const expandedStillOpen =
      stillOpen &&
      openRefs.some(
        ({ ref, expanded }) =>
          expanded && ref && sameSnapshot(ref) && ref.side === selected?.side && ref.path === selected.path,
      );
    return (
      (expandedStillOpen ||
      diffs.some(({ ref }) => sameSnapshot(ref) && (stillOpen || ref.file.path === selected?.file.path))
        ? selected
        : undefined) ??
      diffs.find(({ ref }) => sameSnapshot(ref))?.ref ??
      diffs[0]?.ref
    );
  }
  private stateFor(snapshot: RevisionSnapshot): FileSnapshot {
    let state = this.snapshotStates.get(snapshot);
    if (!state) {
      const created: FileSnapshot = { ...snapshot, roots: [], children: new PromiseCache(), failed: new Set() };
      created.roots = (['old', 'new'] as const).map((side) => ({
        kind: 'root',
        side,
        path: '',
        snapshot: created,
        rev: sideRevision(created.target, side),
        empty: side === 'old' && created.target.commit.parents.length === 0,
      }));
      this.snapshotStates.set(snapshot, created);
      state = created;
    }
    return state;
  }
  private async update(generation: number, diffs?: readonly OpenDiff[]): Promise<void> {
    if (this.disposed || !this.view.visible) {
      return;
    }
    const openDiffs = diffs ?? (await this.documents.openDiffs());
    const ref = await this.selectRef(openDiffs);
    this.selectedFile = ref;
    if (!ref) {
      this.active = undefined;
      this.setCurrent(undefined);
      return;
    }
    const key = comparisonKey(ref);
    if (this.failed === key) {
      this.setCurrent(undefined);
      return;
    }
    try {
      const snapshot = await this.snapshots.get(ref, { refresh: this.invalidated });
      if (this.disposed || generation !== this.generation || !this.view.visible) {
        return;
      }
      const state = this.stateFor(snapshot);
      if (this.invalidated && state.failed.size > 0) {
        state.failed.clear();
        if (this.current === state) {
          this.treeDataChanged.fire(undefined);
        }
      }
      this.invalidated = false;
      await this.refreshActive(state, ref, generation);
    } catch (error) {
      if (this.disposed || generation !== this.generation) {
        return;
      }
      this.invalidated = false;
      this.failed = key;
      this.setCurrent(undefined);
      await showRepositoryError(this.access, ref.repo, ref.commit.hash, error);
    }
  }
  private async refreshActive(state: FileSnapshot, ref: DocumentRef, generation: number): Promise<void> {
    const activeChanged = JSON.stringify(this.active) !== JSON.stringify(ref);
    const previous = this.active;
    const snapshotUnchanged = this.current === state;
    const revealKey = JSON.stringify(ref);
    const shouldReveal = this.revealed !== revealKey;
    if (!shouldReveal && !activeChanged) {
      return;
    }
    const currentNodes = state.roots.map(async (root) => {
      const { path, empty } = fileSide(ref.file, root.side);
      return empty || root.empty ? undefined : this.find(root, path);
    });
    const previousNodes =
      snapshotUnchanged && activeChanged && previous
        ? state.roots.map(async (root) => {
            const { path, empty } = fileSide(previous.file, root.side);
            return empty || root.empty ? undefined : this.find(root, path);
          })
        : [];
    const nodes = await Promise.all([...currentNodes, ...previousNodes]);
    if (this.disposed || generation !== this.generation || !this.view.visible) {
      return;
    }
    this.active = ref;
    this.setCurrent(state);
    if (snapshotUnchanged && activeChanged) {
      for (const node of new Set(nodes)) {
        if (node) {
          this.treeDataChanged.fire(node);
        }
      }
    }
    if (shouldReveal) {
      // reveal は表示補助。失敗しても取得済みのツリーを失わない。
      try {
        await this.reveal(nodes.slice(0, currentNodes.length), ref.side, generation);
        if (
          generation === this.generation &&
          this.view.visible &&
          state.roots.every(
            (root, index) => root.empty || fileSide(ref.file, root.side).empty || nodes[index] !== undefined,
          )
        ) {
          this.revealed = revealKey;
        }
      } catch (error) {
        if (generation === this.generation) {
          showError(error);
        }
      }
    }
  }
  private setCurrent(snapshot: FileSnapshot | undefined): void {
    if (this.current === snapshot) {
      return;
    }
    this.current = snapshot;
    this.revealed = undefined;
    this.view.message = snapshot ? '' : NO_DIFF;
    this.treeDataChanged.fire(undefined);
  }
  getParent(node: FileNode): FileNode | undefined {
    return node.kind === 'root' ? undefined : node.parent;
  }
  private root(node: FileNode): FileRoot {
    return node.kind === 'root' ? node : node.root;
  }
  async getChildren(node?: FileNode): Promise<FileNode[]> {
    if (!node) {
      return this.current?.roots ?? [];
    }
    const root = this.root(node);
    if (
      !this.access.isKnown(root.snapshot.target.repo) ||
      root.snapshot !== this.current ||
      root.empty ||
      (node.kind !== 'root' && node.kind !== 'folder')
    ) {
      return [];
    }
    const children = await this.children(root, node.path, node);
    return root.snapshot === this.current ? children : [];
  }
  private async children(
    root: FileRoot,
    path: string,
    parent: FileNode | Promise<FileNode | undefined>,
  ): Promise<FileNode[]> {
    const key = JSON.stringify([root.side, path]);
    if (root.snapshot.failed.has(key)) {
      return [];
    }
    try {
      return await root.snapshot.children.get(key, async () => {
        const target = root.snapshot.target;
        const entries = await this.access
          .client(target.repo)
          .tree(root.rev, path)
          .catch(async (error: unknown) => {
            const notify = root.snapshot.failed.size === 0;
            root.snapshot.failed.add(key);
            if (notify) {
              await showRepositoryError(this.access, target.repo, target.commit.hash, error);
            }
            throw error;
          });
        const node = await parent;
        if (!node) {
          root.snapshot.failed.add(key);
          throw new Error('親フォルダを取得できません');
        }
        return entries
          .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || compareNames(a.path, b.path))
          .map((entry) => {
            const child = { ...entry, root, parent: node };
            this.nodes.add(child);
            return child;
          });
      });
    } catch {
      return [];
    }
  }
  private change(node: Exclude<FileNode, FileRoot>): ChangedFile | undefined {
    const { side, snapshot } = node.root;
    return snapshot.changes[side].get(node.path);
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const root = this.root(node);
    const folder = node.kind === 'root' || node.kind === 'folder';
    // TreeItemLabel.highlights はテーマ次第で背景色が付き、FileDecoration の状態色を隠すため使わない。
    // 太字だけを指定する API はないので、変更ファイルのラベルは文字列のまま渡す。
    const item = new vscode.TreeItem(
      node.kind === 'root'
        ? node.empty
          ? '変更前（親なし）'
          : `${node.side === 'old' ? '変更前' : '変更後'} ${shortHash(node.rev)}`
        : posix.basename(node.path),
      folder && !root.empty ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = JSON.stringify([comparisonKey(root.snapshot.target), root.side, node.kind, node.path]);
    item.iconPath = folder ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    const status = folder ? folderStatus(node.path, root.snapshot.changes[root.side]) : this.change(node)?.status;
    item.tooltip = statusLabel(node.path || root.snapshot.target.repo, status);
    item.accessibilityInformation = { label: item.tooltip };
    item.resourceUri = statusUri({
      repo: root.snapshot.target.repo,
      commit: root.snapshot.target.commit.hash,
      side: root.side,
      kind: folder ? 'folder' : 'file',
      path: node.path,
      status,
    });
    if (node.kind !== 'root' && node.kind !== 'folder') {
      const change = this.change(node);
      const active = this.active;
      const opened =
        root.snapshot === this.current &&
        active &&
        !fileSide(active.file, root.side).empty &&
        !root.empty &&
        fileSide(active.file, root.side).path === node.path;
      item.description = [
        change?.oldPath ? (root.side === 'old' ? change.path : change.oldPath) : undefined,
        opened ? '開いているファイル' : undefined,
        node.kind === 'gitlink' ? 'サブモジュール（開けません）' : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      if (node.kind !== 'gitlink') {
        item.command = {
          command: change ? 'vsreview.openDiff' : 'vsreview.openRevisionFile',
          title: change ? '差分を開く' : 'ファイルを開く',
          arguments: [change ? { ...root.snapshot.target, file: change } : node],
        };
      }
    }
    return item;
  }
  async open(argument: unknown): Promise<void> {
    if (!isRecord(argument) || !this.nodes.has(argument)) {
      return;
    }
    const node = argument as unknown as FileNode;
    if (node.kind !== 'file' || node.root.snapshot !== this.current) {
      return;
    }
    const siblings = await this.getChildren(node.parent);
    if (!siblings.includes(node)) {
      return;
    }
    // 未変更ファイルも既存のコメント形式・URIを使うため、両側が存在する M として扱う。
    const target: FileTarget = { ...node.root.snapshot.target, file: { path: node.path, status: 'M' } };
    const show = async () => {
      await vscode.window.showTextDocument(await this.documents.revisionFileUri(revisionRef(target, node.root.side)), {
        preview: false,
      });
    };
    await this.archives.withLease(show);
  }
  private async find(root: FileRoot, path: string): Promise<FileNode | undefined> {
    const parts = path.split('/');
    let node: Promise<FileNode | undefined> = Promise.resolve(root);
    // 祖先パスは既知なので Git は並列に呼ぶ。VS Code の reveal が親を辿れるよう、親ノードの参照を共有する。
    for (let index = 0; index < parts.length; index++) {
      const folder = parts.slice(0, index).join('/');
      const childPath = parts.slice(0, index + 1).join('/');
      node = this.children(root, folder, node).then((children) => children.find((child) => child.path === childPath));
    }
    return node;
  }

  private async reveal(nodes: (FileNode | undefined)[], side: FileSide, generation: number): Promise<void> {
    const ordered = nodes
      .filter((node): node is FileNode => Boolean(node))
      .sort((a, b) => Number(this.root(a).side === side) - Number(this.root(b).side === side));
    // 後の reveal が選択を上書きするため、フォーカス側を最後にする。
    for (const node of ordered) {
      if (this.disposed || generation !== this.generation || !this.view.visible) {
        return;
      }
      await this.view.reveal(node, { select: this.root(node).side === side, focus: false, expand: true });
    }
  }
  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.snapshots.clear();
    this.disposables.forEach((d) => {
      d.dispose();
    });
    this.treeDataChanged.dispose();
  }
}
