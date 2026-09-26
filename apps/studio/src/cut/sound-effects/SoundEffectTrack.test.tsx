// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SoundEffectCue } from '@video-workbench/core';
import { SoundEffectTrack } from './SoundEffectTrack';
import { runtimeProtection } from '../../runtime/activity';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
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
  vi.unstubAllGlobals(); document.body.replaceChildren();
});
const cue = (): SoundEffectCue => ({ id: 'cue-1', assetId: 'asset-1', label: 'ding.wav', start: 1, sourceIn: 0, sourceOut: 1, gainDb: -12, fadeIn: 0, fadeOut: .05, mute: false });
async function setup(stale = false) {
  let persisted = { revision: 'r1', editRevision: 'e1', duration: 10, stale, document: { schemaVersion: 1, editRevision: 'e1', cues: [cue()] } };
  let failWrite = false;
  let holdWrite: Promise<void> | null = null;
  const writes: Array<{ document: typeof persisted.document }> = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (holdWrite) await holdWrite;
      if (failWrite) return new Response(JSON.stringify({ error: { message: 'write failed' } }), { status: 409 });
      persisted = { ...persisted, revision: 'r2', stale: false, document: body.document };
    }
    return new Response(JSON.stringify(persisted));
  });
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const saved = vi.fn();
  await act(async () => root!.render(<SoundEffectTrack projectId="test" editRevision="e1" time={0} onSaved={saved} onSeek={() => {}} pixelsPerSecond={100} displayContentWidth={1000} />));
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
  const open = async () => { await act(async () => host.querySelector('[data-sfx-cue]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); };
  const edit = (label: string, value: string) => act(() => {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = async () => { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
  return { host, button, open, edit, submit, writes, saved, persisted: () => persisted,
    fail: () => { failWrite = true; }, hold: (promise: Promise<void>) => { holdWrite = promise; } };
}
function unmountClean() {
  expect(runtimeProtection.read().dirty).toBe(false);
  act(() => root!.unmount()); root = null;
  expect(runtimeProtection.read().dirty).toBe(false);
}

it('clears the deleted dialog draft only after successful persistence and stays clean on unmount', async () => {
  const ui = await setup(); await ui.open();
  expect(runtimeProtection.read().dirty).toBe(false);
  await act(async () => ui.button('删除音效').click());
  expect(ui.persisted().document.cues).toEqual([]); expect(ui.saved).toHaveBeenCalledTimes(1);
  expect(ui.host.querySelector('dialog')!.open).toBe(false);
  unmountClean();
});
it('reconciles saved property edits and a subsequent drag of the same cue', async () => {
  const ui = await setup(); await ui.open(); ui.edit('音量（dB）', '-6');
  expect(runtimeProtection.read().dirty).toBe(true);
  await ui.submit(); expect(ui.persisted().document.cues[0].gainDb).toBe(-6);
  expect(runtimeProtection.read().dirty).toBe(false);
  const element = ui.host.querySelector<HTMLElement>('[data-sfx-cue]')!;
  element.setPointerCapture = vi.fn();
  act(() => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, pointerId: 1 })));
  act(() => element.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, pointerId: 1 })));
  expect(runtimeProtection.read().dirty).toBe(true);
  await act(async () => element.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, pointerId: 1 })));
  expect(ui.persisted().document.cues[0].start).toBe(2); expect(ui.saved).toHaveBeenCalledTimes(2);
  unmountClean();
});
it('preserves failed submissions even if the dialog draft is explicitly cancelled', async () => {
  const ui = await setup(); await ui.open(); ui.edit('音量（dB）', '-6'); ui.fail();
  await ui.submit();
  expect(ui.persisted().document.cues[0].gainDb).toBe(-12); expect(ui.saved).not.toHaveBeenCalled();
  expect(runtimeProtection.read().dirty).toBe(true);
  act(() => ui.button('取消').click()); expect(runtimeProtection.read().dirty).toBe(true);
  act(() => root!.unmount()); root = null; expect(runtimeProtection.read().dirty).toBe(true);
});
it('protects stale pending deletion until a successful explicit rebind', async () => {
  const ui = await setup(true); await ui.open();
  await act(async () => ui.button('暂存删除').click());
  expect(ui.writes).toHaveLength(0); expect(runtimeProtection.read().dirty).toBe(true);
  // Cancelling a dialog must not clear the independent staged transaction.
  act(() => ui.button('取消').click()); expect(runtimeProtection.read().dirty).toBe(true);
  await act(async () => ui.button('保存并重新绑定').click());
  expect(ui.persisted().document.cues).toEqual([]); unmountClean();
});
it.each(['button', 'escape'])('explicit cancel via %s discards only the unsubmitted dialog draft', async mode => {
  const ui = await setup(); await ui.open(); ui.edit('音量（dB）', '-6');
  expect(runtimeProtection.read().dirty).toBe(true);
  act(() => {
    if (mode === 'button') ui.button('取消').click();
    else ui.host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
  });
  expect(ui.writes).toHaveLength(0); expect(ui.persisted().document.cues[0].gainDb).toBe(-12); unmountClean();
});
it('does not clear a newer dialog edit when an older save completes', async () => {
  const ui = await setup(); await ui.open(); ui.edit('音量（dB）', '-6');
  let finish!: () => void; ui.hold(new Promise<void>(resolve => { finish = resolve; }));
  await ui.submit(); ui.edit('音量（dB）', '-3');
  await act(async () => finish());
  expect(ui.persisted().document.cues[0].gainDb).toBe(-6); expect(runtimeProtection.read().dirty).toBe(true);
  expect(ui.host.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!.value).toBe('-3');
  expect(ui.host.querySelector('dialog')!.open).toBe(true);
  expect(ui.button('保存音效').disabled).toBe(false);
  await ui.submit();
  expect(ui.persisted().document.cues[0].gainDb).toBe(-3);
  expect(ui.host.querySelector('dialog')!.open).toBe(false);
  expect(ui.saved).toHaveBeenCalledTimes(2); unmountClean();
});
it('does not resurrect an explicitly cancelled draft when its pending save finishes', async () => {
  const ui = await setup(); await ui.open(); ui.edit('音量（dB）', '-6');
  let finish!: () => void; ui.hold(new Promise<void>(resolve => { finish = resolve; }));
  await ui.submit();
  act(() => ui.button('取消').click());
  expect(ui.host.querySelector('dialog')!.open).toBe(false);
  expect(runtimeProtection.read().dirty).toBe(true);
  await act(async () => finish());
  expect(ui.persisted().document.cues[0].gainDb).toBe(-6);
  expect(ui.host.querySelector('dialog')!.open).toBe(false);
  expect(ui.host.querySelector('input[aria-label="音量（dB）"]')).toBeNull();
  unmountClean();
});
