import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { comparisonKey } from '../core/comparisons';
import { statusLabel } from '../core/decorations';
import type { DocumentRef } from '../core/documents';
import { EXPLANATION_SKIP_LABELS } from '../core/explanations';
import { escapeHtml, renderMarkdown } from '../core/markdown';
import { snapshotDateLabel } from '../core/presentation';
import { errorMessage } from './common';
import type { ReviewDocuments } from './documents';
import type { ExplanationQuery, ReviewExplanations } from './explanations';
import { NO_DIFF, resolveExplanationRef, type OpenDiff } from './reviewTargets';

type State = 'noDiff' | 'notDiff' | 'none' | 'loading' | 'explained' | 'skipped' | 'missing' | 'unreadable' | 'failed';
export interface ExplanationViewSnapshot {
  state: State;
  visible: boolean;
  comparison?: string;
  path?: string;
  generating: boolean;
  failure?: string;
  html: string;
}

const paragraph = (message: string) => `<p>${escapeHtml(message)}</p>`;
const LOADING = '解説を読み込み中';
const loadFailure = (message: string) => paragraph(`解説の読み込みに失敗しました。 ${message}`);

function content(ref: DocumentRef, query: ExplanationQuery): { state: State; body: string } {
  const { record, file } = query;
  switch (record.kind) {
    case 'found': {
      if (!file) {
        return { state: 'missing', body: paragraph('この比較の記録にないファイルです') };
      }
      if ('skipped' in file) {
        return { state: 'skipped', body: paragraph(EXPLANATION_SKIP_LABELS[file.skipped]) };
      }
      const { generatedAt, agent } = record.explanation;
      const metadata = paragraph(`${snapshotDateLabel(generatedAt)} · ${agent}`);
      return { state: 'explained', body: metadata + renderMarkdown(file.markdown) };
    }
    case 'loading':
      return { state: 'loading', body: paragraph(LOADING) };
    case 'failed':
      return { state: 'failed', body: loadFailure(record.message) };
    case 'unreadable': {
      const message = '保存した解説を読み込めません。右クリックの「解説を生成」で作り直してください';
      return { state: 'unreadable', body: paragraph(message) };
    }
    case 'none': {
      const node = ref.uncommitted ? '未コミットの区分' : ref.pullRequest ? 'PR のノード' : 'コミットのノード';
      const message = `この比較の解説はまだありません。${node}を右クリックし、「解説を生成」を選んでください`;
      return { state: 'none', body: query.generating ? '' : paragraph(message) };
    }
  }
}

export class ExplanationView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private snapshot: Omit<ExplanationViewSnapshot, 'visible'> | undefined;
  private nonce = '';
  private generation = 0;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly documents: ReviewDocuments,
    private readonly explanations: ReviewExplanations,
    private readonly persistent: boolean,
  ) {}

  get current(): ExplanationViewSnapshot | undefined {
    return this.snapshot && this.view && { ...this.snapshot, visible: this.view.visible };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    this.nonce = randomUUID();
    view.webview.options = { enableScripts: false, enableCommandUris: false, localResourceRoots: [] };
    this.subscriptions = [
      view.onDidChangeVisibility(() => this.synchronize()),
      view.onDidDispose(() => this.dispose()),
      this.explanations.onDidChange(() => this.synchronize()),
    ];
    void this.synchronize();
  }

  async synchronize(diffs?: readonly OpenDiff[]): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation && this.view?.visible;
    if (!current()) {
      return;
    }
    let ref: DocumentRef | undefined;
    try {
      ref = await resolveExplanationRef(this.documents, diffs ?? (await this.documents.openDiffs()));
      if (!current()) {
        return;
      }
      if (!ref) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const hasDocument = tab || vscode.window.activeTextEditor;
        const message =
          tab?.input instanceof vscode.TabInputTextDiff
            ? 'VSReview の差分ではないので解説なし'
            : '差分ではないので解説なし';
        this.render(hasDocument ? 'notDiff' : 'noDiff', paragraph(hasDocument ? message : NO_DIFF));
        return;
      }
      const { path } = ref.file;
      if (this.snapshot?.comparison !== comparisonKey(ref) || this.snapshot.path !== path) {
        this.render('loading', paragraph(LOADING), ref, this.explanations.isGenerating(ref));
      }
      await this.explanations.ensureLoaded(ref.repo);
      if (current()) {
        const query = this.explanations.explanation(ref, path);
        const { state, body } = content(ref, query);
        this.render(state, body, ref, query.generating, query.generating ? undefined : query.failure);
      }
    } catch (error) {
      if (current()) {
        this.render(
          'failed',
          loadFailure(errorMessage(error)),
          ref,
          ref !== undefined && this.explanations.isGenerating(ref),
        );
      }
    }
  }

  private render(state: State, body: string, ref?: DocumentRef, generating = false, failure?: string): void {
    const view = this.view!;
    const heading = ref ? `<h1>${escapeHtml(statusLabel(ref.file.path, ref.file.status))}</h1>` : '';
    const progress = generating ? paragraph('解説を生成中') : '';
    const error = failure === undefined ? '' : paragraph(`最後の解説生成に失敗しました。 ${failure}`);
    const memory = !this.persistent && state === 'explained' ? paragraph('解説は再起動で消えます') : '';
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${this.nonce}'; img-src 'none'; font-src 'none'; form-action 'none'">
<style nonce="${this.nonce}">
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow-wrap: anywhere; }
pre { overflow: auto; background: var(--vscode-textCodeBlock-background); }
</style></head><body>${heading}${progress}${error}${body}${memory}</body></html>`;
    // 同じ HTML を代入すると Webview が再読み込みされ、スクロール位置が失われる。
    if (view.webview.html !== html) {
      view.webview.html = html;
    }
    this.snapshot = {
      state,
      html,
      generating,
      ...(ref ? { comparison: comparisonKey(ref), path: ref.file.path } : {}),
      ...(failure === undefined ? {} : { failure }),
    };
  }

  dispose(): void {
    ++this.generation;
    this.view = undefined;
    this.snapshot = undefined;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }
}
