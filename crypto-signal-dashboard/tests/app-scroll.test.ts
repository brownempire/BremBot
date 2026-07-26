import assert from "node:assert/strict";
import test from "node:test";

import { scrollAppToTop } from "../lib/navigation/appScroll";

test("tab navigation resets the nested app scroll shell", () => {
  class MockElement {
    scrollTop = 900;
    scrollLeft = 40;
    scrollCalls = 0;

    scrollTo(options: ScrollToOptions) {
      this.scrollTop = options.top ?? this.scrollTop;
      this.scrollLeft = options.left ?? this.scrollLeft;
      this.scrollCalls += 1;
    }
  }

  const appScrollShell = new MockElement();
  const documentScroller = new MockElement();
  const windowScrollCalls: ScrollToOptions[] = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: MockElement,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) => selector === ".app-scroll-shell" ? appScrollShell : null,
      scrollingElement: documentScroller,
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      scrollTo: (options: ScrollToOptions) => windowScrollCalls.push(options),
    },
  });

  try {
    scrollAppToTop();
    assert.equal(appScrollShell.scrollTop, 0);
    assert.equal(appScrollShell.scrollLeft, 0);
    assert.equal(appScrollShell.scrollCalls, 1);
    assert.equal(documentScroller.scrollTop, 0);
    assert.equal(documentScroller.scrollLeft, 0);
    assert.deepEqual(windowScrollCalls, [{ top: 0, left: 0, behavior: "auto" }]);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: originalHTMLElement });
  }
});
