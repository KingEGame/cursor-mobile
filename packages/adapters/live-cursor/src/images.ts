/**
 * Paste phone photos into the Agents-window composer, exactly like Ctrl+V on the PC.
 * Each image becomes a thumbnail with a "Remove image" button; the count of those buttons
 * is the proof that every image landed (fail closed otherwise).
 */

import type { CdpClient } from "./cdp-client.js";

export interface PastedImage {
  name: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
}

export type PasteResult = { ok: true } | { ok: false; code: "IMAGE_NOT_ATTACHED"; error: string };

type Wait = (ms: number) => Promise<void>;
const realWait: Wait = (ms) => new Promise((r) => setTimeout(r, ms));

const COUNT = `document.querySelectorAll('[aria-label="Remove image"]').length`;

async function evaluate<T>(client: CdpClient, expression: string, awaitPromise = false): Promise<T | null> {
  const res = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
  );
  if (res.exceptionDetails) return null;
  return (res.result?.value ?? null) as T | null;
}

export async function pasteImages(
  client: CdpClient,
  images: PastedImage[],
  wait: Wait = realWait,
): Promise<PasteResult> {
  if (images.length === 0) return { ok: true };
  const before = (await evaluate<number>(client, COUNT)) ?? 0;
  for (const img of images) {
    await evaluate(
      client,
      `(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(img.base64)}), (c) => c.charCodeAt(0));
        const file = new File([bytes], ${JSON.stringify(img.name)}, { type: ${JSON.stringify(img.mime)} });
        const dt = new DataTransfer(); dt.items.add(file);
        const ed = document.querySelector(".ui-prompt-input-editor__input[contenteditable='true']");
        if (!ed) return false; ed.focus();
        ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      })()`,
      true,
    );
  }
  for (let waited = 0; waited <= 4000; waited += 250) {
    await wait(250);
    if (((await evaluate<number>(client, COUNT)) ?? 0) >= before + images.length) return { ok: true };
  }
  return { ok: false, code: "IMAGE_NOT_ATTACHED", error: "Cursor did not accept the photo" };
}

/** Remove every pasted image (cleanup after an aborted send). */
export async function removePastedImages(client: CdpClient): Promise<void> {
  await evaluate(client, `[...document.querySelectorAll('[aria-label="Remove image"]')].forEach((b) => b.click())`);
}
