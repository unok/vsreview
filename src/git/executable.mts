import { constants, accessSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export function resolveExecutable(name: string, path = process.env.PATH ?? ''): string {
  for (const directory of path.split(delimiter)) {
    // 空要素や相対パスは cwd を探索に持ち込むため使わない。
    if (!isAbsolute(directory)) {
      continue;
    }
    const executable = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) {
        return executable;
      }
    } catch {
      // アクセス不能や非ファイルは実行候補から外す。
    }
  }
  throw new Error(`PATH に ${name === 'git' ? 'Git' : name} 実行ファイルが見つかりません`);
}
export function resolveGitExecutable(path = process.env.PATH ?? ''): string {
  return resolveExecutable('git', path);
}
let cachedGitExecutable: string | undefined;
export function gitExecutable(): string {
  return (cachedGitExecutable ??= resolveGitExecutable());
}

let cachedGhExecutable: string | undefined;
export function ghExecutable(): string {
  return (cachedGhExecutable ??= resolveExecutable('gh'));
}
