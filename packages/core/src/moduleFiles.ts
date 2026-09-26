import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
/** No symlinks beneath a trusted project root. Bounded reads with opened-file identity checks. */
export async function readModuleFile(root: string, path: string, limit = 16 * 1024 * 1024): Promise<Buffer> {
    if (!path || path.startsWith('/') || /^[a-z]+:/i.test(path) || /[\\\x00-\x1f]/.test(path) || path.split('/').some(p => p === '.' || p === '..' || !p))
        throw Error('Invalid module path');
    const base = await realpath(root);
    let current = base;
    const parts = path.split('/');
    for (const [i, part] of parts.entries()) {
        current = resolve(current, part);
        const s = await lstat(current);
        if (s.isSymbolicLink() || (i < parts.length - 1 && !s.isDirectory()))
            throw Error('Module symlink or non-directory rejected');
    }
    const before = await lstat(current);
    if (!before.isFile() || before.size > limit)
        throw Error('Module file is not bounded regular file');
    const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const s = await file.stat();
        if (!s.isFile() || s.size > limit || s.dev !== before.dev || s.ino !== before.ino)
            throw Error('Module changed during read');
        const actual = await realpath(current);
        if (!actual.startsWith(base + sep))
            throw Error('Module escaped project');
        const bytes = Buffer.alloc(limit + 1);
        let used = 0;
        while (used < bytes.length) {
            const r = await file.read(bytes, used, bytes.length - used, null);
            if (!r.bytesRead)
                break;
            used += r.bytesRead;
        }
        if (used > limit)
            throw Error('Module exceeds limit');
        return bytes.subarray(0, used);
    }
    finally {
        await file.close();
    }
}
