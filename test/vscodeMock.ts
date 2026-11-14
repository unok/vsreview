import type * as VSCode from 'vscode';
import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';
import { matchesGlob, relative } from 'node:path';
export class EventEmitter<T> {
  private listeners = new Set<(value: T) => unknown>();
  readonly event = (listener: (value: T) => unknown): VSCode.Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  async fireAsync(value: T): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(value)));
  }
  dispose(): void {
    this.listeners.clear();
  }
}
export class Uri {
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = '',
  ) {}
  get fsPath(): string {
    return this.path;
  }
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static from(value: { scheme: string; path?: string; query?: string }): Uri {
    return new Uri(value.scheme, value.path ?? '', value.query ?? '');
  }
  toString(): string {
    return `${this.scheme}:${this.path}?${this.query}`;
  }
}
export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: number | Position, end: number | Position, endLine?: number, endCharacter?: number) {
    this.start = start instanceof Position ? start : new Position(start, end as number);
    this.end = end instanceof Position ? end : new Position(endLine!, endCharacter!);
  }
}
export class Selection extends Range {
  readonly active: Position;
  constructor(start: Position, end: Position) {
    super(start.line, start.character, end.line, end.character);
    this.active = end;
  }
}
export class Location {
  constructor(
    readonly uri: VSCode.Uri,
    readonly range: VSCode.Range,
  ) {}
}
export class Hover {
  constructor(
    readonly contents: unknown[],
    readonly range?: VSCode.Range,
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class ThemeIcon {
  static readonly Folder = new ThemeIcon('folder');
  static readonly File = new ThemeIcon('file');
  constructor(readonly id: string) {}
}
export class TreeItem {
  constructor(
    public label: string | VSCode.TreeItemLabel,
    public collapsibleState = 0,
  ) {}
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const CommentMode = { Editing: 0, Preview: 1 };
export const CommentThreadState = { Unresolved: 0, Resolved: 1 };
export const TextEditorRevealType = { InCenter: 0 };
export class TabInputTextDiff {
  constructor(
    readonly original: VSCode.Uri,
    readonly modified: VSCode.Uri,
  ) {}
}
export class TabInputText {
  constructor(readonly uri: VSCode.Uri) {}
}
export const disposedThreads = new Set<VSCode.CommentThread>();
export const threads: VSCode.CommentThread[] = [];
export const docs: VSCode.TextDocument[] = [];
export const cancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
export const input = vi.fn<() => Promise<string | undefined>>();
export const warning = vi.fn<() => Promise<string | undefined>>();
export const pick = vi.fn<(...args: unknown[]) => Promise<unknown>>();
export const documentOpened = new EventEmitter<VSCode.TextDocument>();
export const documentClosed = new EventEmitter<VSCode.TextDocument>();
export const documentChanged = new EventEmitter<VSCode.TextDocumentChangeEvent>();
export const documentSaved = new EventEmitter<VSCode.TextDocument>();
export const editorChanged = new EventEmitter<VSCode.TextEditor | undefined>();
export const tabsChanged = new EventEmitter<unknown>();
export const tabGroupsChanged = new EventEmitter<unknown>();
const rangeRequests: Promise<unknown>[] = [];
export async function settleRangeRequests(): Promise<void> {
  const results = await Promise.all(rangeRequests.splice(0));
  const errors = results.filter(
    (result): result is { error: unknown } => typeof result === 'object' && result !== null && 'error' in result,
  );
  if (errors.length) {
    throw new AggregateError(
      errors.map(({ error }) => error),
      'コメント範囲の問い合わせに失敗しました',
    );
  }
}
// VS Code は非表示文書の範囲問い合わせを表示時まで遅らせる。
export const hiddenRangeDocuments = new Set<string>();
export const rangeProviderAssigned = vi.fn();
let rangeProvider: VSCode.CommentingRangeProvider | undefined;
export const controller = {
  get commentingRangeProvider(): VSCode.CommentingRangeProvider | undefined {
    return rangeProvider;
  },
  set commentingRangeProvider(provider: VSCode.CommentingRangeProvider | undefined) {
    rangeProviderAssigned();
    rangeProvider = provider;
    // VS Code はプロバイダの再登録で開いている文書のコメントを再計算する。
    for (const doc of docs) {
      if (provider && !hiddenRangeDocuments.has(doc.uri.toString())) {
        rangeRequests.push(
          Promise.resolve(provider.provideCommentingRanges(doc, cancellationToken)).catch((error: unknown) => ({
            error,
          })),
        );
      }
    }
  },
  createCommentThread: vi.fn(
    (uri: VSCode.Uri, range: VSCode.Range, comments: readonly VSCode.Comment[]): VSCode.CommentThread => {
      const thread: VSCode.CommentThread = {
        uri,
        range,
        comments,
        collapsibleState: 1,
        canReply: true,
        dispose: () => {
          disposedThreads.add(thread);
        },
      };
      threads.push(thread);
      return thread;
    },
  ),
  dispose: vi.fn(),
};
export const comments = { createCommentController: vi.fn(() => controller) };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const globalConfiguration = new Map<string, unknown>();
export const workspaceFolderConfiguration = new Map<string, Map<string, unknown>>();
export const workspaceConfiguration = new Map<string, unknown>();
export const foldersChanged = new EventEmitter<VSCode.WorkspaceFoldersChangeEvent>();
export const configurationChanged = new EventEmitter<VSCode.ConfigurationChangeEvent>();
export const windowChanged = new EventEmitter<VSCode.WindowState>();
const contentProviders = new Map<string, VSCode.TextDocumentContentProvider>();
export function textDocument(uri: VSCode.Uri, text: string, dirty = false): VSCode.TextDocument {
  const lines = text.split(/\r?\n/);
  const doc = {
    uri,
    isDirty: dirty,
    isUntitled: uri.scheme === 'untitled',
    languageId: uri.path.endsWith('.ts') ? 'typescript' : 'plaintext',
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line: number) => {
      if (!Number.isInteger(line) || line < 0 || line >= lines.length) {
        throw new RangeError('line out of range');
      }
      return { text: lines[line] };
    },
    version: 1,
    positionAt: (offset: number) => {
      const prefix = text.slice(0, offset).split('\n');
      return new Position(prefix.length - 1, prefix.at(-1)?.length ?? 0);
    },
  } as VSCode.TextDocument;
  return doc;
}
export class RelativePattern {
  constructor(
    readonly baseUri: Uri,
    readonly pattern: string,
  ) {}
}
export class FileSystemWatcher {
  readonly changed = new EventEmitter<Uri>();
  readonly created = new EventEmitter<Uri>();
  readonly deleted = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;
  readonly onDidCreate = this.created.event;
  readonly onDidDelete = this.deleted.event;
  disposed = false;
  constructor(readonly pattern: RelativePattern) {}
  dispose(): void {
    this.disposed = true;
    this.changed.dispose();
    this.created.dispose();
    this.deleted.dispose();
  }
}
export const watchers: FileSystemWatcher[] = [];
export const workspace = {
  onDidChangeWorkspaceFolders: foldersChanged.event,
  onDidChangeConfiguration: configurationChanged.event,
  registerTextDocumentContentProvider: (scheme: string, provider: VSCode.TextDocumentContentProvider) => {
    contentProviders.set(scheme, provider);
    return {
      dispose: () => {
        contentProviders.delete(scheme);
      },
    };
  },
  workspaceFolders: [] as VSCode.WorkspaceFolder[],
  textDocuments: docs,
  createFileSystemWatcher: (pattern: RelativePattern) => {
    const watcher = new FileSystemWatcher(pattern);
    watchers.push(watcher);
    return watcher;
  },
  getConfiguration: (section?: string, resource?: VSCode.Uri) => {
    const fullKey = (key: string) => (section ? `${section}.${key}` : key);
    const resourceValues = resource ? workspaceFolderConfiguration.get(resource.toString()) : undefined;
    return {
      update: (key: string, value: unknown, target?: number) => {
        (target === ConfigurationTarget.Global
          ? globalConfiguration
          : target === ConfigurationTarget.WorkspaceFolder
            ? resourceValues
            : workspaceConfiguration
        )?.set(fullKey(key), value);
        configurationChanged.fire({ affectsConfiguration: (name) => name === fullKey(key) });
        return Promise.resolve();
      },
      inspect: (key: string) => ({
        globalValue: globalConfiguration.get(fullKey(key)),
        workspaceValue: workspaceConfiguration.get(fullKey(key)),
        workspaceFolderValue: resourceValues?.get(fullKey(key)),
      }),
      get: <T>(key: string, fallback?: T): T | undefined =>
        (resourceValues?.get(fullKey(key)) ??
          workspaceConfiguration.get(fullKey(key)) ??
          globalConfiguration.get(fullKey(key)) ??
          fallback) as T | undefined,
    };
  },
  onDidOpenTextDocument: documentOpened.event,
  onDidCloseTextDocument: documentClosed.event,
  onDidChangeTextDocument: documentChanged.event,
  onDidSaveTextDocument: documentSaved.event,
  openTextDocument: async (value: VSCode.Uri | { content: string; language: string }): Promise<VSCode.TextDocument> => {
    if ('content' in value) {
      const doc = textDocument(Uri.from({ scheme: 'untitled', path: `/${docs.length}` }) as VSCode.Uri, value.content);
      docs.push(doc);
      documentOpened.fire(doc);
      return doc;
    }
    const existing = docs.find((doc) => doc.uri.toString() === value.toString());
    if (existing) {
      return existing;
    }
    if (value.scheme !== 'file') {
      const provider = contentProviders.get(value.scheme);
      if (!provider) {
        throw new Error('Missing test document');
      }
      const doc = textDocument(value, (await provider.provideTextDocumentContent(value, cancellationToken)) ?? '');
      docs.push(doc);
      documentOpened.fire(doc);
      return doc;
    }
    const doc = textDocument(value, await readFile(value.fsPath, 'utf8'));
    docs.push(doc);
    documentOpened.fire(doc);
    return doc;
  },
};
const activeGroup = { activeTab: undefined as { input: unknown } | undefined, tabs: [] as { input: unknown }[] };
export const window = {
  activeTextEditor: undefined as VSCode.TextEditor | undefined,
  tabGroups: {
    activeTabGroup: activeGroup,
    all: [activeGroup],
    onDidChangeTabs: tabsChanged.event,
    onDidChangeTabGroups: tabGroupsChanged.event,
  },
  onDidChangeActiveTextEditor: editorChanged.event,
  onDidChangeWindowState: windowChanged.event,
  createTreeView: vi.fn((id: string, options: { treeDataProvider: VSCode.TreeDataProvider<unknown> }) => {
    const visibilityChanged = new EventEmitter<VSCode.TreeViewVisibilityChangeEvent>();
    const elementCollapsed = new EventEmitter<VSCode.TreeViewExpansionEvent<unknown>>();
    return {
      id,
      options,
      visible: false,
      message: undefined as string | undefined,
      selection: [] as unknown[],
      reveal: vi
        .fn<
          (node: unknown, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }) => Promise<void>
        >()
        .mockResolvedValue(undefined),
      elementCollapsed,
      onDidCollapseElement: elementCollapsed.event,
      visibilityChanged,
      onDidChangeVisibility: visibilityChanged.event,
      setVisible(visible: boolean) {
        this.visible = visible;
        visibilityChanged.fire({ visible });
      },
      dispose() {
        visibilityChanged.dispose();
        elementCollapsed.dispose();
      },
    };
  }),
  showInputBox: input,
  showWarningMessage: warning,
  showQuickPick: pick,
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  setStatusBarMessage: vi.fn(),
  registerFileDecorationProvider: vi.fn<(provider: VSCode.FileDecorationProvider) => VSCode.Disposable>(() => ({
    dispose() {},
  })),
  showTextDocument: vi.fn(async (doc: VSCode.TextDocument | VSCode.Uri) => {
    const document = 'scheme' in doc ? await workspace.openTextDocument(doc) : doc;
    window.activeTextEditor = {
      document,
      selection: new Selection(new Position(0, 0), new Position(0, 0)),
      revealRange: vi.fn(),
    } as unknown as VSCode.TextEditor;
    return window.activeTextEditor;
  }),
};
const handlers = new Map<string, (...args: unknown[]) => unknown>();
export const commands = {
  registerCommand: (name: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(name, fn);
    return {
      dispose: () => {
        handlers.delete(name);
      },
    };
  },
  executeCommand: vi.fn((name: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(name)?.(...args)),
  ),
};
export const env = {
  clipboard: { writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined), readText: vi.fn() },
};
export const providers = new Map<string, unknown>();
function registerProvider(name: string, value: unknown): VSCode.Disposable {
  providers.set(name, value);
  return {
    dispose: () => {
      providers.delete(name);
    },
  };
}
export const languages = {
  registerDefinitionProvider: (_selector: unknown, value: unknown) => registerProvider('definition', value),
  registerReferenceProvider: (_selector: unknown, value: unknown) => registerProvider('reference', value),
  registerImplementationProvider: (_selector: unknown, value: unknown) => registerProvider('implementation', value),
  registerTypeDefinitionProvider: (_selector: unknown, value: unknown) => registerProvider('typeDefinition', value),
  registerHoverProvider: (_selector: unknown, value: unknown) => registerProvider('hover', value),
};
export function activateTab(input: unknown): void {
  activeGroup.activeTab = { input };
  activeGroup.tabs = [activeGroup.activeTab];
  tabsChanged.fire(undefined);
}
export function resetVscode(): void {
  hiddenRangeDocuments.clear();
  vi.clearAllMocks();
  controller.commentingRangeProvider = undefined;
  window.tabGroups.all.splice(0, window.tabGroups.all.length, activeGroup);
  input.mockReset();
  warning.mockReset();
  pick.mockReset();
  commands.executeCommand.mockReset();
  commands.executeCommand.mockImplementation((name, ...args) => Promise.resolve(handlers.get(name)?.(...args)));
  disposedThreads.clear();
  threads.length = 0;
  docs.length = 0;
  globalConfiguration.clear();
  workspaceConfiguration.clear();
  workspaceFolderConfiguration.clear();
  contentProviders.clear();
  foldersChanged.dispose();
  configurationChanged.dispose();
  windowChanged.dispose();
  globalConfiguration.set('vsreview.autoRefresh', true);
  for (const watcher of watchers.splice(0)) {
    watcher.dispose();
  }
  providers.clear();
  handlers.clear();
  documentOpened.dispose();
  documentClosed.dispose();
  documentChanged.dispose();
  documentSaved.dispose();
  editorChanged.dispose();
  tabsChanged.dispose();
  tabGroupsChanged.dispose();
  workspace.workspaceFolders = [];
  activeGroup.tabs = [];
  activeGroup.activeTab = undefined;
  window.activeTextEditor = undefined;
}

export function emitFileEvent(path: string, kind: 'changed' | 'created' | 'deleted' = 'changed'): void {
  for (const watcher of watchers) {
    if (!watcher.disposed && matchesGlob(relative(watcher.pattern.baseUri.fsPath, path), watcher.pattern.pattern)) {
      watcher[kind].fire(Uri.file(path));
    }
  }
}
