/**
 * Scroll to an element that may not be mounted yet.
 *
 * Sections inside Setup render nothing until their own read lands, so the
 * target of `/setup/data` is absent on the first frame. Poll briefly, then
 * give up: a deployment without that block never grows one, and hunting
 * forever would leak a timer.
 */
export function scrollToId(elementId: string): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let tries = 0;
  const timer = window.setInterval(() => {
    const target = document.getElementById(elementId);
    if (target) {
      window.clearInterval(timer);
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      return;
    }
    if (++tries > 20) window.clearInterval(timer);
  }, 100);
  return () => window.clearInterval(timer);
}
