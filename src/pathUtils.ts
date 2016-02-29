import * as path from 'path';

export function normalizePath(baseDirPath: string, rootFilePath: string, relativeFilePath: string): string {
    let p = path.join(path.dirname(rootFilePath), relativeFilePath);
    return path.relative(baseDirPath || '', p);
}

export function resolveRelatioveStateFilePath(baseDirPath: string, relativePath: string) {
    return path.relative(baseDirPath, relativePath);
}