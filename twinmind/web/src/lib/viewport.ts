/** Keep the app exactly as tall as the visible viewport, so the on-screen keyboard never hides the composer. */
export function trackVisualViewport() {
  const vv = window.visualViewport;
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${Math.round(h)}px`);
    if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
  };
  apply();
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
}

export function trackColorScheme() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", mq.matches);
  apply();
  mq.addEventListener("change", apply);
}
