import { browser } from 'wxt/browser';

const KEY = 'popoutWindowId';

/** Opens the floating transcript window, or focuses it if it is already open. */
export async function openTranscriptWindow(): Promise<void> {
  try {
    const stored = (await browser.storage.session.get(KEY))[KEY] as number | undefined;
    if (stored !== undefined) {
      await browser.windows.update(stored, { focused: true, drawAttention: true });
      return;
    }
  } catch {
    // window was closed — fall through and create a new one
  }
  const win = await browser.windows.create({
    type: 'popup',
    url: browser.runtime.getURL('/popout.html'),
    width: 380,
    height: 640,
    focused: true,
  });
  if (win?.id !== undefined) await browser.storage.session.set({ [KEY]: win.id });
}

/** Opens the side panel in the current window (must be called from a user gesture). */
export async function openSidePanel(): Promise<void> {
  const win = await browser.windows.getCurrent();
  if (win.id !== undefined) await browser.sidePanel.open({ windowId: win.id });
}
