// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SoundEffectCue } from '@video-workbench/core';
import { SoundEffectTrack } from './SoundEffectTrack';
import { runtimeProtection } from '../../runtime/activity';
import { requestSoundEffectPeaks } from './soundEffectWaveform';

vi.mock('./soundEffectWaveform', async importOriginal => ({
  ...await importOriginal<typeof import('./soundEffectWaveform')>(),
  requestSoundEffectPeaks: vi.fn(async () => [0, .4, .8, .2]),
}));

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
async function setup(stale = false, sidebar = false, initialCues = [cue()]) {
  let editRevision = 'e1';
  let persisted = { revision: 'r1', editRevision: 'e1', duration: 10, stale, document: { schemaVersion: 1, editRevision: 'e1', cues: initialCues } };
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
  const settingsTarget = sidebar ? document.createElement('div') : null;
  if (settingsTarget) document.body.append(settingsTarget);
  const scope = settingsTarget ?? host;
  const saved = vi.fn();
  const openSettings = vi.fn();
  const render = () => <SoundEffectTrack projectId="test" editRevision={editRevision} time={0} onSaved={saved} onSeek={() => {}} pixelsPerSecond={100} displayContentWidth={1000} settingsTarget={settingsTarget} onOpenSettings={openSettings} />;
  await act(async () => root!.render(render()));
  const button = (text: string) => [...scope.querySelectorAll('button')].find(b => b.textContent === text)!;
  const open = async () => { await act(async () => host.querySelector('[data-sfx-cue]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); };
  const edit = (label: string, value: string) => act(() => {
    const input = scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = async () => { await act(async () => scope.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
  const rerender = async () => { await act(async () => root!.render(render())); };
  return { host, settingsTarget, openSettings, fetcher, rerender, button, open, edit, submit, writes, saved, persisted: () => persisted,
    changeEditRevision: async () => { editRevision = 'e2'; persisted = { ...persisted, editRevision, stale: true }; await rerender(); },
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

it('renders one row per audio track and writes track numbers only when a cue changes row', async () => {
  const ui = await setup();
  expect(ui.host.querySelectorAll('[data-sfx-track]')).toHaveLength(1);
  const element = ui.host.querySelector<HTMLElement>('[data-sfx-cue]')!;
  element.setPointerCapture = vi.fn();
  act(() => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 10, pointerId: 1 })));
  act(() => element.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 60, pointerId: 1 })));
  expect(element.style.top).toBe('51px');
  await act(async () => element.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 60, pointerId: 1 })));
  expect(ui.persisted().document.cues[0]).toMatchObject({ start: 1, track: 1 });
  expect(ui.host.querySelectorAll('[data-sfx-track]')).toHaveLength(1);
  expect(element.style.top).toBe('3px'); unmountClean();
});

it('mutes every cue of a track from its header', async () => {
  const ui = await setup();
  const header = ui.host.querySelector<HTMLButtonElement>('button[aria-label="音频轨 1"]')!;
  await act(async () => header.click());
  expect(ui.persisted().document.cues[0].mute).toBe(true);
  expect(ui.host.querySelector('button[aria-label="音频轨 1"]')!.getAttribute('aria-pressed')).toBe('true'); unmountClean();
});

it('portals audio controls into the feature pane while preserving the same timeline owner', async () => {
  const ui = await setup(false, true);
  expect(ui.host.querySelector('.cf-sfx-toolbar')).toBeNull();
  expect(ui.host.querySelector('dialog')).toBeNull();
  expect(ui.host.querySelector('[data-sfx-cue="cue-1"]')).not.toBeNull();
  expect(ui.settingsTarget!.querySelector('input[type="file"]')).not.toBeNull();
  expect(ui.button('添加 WAV').disabled).toBe(false);
  expect(ui.settingsTarget!.querySelector('[aria-label="选择音效"]')?.textContent).toContain('ding.wav');
  await ui.open();
  expect(ui.openSettings).toHaveBeenCalledTimes(1);
  expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!.value).toBe('-12');
  expect(ui.fetcher).toHaveBeenCalledTimes(1);
  unmountClean();
});

it('keeps an unsaved audio draft across pane hiding, parent renders, and same-cue reopening', async () => {
  const ui = await setup(false, true); await ui.open(); ui.edit('音量（dB）', '-6');
  const input = ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!;
  const track = ui.host.querySelector('[data-sfx-cue="cue-1"]');
  ui.settingsTarget!.hidden = true;
  await ui.rerender();
  ui.settingsTarget!.hidden = false;
  await ui.open();
  expect(ui.settingsTarget!.querySelector('input[aria-label="音量（dB）"]')).toBe(input);
  expect(input.value).toBe('-6');
  expect(ui.host.querySelector('[data-sfx-cue="cue-1"]')).toBe(track);
  expect(runtimeProtection.read().dirty).toBe(true);
  expect(ui.writes).toHaveLength(0);
  await ui.submit();
  expect(ui.persisted().document.cues[0].gainDb).toBe(-6);
  expect(ui.writes[0]).toMatchObject({ confirmed: true, expectedRevision: 'r1', expectedEditRevision: 'e1' });
  expect(ui.saved).toHaveBeenCalledTimes(1);
  expect(ui.settingsTarget!.querySelector('form')).not.toBeNull();
  expect(ui.settingsTarget!.hidden).toBe(false);
  unmountClean();
});

it('does not silently discard an unsaved draft when selecting another audio cue', async () => {
  const ui = await setup(false, true, [cue(), { ...cue(), id: 'cue-2', label: 'second.wav', start: 4 }]);
  await ui.open(); ui.edit('音量（dB）', '-6');
  const second = [...ui.settingsTarget!.querySelectorAll<HTMLButtonElement>('.cf-sfx-selection button')].find(b => b.textContent?.includes('second.wav'))!;
  act(() => second.click());
  expect(ui.settingsTarget!.textContent).toContain('请先保存或取消');
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!.value).toBe('-6');
  expect(second.getAttribute('aria-pressed')).toBe('false');
  await ui.submit();
  act(() => second.click());
  expect(second.getAttribute('aria-pressed')).toBe('true');
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!.value).toBe('-12');
  unmountClean();
});

it('keeps a newer side-pane edit when an older save finishes and permits explicit deletion', async () => {
  const ui = await setup(false, true); await ui.open(); ui.edit('音量（dB）', '-6');
  let finish!: () => void; ui.hold(new Promise<void>(resolve => { finish = resolve; }));
  await ui.submit(); ui.edit('音量（dB）', '-3');
  await act(async () => finish());
  expect(ui.persisted().document.cues[0].gainDb).toBe(-6);
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!.value).toBe('-3');
  expect(runtimeProtection.read().dirty).toBe(true);
  await ui.submit();
  expect(ui.persisted().document.cues[0].gainDb).toBe(-3);
  await act(async () => ui.button('删除音效').click());
  expect(ui.persisted().document.cues).toEqual([]);
  expect(ui.settingsTarget!.querySelector('form')).toBeNull();
  expect(ui.settingsTarget!.textContent).toContain('还没有音效');
  expect(ui.saved).toHaveBeenCalledTimes(3);
  unmountClean();
});

it('stages stale audio deletion in the sidebar and commits only through explicit rebind', async () => {
  const ui = await setup(true, true); await ui.open();
  await act(async () => ui.button('暂存删除').click());
  expect(ui.writes).toHaveLength(0);
  expect(ui.settingsTarget!.querySelector('form')).toBeNull();
  expect(runtimeProtection.read().dirty).toBe(true);
  await act(async () => ui.button('保存并重新绑定').click());
  expect(ui.persisted().document.cues).toEqual([]);
  expect(ui.saved).toHaveBeenCalledTimes(1);
  unmountClean();
});

it('preserves an unsaved sidebar draft when transcript editing refreshes the edit revision', async () => {
  const ui = await setup(false, true); await ui.open(); ui.edit('音量（dB）', '-6');
  const input = ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!;
  ui.settingsTarget!.hidden = true;
  await ui.changeEditRevision();
  ui.settingsTarget!.hidden = false;
  expect(ui.settingsTarget!.querySelector('input[aria-label="音量（dB）"]')).toBe(input);
  expect(input.value).toBe('-6');
  expect(ui.settingsTarget!.textContent).toContain('音效位置待审阅');
  expect(runtimeProtection.read().dirty).toBe(true);
  expect(ui.writes).toHaveLength(0);
  await ui.submit();
  expect(ui.writes).toHaveLength(0);
  expect(ui.button('暂存调整')).toBeDefined();
  await act(async () => ui.button('保存并重新绑定').click());
  expect(ui.writes[0]).toMatchObject({ expectedEditRevision: 'e2', document: { cues: [expect.objectContaining({ gainDb: -6 })] } });
  expect(ui.saved).toHaveBeenCalledTimes(1);
  unmountClean();
});

it('blocks adding a WAV at both the button and upload handler while a property draft is dirty', async () => {
  const ui = await setup(false, true); await ui.open(); ui.edit('音量（dB）', '-6');
  expect(ui.button('添加 WAV').disabled).toBe(true);
  expect(ui.settingsTarget!.textContent).toContain('请先保存或取消，再添加音效');
  const upload = ui.settingsTarget!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(upload, 'files', { configurable: true, value: [new File(['pcm'], 'new.wav', { type: 'audio/wav' })] });
  await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
  expect(ui.fetcher).toHaveBeenCalledTimes(1);
  expect(ui.writes).toHaveLength(0);
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!.value).toBe('-6');
  act(() => ui.button('取消').click());
  expect(ui.button('添加 WAV').disabled).toBe(false);
  unmountClean();
});

it('does not open a pre-drag cue from the trailing click while PUT is pending', async () => {
  const ui = await setup(false, true);
  let finish!: () => void; ui.hold(new Promise<void>(resolve => { finish = resolve; }));
  const element = ui.host.querySelector<HTMLElement>('[data-sfx-cue]')!;
  element.setPointerCapture = vi.fn();
  act(() => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, pointerId: 1 })));
  act(() => element.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, pointerId: 1 })));
  await act(async () => element.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, pointerId: 1 })));
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  expect(ui.writes).toHaveLength(1);
  expect(ui.settingsTarget!.querySelector('form')).toBeNull();
  expect(ui.openSettings).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(ui.persisted().document.cues[0].start).toBe(2);
  // A subsequent keyboard entry reads the acknowledged position, not the
  // closure captured by pointerdown before the drag.
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="开始（秒）"]')!.value).toBe('2');
  ui.edit('音量（dB）', '-6'); await ui.submit();
  expect(ui.persisted().document.cues[0]).toMatchObject({ start: 2, gainDb: -6 });
  unmountClean();
});

it('preserves real multitrack rows, in-clip waveforms and row mute in sidebar mode', async () => {
  const ui = await setup(false, true, [cue(), { ...cue(), id: 'cue-2', assetId: 'asset-2', label: 'second.wav' }]);
  expect(ui.host.querySelectorAll('[data-sfx-track]')).toHaveLength(2);
  expect(ui.host.querySelectorAll('.cf-sfx-wave path')).toHaveLength(2);
  expect(requestSoundEffectPeaks).toHaveBeenCalledWith('test', 'asset-2');
  expect(ui.settingsTarget!.textContent).toContain('音频轨 2');
  expect(ui.host.querySelector('input[type="file"]')).toBeNull();
  const first = ui.host.querySelector<HTMLButtonElement>('button[aria-label="音频轨 1"]')!;
  await act(async () => first.click());
  expect(ui.persisted().document.cues.map(c => c.mute)).toEqual([true, false]);
  expect(ui.host.querySelector('button[aria-label="音频轨 1"]')!.getAttribute('aria-pressed')).toBe('true');
  expect(ui.host.querySelector('button[aria-label="音频轨 2"]')!.getAttribute('aria-pressed')).toBe('false');
  expect(ui.host.querySelectorAll('.cf-sfx-wave path')).toHaveLength(2);
  unmountClean();
});

it('keeps vertical track dragging and suppresses its trailing click before reopening the saved cue', async () => {
  const ui = await setup(false, true, [cue(), { ...cue(), id: 'cue-2', label: 'second.wav' }]);
  let finish!: () => void; ui.hold(new Promise<void>(resolve => { finish = resolve; }));
  const element = ui.host.querySelector<HTMLElement>('[data-sfx-cue="cue-1"]')!;
  element.setPointerCapture = vi.fn();
  act(() => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 10, pointerId: 1 })));
  act(() => element.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 110, pointerId: 1 })));
  expect(element.style.top).toBe('99px');
  expect(ui.host.querySelector('.cf-sfx-footer.is-drop')).not.toBeNull();
  await act(async () => element.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, clientY: 110, pointerId: 1 })));
  act(() => element.click());
  expect(ui.openSettings).not.toHaveBeenCalled();
  expect(ui.settingsTarget!.querySelector('form')).toBeNull();
  expect(ui.writes[0].document.cues[0]).toMatchObject({ start: 2, track: 2 });
  await act(async () => finish());
  expect(ui.persisted().document.cues[0]).toMatchObject({ start: 2, track: 2 });
  expect(ui.host.querySelector('[data-sfx-cue="cue-1"]')).toBe(element);
  expect(ui.host.querySelectorAll('[data-sfx-track]')).toHaveLength(2);
  expect(ui.host.querySelectorAll('.cf-sfx-wave path')).toHaveLength(2);
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="开始（秒）"]')!.value).toBe('2');
  ui.edit('音量（dB）', '-6'); await ui.submit();
  expect(ui.persisted().document.cues[0]).toMatchObject({ start: 2, track: 2, gainDb: -6 });
  unmountClean();
});

it('requires saving or cancelling an inline draft before drag, track mute, or keyboard deletion', async () => {
  const ui = await setup(false, true); await ui.open(); ui.edit('音量（dB）', '-6');
  const element = ui.host.querySelector<HTMLElement>('[data-sfx-cue="cue-1"]')!;
  element.setPointerCapture = vi.fn();
  const header = ui.host.querySelector<HTMLButtonElement>('button[aria-label="音频轨 1"]')!;
  expect(header.disabled).toBe(true);
  act(() => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 10, pointerId: 1 })));
  expect(element.setPointerCapture).not.toHaveBeenCalled();
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
  expect(ui.writes).toHaveLength(0);
  expect(ui.settingsTarget!.textContent).toContain('请先保存或取消，再修改时间线');
  expect(ui.settingsTarget!.querySelector<HTMLInputElement>('input[aria-label="音量（dB）"]')!.value).toBe('-6');
  await ui.submit();
  expect(header.disabled).toBe(false);
  await act(async () => header.click());
  expect(ui.persisted().document.cues[0]).toMatchObject({ start: 1, gainDb: -6, mute: true });
  unmountClean();
});
