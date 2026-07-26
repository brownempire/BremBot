export function scrollAppToTop() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const appScrollShell = document.querySelector<HTMLElement>(".app-scroll-shell");
  if (appScrollShell) {
    appScrollShell.scrollTop = 0;
    appScrollShell.scrollLeft = 0;
    appScrollShell.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  const documentScroller = document.scrollingElement;
  if (documentScroller instanceof HTMLElement) {
    documentScroller.scrollTop = 0;
    documentScroller.scrollLeft = 0;
  }

  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}
