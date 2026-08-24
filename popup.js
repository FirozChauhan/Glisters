/* Glisters — Firefox popup shell logic.
   The popup is just a frame around the shared newtab.html grid. This file
   runs in the popup document (NOT inside the iframe) and handles:
   - focusing the grid so it is immediately keyboard-ready
   - the "open in tab" affordance (full-page grid in a real tab)          */
(function () {
  'use strict';

  var frame = document.getElementById('glistersFrame');

  function focusGrid() {
    if (frame && frame.contentWindow) {
      try { frame.contentWindow.focus(); } catch (e) { /* noop */ }
    }
  }

  function openInTab() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html'), active: true });
      try { window.close(); } catch (e) { /* noop */ }
    }
  }

  document.getElementById('openTab').addEventListener('click', openInTab);

  /* grid is keyboard-first: focus it as soon as the popup is up so the
     first keystroke lands in the grid instead of the (empty) popup chrome */
  focusGrid();
})();
