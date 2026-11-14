import type { ChangedFile } from './gitParsing';
import { compareNames } from './collections';

export type FileTreeNode =
  | { kind: 'file'; name: string; file: ChangedFile }
  | { kind: 'folder'; name: string; path: string; children: FileTreeNode[]; paths: string[] };

export function buildFileTree(files: readonly ChangedFile[], compact: boolean): FileTreeNode[] {
  interface Folder {
    folders: Map<string, Folder>;
    files: FileTreeNode[];
  }
  const folder = (): Folder => ({ folders: new Map(), files: [] });
  const root = folder();
  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop()!;
    let current = root;
    for (const part of parts) {
      let child = current.folders.get(part);
      if (!child) {
        child = folder();
        current.folders.set(part, child);
      }
      current = child;
    }
    current.files.push({ kind: 'file', name, file });
  }
  const compare = (a: { name: string }, b: { name: string }): number => compareNames(a.name, b.name);
  const children = (folder: Folder, prefix: string): FileTreeNode[] => {
    const folders = [...folder.folders].map(([name, child]): FileTreeNode => {
      const path = prefix ? `${prefix}/${name}` : name;
      const nodes = children(child, path);
      const only = nodes.length === 1 ? nodes[0] : undefined;
      return compact && only?.kind === 'folder'
        ? { ...only, name: `${name}/${only.name}` }
        : {
            kind: 'folder',
            name,
            path,
            children: nodes,
            paths: nodes.flatMap((node) => (node.kind === 'file' ? [node.file.path] : node.paths)),
          };
    });
    return [...folders.sort(compare), ...folder.files.sort(compare)];
  };
  return children(root, '');
}

export function flattenFileTree(nodes: readonly FileTreeNode[]): ChangedFile[] {
  return nodes.flatMap((node) => (node.kind === 'file' ? [node.file] : flattenFileTree(node.children)));
}
