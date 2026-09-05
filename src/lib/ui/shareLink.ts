import { toast } from '../state/toasts.svelte';
import { currentSystemFile } from '../state/system.svelte';
import { shareUrlFor } from '../storage/shareUrl';

/**
 * Copy a share link for the current system to the clipboard, reporting the
 * outcome as a toast. Resolves true on success so a caller can decide whether
 * to close its menu.
 */
export async function copyShareLink(): Promise<boolean> {
  // One catch for both ways this can fail: no `CompressionStream` (old
  // browser) and a denied clipboard write.
  try {
    const link = await shareUrlFor(currentSystemFile());
    await navigator.clipboard.writeText(link);
    toast(
      'ok',
      link.length > 2000
        ? `Share link copied — it's ${Math.round(link.length / 1000)}k characters, so chat apps may truncate it.`
        : 'Share link copied.'
    );
    return true;
  } catch {
    toast('error', 'Could not copy a share link in this browser.');
    return false;
  }
}
