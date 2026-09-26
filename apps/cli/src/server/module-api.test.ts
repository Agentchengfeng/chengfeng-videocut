import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createModuleApi, validateModuleManifest, checkResources } from './module-api';
import { readModuleFile } from '@video-workbench/core/node';
import { createVideocutVisualsHandler } from '../../../studio/src/server/videocutVisualsApi';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const make = (s = '<html>ok</html>') => ({ manifest: { schemaVersion: 1, moduleId: 'bird', version: 'v1', entry: 'index.html', files: [{ path: 'index.html', sha256: hash(s), bytes: Buffer.byteLength(s) }] }, files: { 'index.html': Buffer.from(s).toString('base64') } });
test('package references use portable URL paths and reject escaping the root', () => {
    const m = validateModuleManifest(make().manifest);
    m.files.push({ path: 'nested/scene.mjs', sha256: 'a'.repeat(64), bytes: 0 });
    expect(() => checkResources('nested/scene.mjs', Buffer.from("fetch('../index.html'); import './scene.mjs';"), m)).not.toThrow();
    expect(() => checkResources('nested/scene.mjs', Buffer.from("fetch('../../index.html')"), m)).toThrow();
});
test('module manifest rejects missing types, unsafe identities, reserved files and limits', () => {
    for (const patch of [{ moduleId: undefined }, { version: 4 }, { moduleId: '../bird' }, { files: [null] }, { files: [{ path: 'module-manifest.json', bytes: 1, sha256: 'a'.repeat(64) }] }, { files: [{ path: '%2e%2e/a.html', bytes: 1, sha256: 'a'.repeat(64) }] }, { files: Array(33).fill(make().manifest.files[0]) }])
        expect(() => validateModuleManifest({ ...make().manifest, ...patch })).toThrow();
});
test('atomic module publication is bounded, closed, immutable and symlink-safe', async () => {
    const root = await mkdtemp('/private/tmp/module-api-test-');
    const project = join(root, 'demo');
    await mkdir(project);
    await writeFile(join(project, 'project.json'), JSON.stringify({ jobId: 'demo' }));
    const api = createModuleApi(root, 1234);
    const call = async (body: any, path = '', method = 'POST') => api(new Request('http://127.0.0.1:1234/api/v1/projects/demo/module-packages' + path, { method, headers: { host: '127.0.0.1:1234' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), '127.0.0.1');
    try {
        for (const text of ['<script src="https://evil.test/x.js"></script>', '<base href="./">', '<img src="../index.html">'])
            expect((await call(make(text)))?.status).toBe(400);
        const bad = make();
        bad.manifest.files[0]!.sha256 = '0'.repeat(64);
        expect((await call(bad))?.status).toBe(400);
        expect(await readdir(project)).toEqual(['project.json']);
        const missing = { ...make(), files: {} };
        expect((await call(missing))?.status).toBe(400);
        for (const patch of [{ moduleId: 'con' }, { version: 'nul' }, { files: [{ path: 'aux.html', sha256: hash('x'), bytes: 1 }] }, { files: [{ path: 'index.html', sha256: hash('x'), bytes: 512 * 1024 + 1 }] }]) {
            expect(() => validateModuleManifest({ ...make().manifest, ...patch })).toThrow();
        }
        const concurrent = await Promise.all([call(make()), call(make())]);
        expect(concurrent.map(r => r?.status)).toEqual([200, 200]);
        expect((await call(make('<html>changed</html>')))?.status).toBe(409);
        const visual = createVideocutVisualsHandler({ projectsDir: root });
        await writeFile(join(project, 'transcript.json'), '{"secret":"not public"}');
        for (const origin of ['null', 'http://evil.test']) {
            const r = await visual(new Request('http://127.0.0.1:1234/api/v1/projects/demo/visuals/module/transcript.json', { headers: { origin } }));
            expect(r?.headers.has('access-control-allow-origin')).toBe(false);
        }
        const published = await visual(new Request('http://127.0.0.1:1234/api/v1/projects/demo/visuals/module/modules/published/bird/v1/index.html'));
        expect(published?.headers.get('access-control-allow-origin')).toBe('*');
        expect(await readFile(join(project, 'modules/published/bird/v1/index.html'), 'utf8')).toBe('<html>ok</html>');
        expect((await readdir(join(project, 'modules/published/bird')))).toEqual(['v1']);
        await symlink(root, join(project, 'modules/published/linked'));
        const linked = make(); linked.manifest.moduleId = 'linked';
        expect((await call(linked))?.status).toBe(400);
        expect((await readdir(root)).includes('v1')).toBe(false);
        const raw = JSON.parse(await readFile(join(project, 'modules/published/bird/v1/module-manifest.json'), 'utf8'));
        raw.moduleId = 'other';
        await writeFile(join(project, 'modules/published/bird/v1/module-manifest.json'), JSON.stringify(raw));
        expect((await call(null, '/bird/v1', 'GET'))?.status).toBe(400);
        await writeFile(join(root, 'outside.html'), 'secret');
        await symlink(join(root, 'outside.html'), join(project, 'escape.html'));
        await expect(readModuleFile(project, 'escape.html')).rejects.toThrow();
        await symlink(root, join(project, 'outside'));
        await expect(readModuleFile(project, 'outside/outside.html')).rejects.toThrow();
        await writeFile(join(project, '旧模块.html'), 'ok');
        expect((await readModuleFile(project, '旧模块.html')).toString()).toBe('ok');
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
