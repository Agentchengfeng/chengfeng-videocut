import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, posix } from 'node:path';
import { readModuleFile, resolveProject, serializeProjectOperation } from '@video-workbench/core/node';
import { isLoopbackAddress, trustedLoopbackOrigin } from './jobs-api';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const portable = (path: string) => path.split('/').every(p => !p.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
const PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*\.(html|js|mjs|css|svg|json|png|jpg|jpeg|webp|woff2)$/;
type Manifest = {
    schemaVersion: 1;
    moduleId: string;
    version: string;
    entry: string;
    files: {
        path: string;
        sha256: string;
        bytes: number;
    }[];
};
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function invalid(message: string): never { throw Object.assign(Error(message), { status: 400 }); }
export function validateModuleManifest(raw: any): Manifest {
    if (raw?.schemaVersion !== 1 || typeof raw.moduleId !== 'string' || typeof raw.version !== 'string' || !ID.test(raw.moduleId) || !ID.test(raw.version) || !portable(raw.moduleId) || !portable(raw.version) || typeof raw.entry !== 'string' || !raw.entry.endsWith('.html') || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 32)
        invalid('Invalid module manifest');
    const seen = new Set<string>();
    let total = 0;
    const files = raw.files.map((f: any) => { if (!f || typeof f.path !== 'string' || !PATH.test(f.path) || !portable(f.path) || f.path.toLowerCase() === 'module-manifest.json' || f.path.split('/').some((p: string) => p === '.' || p === '..') || seen.has(f.path.toLowerCase()) || !Number.isInteger(f.bytes) || f.bytes < 0 || f.bytes > 512 * 1024 || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256))
        invalid('Invalid module file declaration'); seen.add(f.path.toLowerCase()); total += f.bytes; return { path: f.path, sha256: f.sha256, bytes: f.bytes }; }).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (total > 2 * 1024 * 1024 || !files.some((f: any) => f.path === raw.entry))
        invalid('Module entry missing or package too large');
    return { schemaVersion: 1, moduleId: raw.moduleId, version: raw.version, entry: raw.entry, files };
}
export function checkResources(path: string, bytes: Buffer, manifest: Manifest) {
    if (!/\.(html|css|js|mjs|svg)$/.test(path))
        return;
    const text = bytes.toString('utf8');
    const refs: string[] = [];
    if (/<base\b/i.test(text))
        invalid('HTML base is forbidden');
    for (const re of [/(?:src|href)\s*=\s*["']([^"']+)["']/g, /\b(?:from|import)\s*["']([^"']+)["']/g, /(?:fetch|import)\s*\(\s*["']([^"']+)["']/g, /url\(\s*["']?([^\s'"()]+)["']?\s*\)/g])
        for (const m of text.matchAll(re))
            refs.push(m[1]!);
    for (const ref of refs) {
        if (ref.startsWith('#'))
            continue;
        if (ref.includes('%') || ref.includes('\\') || ref.startsWith('/') || /^[a-z]+:/i.test(ref))
            invalid('External or encoded module resource rejected');
        const relative = ref.replace(/[?#].*$/, '');
        const target = posix.resolve('/package', posix.dirname(path), relative);
        if (!target.startsWith('/package/') || !manifest.files.some(f => f.path === target.slice(9)))
            invalid('Module resource is not in manifest: ' + ref);
    }
}
async function safeDirectories(root: string, parts: string[]) { let current = await realpath(root); for (const part of parts) {
    current = resolve(current, part);
    try {
        await mkdir(current);
    }
    catch (e: any) {
        if (e.code !== 'EEXIST')
            throw e;
    }
    const s = await lstat(current);
    if (s.isSymbolicLink() || !s.isDirectory())
        invalid('Module parent must be a real directory');
} return current; }
async function boundedBody(request: Request) { const reader = request.body?.getReader(); if (!reader)
    invalid('Body required'); const chunks: Uint8Array[] = []; let size = 0; let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel(); reject(Error('Module body timeout')); }, 5000); }); try {
    for (;;) {
        const r = await Promise.race([reader.read(), timeout]);
        if (r.done)
            break;
        size += r.value.length;
        if (size > 4 * 1024 * 1024) {
            void reader.cancel();
            invalid('Package request too large');
        }
        chunks.push(r.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
finally {
    clearTimeout(timer);
} }
export function createModuleApi(projectsDir: string, port: number) {
    return async (request: Request, client?: string): Promise<Response | null> => {
        const url = new URL(request.url), match = /^\/api\/v1\/projects\/([^/]+)\/module-packages(?:\/([a-z0-9_-]+)\/([a-z0-9_-]+))?$/.exec(url.pathname);
        if (!match)
            return null;
        const origin = trustedLoopbackOrigin(request.headers.get('host'), port);
        if (!client || !isLoopbackAddress(client) || !origin || url.origin !== origin || (request.headers.has('origin') && request.headers.get('origin') !== origin))
            return Response.json({ error: { code: 'origin_forbidden' } }, { status: 403 });
        try {
            const id = decodeURIComponent(match[1]!);
            if (!id || /[\\/\0]/.test(id) || id === '.' || id === '..')
                invalid('Invalid project');
            const project = await resolveProject(resolve(projectsDir, id));
            let manifest: Manifest | undefined;
            let incoming: Record<string, Buffer> | undefined;
            if (request.method === 'POST' && !match[2]) {
                const body = await boundedBody(request);
                manifest = validateModuleManifest(body.manifest);
                incoming = {};
                if (!body.files || Object.keys(body.files).length !== manifest.files.length)
                    invalid('Files do not match manifest');
                for (const f of manifest.files) {
                    const encoded = body.files[f.path];
                    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
                        invalid('Invalid base64');
                    const b = Buffer.from(encoded, 'base64');
                    if (b.length !== f.bytes || hash(b) !== f.sha256)
                        invalid('Module hash mismatch');
                    checkResources(f.path, b, manifest);
                    incoming[f.path] = b;
                }
            }
            else if (!(request.method === 'GET' && match[2] && ID.test(match[2]) && ID.test(match[3]!)))
                throw Object.assign(Error('Method not allowed'), { status: 405 });
            const result = await serializeProjectOperation(project.directory, async () => {
                if (!manifest) {
                    manifest = validateModuleManifest(JSON.parse((await readModuleFile(project.directory, `modules/published/${match[2]}/${match[3]}/module-manifest.json`, 65536)).toString()));
                    if (manifest.moduleId !== match[2] || manifest.version !== match[3])
                        invalid('Stored manifest identity mismatch');
                }
                const prefix = `modules/published/${manifest.moduleId}/${manifest.version}`;
                if (incoming) {
                    const parent = await safeDirectories(project.directory, ['modules', 'published', manifest.moduleId]);
                    const target = resolve(parent, manifest.version);
                    let exists = false;
                    try {
                        await lstat(target);
                        exists = true;
                    }
                    catch (e: any) {
                        if (e.code !== 'ENOENT')
                            throw e;
                    }
                    if (exists) {
                        const old = validateModuleManifest(JSON.parse((await readModuleFile(project.directory, `${prefix}/module-manifest.json`)).toString()));
                        if (JSON.stringify(old) !== JSON.stringify(manifest))
                            throw Object.assign(Error('Module version conflict'), { status: 409 });
                    }
                    else {
                        const staging = await mkdtemp(resolve(parent, '.staging-'));
                        try {
                            for (const f of manifest.files) {
                                await mkdir(dirname(resolve(staging, f.path)), { recursive: true });
                                await writeFile(resolve(staging, f.path), incoming[f.path]!, { flag: 'wx' });
                            }
                            await writeFile(resolve(staging, 'module-manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
                            await rename(staging, target);
                        }
                        finally {
                            await rm(staging, { recursive: true, force: true });
                        }
                    }
                }
                for (const f of manifest.files) {
                    const b = await readModuleFile(project.directory, `${prefix}/${f.path}`, 512 * 1024);
                    if (b.length !== f.bytes || hash(b) !== f.sha256)
                        throw Object.assign(Error('Published module changed'), { status: 409 });
                }
                return { schemaVersion: 1, projectId: id, manifest, entryPath: `${prefix}/${manifest.entry}`, digest: hash(JSON.stringify(manifest)), files: manifest.files.map(f => ({ ...f, url: `${origin}/api/v1/projects/${encodeURIComponent(id)}/visuals/module/${prefix}/${f.path}` })) };
            });
            return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
        }
        catch (e: any) {
            return Response.json({ error: { code: e.status === 409 ? 'module_conflict' : 'module_invalid', message: e.message } }, { status: e.status ?? 400 });
        }
    };
}
