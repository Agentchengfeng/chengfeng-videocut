// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TimelineMarker } from '@video-workbench/core';
import { MarkerTrack, isMarkersChange } from './MarkerTrack';
import { runtimeProtection } from '../../runtime/activity';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const mocks = vi.hoisted(() => ({ listeners: new Set<(payload: unknown) => void>() }));
vi.mock('../../product/projectEvents', () => ({
  subscribeProjectFileChanges: (listener: (payload: unknown) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
}));
let root: Root | null;
let protectionSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  protectionSpy = vi.spyOn(runtimeProtection, 'set');
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  const keys = new Set(protectionSpy.mock.calls.map(call => call[0] as symbol));
  vi.restoreAllMocks();
  for (const key of keys) runtimeProtection.set(key, false);
  vi.unstubAllGlobals(); document.body.replaceChildren(); mocks.listeners.clear();
});
const marker = (id: string, start: number, label = '卡壳'): TimelineMarker => ({ id, start, duration: 0, label });
async function setup({ stale = false, time = 0, markers = [marker('stall-01', 3.5, '卡01 停顿0.05秒')] } = {}) {
  let persisted = { revision: 'r1', editRevision: 'e1', duration: 10, stale, document: { schemaVersion: 1, editRevision: stale ? 'e0' : 'e1', markers } };
  let failWrite = false;
  const writes: Array<{ expectedRevision: string; expectedEditRevision: string; document: typeof persisted.document }> = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (failWrite) return new Response(JSON.stringify({ error: { message: 'changed' } }), { status: 409 });
      persisted = { ...persisted, revision: `r${writes.length + 1}`, stale: false, document: body.document };
    }
    return new Response(JSON.stringify(persisted));
  });
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const seek = vi.fn();
  await act(async () => root!.render(<MarkerTrack projectId="test" editRevision="e1" time={time} onSeek={seek} pixelsPerSecond={100} displayContentWidth={1000} />));
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
  const flag = (id: string) => host.querySelector<HTMLElement>(`[data-marker="${id}"]`)!;
  const edit = (label: string, value: string) => act(() => {
    const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = async () => { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
  return { host, seek, button, flag, edit, submit, writes, fail: () => { failWrite = true; },
    replace: (next: TimelineMarker[]) => { persisted = { ...persisted, revision: 'r9', document: { ...persisted.document, markers: next } }; } };
}
const pointer = (type: string, x: number) => Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }), { pointerId: 1 });

it('draws each marker at its time with its label, and a click seeks there', async () => {
  const t = await setup();
  const flag = t.flag('stall-01');
  expect(flag.style.left).toBe('350px');
  expect(flag.textContent).toBe('卡01 停顿0.05秒');
  expect(t.host.querySelector('[data-markers-count]')!.getAttribute('data-markers-count')).toBe('1');
  flag.setPointerCapture = () => {};
  await act(async () => { flag.dispatchEvent(pointer('pointerdown', 400)); flag.dispatchEvent(pointer('pointerup', 400)); });
  expect(t.seek).toHaveBeenCalledWith(3.5);
  expect(t.writes).toHaveLength(0);
});

it('the flag button adds a marker at the playhead and opens it for naming', async () => {
  const t = await setup({ time: 6.4567 });
  await act(async () => t.host.querySelector<HTMLButtonElement>('[aria-label="在播放头处加标记"]')!.click());
  expect(t.writes).toHaveLength(1);
  const added = t.writes[0]!.document.markers.find(m => m.id !== 'stall-01')!;
  expect(added).toMatchObject({ start: 6.457, duration: 0, label: '标记 2' });
  expect(t.host.querySelector('dialog')!.open).toBe(true);
  // The flag writes millisecond times; the browser must not refuse them before the form submits.
  expect(t.host.querySelector('form')!.checkValidity()).toBe(true);
  t.edit('名称', '这里要补停顿');
  await t.submit();
  expect(t.writes.at(-1)!.document.markers.find(m => m.id === added.id)!.label).toBe('这里要补停顿');
  expect(t.host.querySelector('dialog')!.open).toBe(false);
});

it('dragging moves a marker and saves its new time; Delete removes it without reaching the timeline', async () => {
  const t = await setup();
  const flag = t.flag('stall-01');
  flag.setPointerCapture = () => {};
  await act(async () => { flag.dispatchEvent(pointer('pointerdown', 400)); flag.dispatchEvent(pointer('pointermove', 450)); flag.dispatchEvent(pointer('pointerup', 450)); });
  expect(t.writes[0]!.document.markers[0]!.start).toBe(4);
  expect(t.seek).not.toHaveBeenCalled();
  const outer = vi.fn(); document.addEventListener('keydown', outer);
  await act(async () => t.flag('stall-01').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
  document.removeEventListener('keydown', outer);
  expect(outer).not.toHaveBeenCalled();
  expect(t.writes.at(-1)!.document.markers).toEqual([]);
});

it('stale markers stay visible, and a save rebinds them to the current edit list', async () => {
  const t = await setup({ stale: true });
  expect(t.host.querySelector('[data-markers-stale]')!.getAttribute('data-markers-stale')).toBe('true');
  expect(t.flag('stall-01')).toBeTruthy();
  await act(async () => t.flag('stall-01').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  t.edit('名称', '改名');
  await t.submit();
  expect(t.writes[0]!.document.editRevision).toBe('e1');
  expect(t.writes[0]!.expectedEditRevision).toBe('e1');
});

it('a rejected save shows why and reloads instead of keeping a phantom marker', async () => {
  const t = await setup();
  t.fail();
  await act(async () => t.host.querySelector<HTMLButtonElement>('[aria-label="在播放头处加标记"]')!.click());
  expect(t.host.querySelector('[role="alert"]')!.textContent).toContain('重新载入');
  expect(t.host.querySelectorAll('[data-marker]')).toHaveLength(1);
  expect(runtimeProtection.read().dirty).toBe(false);
});

it('recognises Runtime change events for this project only', () => {
  expect(isMarkersChange(new MessageEvent('file-change', { data: JSON.stringify({ projectId: 'p', path: 'markers.json' }) }), 'p')).toBe(true);
  expect(isMarkersChange(new MessageEvent('file-change', { data: JSON.stringify({ projectId: 'q', path: 'markers.json' }) }), 'p')).toBe(false);
  expect(isMarkersChange(new MessageEvent('file-change', { data: JSON.stringify({ projectId: 'p', path: 'edit-list.json' }) }), 'p')).toBe(false);
  expect(isMarkersChange(new MessageEvent('file-change', { data: 'not json' }), 'p')).toBe(false);
  expect(isMarkersChange({ projectId: 'p', path: 'markers.json' }, 'p')).toBe(true);
});

it('reloads when the Runtime says markers.json changed (an Agent wrote them through the CLI)', async () => {
  const t = await setup();
  t.replace([marker('stall-01', 3.5), marker('stall-02', 7, '卡02')]);
  await act(async () => { for (const listener of mocks.listeners) listener({ projectId: 'other', path: 'markers.json' }); });
  expect(t.host.querySelectorAll('[data-marker]')).toHaveLength(1);
  await act(async () => { for (const listener of mocks.listeners) listener({ projectId: 'test', path: 'markers.json' }); });
  expect(t.host.querySelectorAll('[data-marker]')).toHaveLength(2);
  expect(t.flag('stall-02').style.left).toBe('700px');
});
