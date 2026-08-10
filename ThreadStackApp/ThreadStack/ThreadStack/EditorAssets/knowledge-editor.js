/*
 * knowledge-editor.js — eigenständige Bridge-Implementierung für den
 * nativen Wissens-Editor (Paket 2: knowledge-editor-bridge).
 *
 * Dieses Skript ist BEWUSST eigenständig und bindet NICHT index.html oder
 * deren initRtToolbar (index.html:3861) ein. Es portiert lediglich die
 * reinen, portierbaren Funktionsideen (Paste-Bereinigung analog
 * cleanPastedHtml, HTML-Escaping analog escHtml, Selection speichern/
 * wiederherstellen, execCommand-Wrapper) als eigenständigen Code neu.
 *
 * Sicherheit:
 *  - Alle Eingaben, die per Bridge von nativ hereinkommen (setContent,
 *    insertHTML, insertLink, insertImage), laufen durch eine
 *    Tag-/Attribut-Allowlist (Defense-in-Depth; der Server sanitisiert final).
 *  - KI-Zusammenfassungstext (Fremdinhalt) wird bei insertLink IMMER über
 *    escHtml() escaped in <p>-Absätze eingesetzt, niemals als HTML interpretiert.
 *  - postMessage an nativ enthält bei "change" NIEMALS den Inhalt selbst,
 *    nur die Länge.
 */
(function () {
  'use strict';

  var editor = document.getElementById('editor');

  // ---------------------------------------------------------------------
  // HTML-Escaping (analog escHtml, index.html:3243)
  // ---------------------------------------------------------------------
  function escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------------
  // Paste-/Insert-Bereinigung (analog cleanPastedHtml, index.html:3136)
  // Entfernt ausschließlich gefährliche Tags/Attribute (Defense-in-Depth).
  // Tabellen, Überschriften, Bilder etc. bleiben für den Rundreise-Erhalt
  // erhalten, auch wenn die Toolbar sie nicht erzeugen kann.
  // ---------------------------------------------------------------------
  var FORBIDDEN_TAGS = ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM'];
  var URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction'];

  function stripDangerous(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    var toRemove = [];
    var node;
    while ((node = walker.nextNode())) {
      if (FORBIDDEN_TAGS.indexOf(node.tagName) !== -1) {
        toRemove.push(node);
        continue;
      }
      var attrs = node.attributes ? Array.prototype.slice.call(node.attributes) : [];
      for (var i = 0; i < attrs.length; i++) {
        var attr = attrs[i];
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (URL_ATTRS.indexOf(name) !== -1 && /^\s*javascript:/i.test(attr.value)) {
          node.removeAttribute(attr.name);
        }
      }
    }
    for (var j = 0; j < toRemove.length; j++) {
      toRemove[j].remove();
    }
  }

  function sanitizeFragment(html) {
    var template = document.createElement('template');
    template.innerHTML = typeof html === 'string' ? html : '';
    stripDangerous(template.content);
    return template.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Selection speichern/wiederherstellen
  // ---------------------------------------------------------------------
  var savedRange = null;

  function isSelectionInEditor(sel) {
    if (!sel || sel.rangeCount === 0) return false;
    var node = sel.getRangeAt(0).commonAncestorContainer;
    return editor.contains(node) || node === editor;
  }

  function saveSelectionIfInEditor() {
    var sel = window.getSelection();
    if (isSelectionInEditor(sel)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    editor.focus();
    var sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    if (savedRange && editor.contains(savedRange.commonAncestorContainer)) {
      sel.addRange(savedRange);
      return;
    }
    var range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.addRange(range);
  }

  // ---------------------------------------------------------------------
  // execCommand-Wrapper
  // ---------------------------------------------------------------------
  function runCommand(name, value) {
    try {
      return document.execCommand(name, false, value === undefined ? null : value);
    } catch (e) {
      return false;
    }
  }

  function insertHtmlFallback(html) {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0);
    range.deleteContents();
    var frag = range.createContextualFragment(html);
    var lastNode = frag.lastChild;
    range.insertNode(frag);
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function insertHtmlAtSelection(html) {
    restoreSelection();
    if (!runCommand('insertHTML', html)) {
      insertHtmlFallback(html);
    }
  }

  // ---------------------------------------------------------------------
  // Blockierte Bilder (CSP img-src data: blob: — https:-Quellen werden
  // nicht geladen). Element bleibt im DOM, bekommt nur eine CSS-Klasse.
  // ---------------------------------------------------------------------
  function markBlockedImages() {
    var imgs = editor.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute('src') || '';
      if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src) || /^blob:/i.test(src)) {
        img.classList.remove('ts-img-blocked');
      } else {
        img.classList.add('ts-img-blocked');
      }
    }
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  var ALLOWED_COMMANDS = ['bold', 'italic', 'underline', 'insertUnorderedList'];

  function safeQueryState(cmd) {
    try {
      return !!document.queryCommandState(cmd);
    } catch (e) {
      return false;
    }
  }

  function currentLength() {
    return editor.textContent.length;
  }

  function currentSelectedText() {
    var sel = window.getSelection();
    if (!isSelectionInEditor(sel) || sel.isCollapsed) return '';
    var text = sel.toString();
    if (text.length > 200) text = text.slice(0, 200);
    return text;
  }

  function currentState() {
    var sel = window.getSelection();
    var hasSelection = isSelectionInEditor(sel) && !sel.isCollapsed;
    return {
      bold: safeQueryState('bold'),
      italic: safeQueryState('italic'),
      underline: safeQueryState('underline'),
      unorderedList: safeQueryState('insertUnorderedList'),
      hasSelection: hasSelection,
      selectedText: hasSelection ? currentSelectedText() : '',
      length: currentLength()
    };
  }

  // ---------------------------------------------------------------------
  // Nativ-Kommunikation (Schnittstelle 4: JS -> Nativ, Handler "tsEditor")
  // ---------------------------------------------------------------------
  function postMessageSafe(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tsEditor) {
        window.webkit.messageHandlers.tsEditor.postMessage(payload);
      }
    } catch (e) {
      // Bridge nicht verfügbar (z. B. Preview ohne WKWebView) — bewusst kein Crash.
    }
  }

  function postState() {
    var state = currentState();
    postMessageSafe({
      type: 'state',
      bold: state.bold,
      italic: state.italic,
      underline: state.underline,
      unorderedList: state.unorderedList,
      hasSelection: state.hasSelection,
      selectedText: state.selectedText,
      length: state.length
    });
  }

  function reportContentHeight() {
    postMessageSafe({ type: 'contentHeight', height: document.body.scrollHeight });
  }

  // ---------------------------------------------------------------------
  // CSSOM-Zugriff für die Font-Scale-Variable (CSP-konform, siehe
  // knowledge-editor.css: keine Inline-Style-Zuweisung).
  // ---------------------------------------------------------------------
  function findRootRule() {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      var rules;
      try {
        rules = sheet.cssRules || sheet.rules;
      } catch (e) {
        continue;
      }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        if (rules[j].selectorText === ':root') return rules[j];
      }
    }
    return null;
  }

  function clampFontScale(value) {
    var scale = typeof value === 'number' && isFinite(value) ? value : 1;
    if (scale < 0.8) scale = 0.8;
    if (scale > 2.0) scale = 2.0;
    return scale;
  }

  // ---------------------------------------------------------------------
  // window.TSEditor — Schnittstelle 3: Nativ -> JS
  // ---------------------------------------------------------------------
  window.TSEditor = {
    setContent: function (html) {
      editor.innerHTML = sanitizeFragment(html);
      markBlockedImages();
      postState();
      return { ok: true, length: currentLength() };
    },

    getContent: function () {
      var html = editor.innerHTML;
      if (html === '' || html === '<br>' || html === '<div><br></div>') return '';
      return html;
    },

    exec: function (cmd) {
      if (ALLOWED_COMMANDS.indexOf(cmd) === -1) {
        return { ok: false, code: 'UNKNOWN_COMMAND' };
      }
      restoreSelection();
      runCommand(cmd);
      var state = currentState();
      postState();
      return { ok: true, state: state };
    },

    insertHTML: function (html) {
      insertHtmlAtSelection(sanitizeFragment(html));
      markBlockedImages();
      postState();
      return { ok: true, length: currentLength() };
    },

    insertLink: function (spec) {
      spec = spec && typeof spec === 'object' ? spec : {};
      var href = typeof spec.href === 'string' ? spec.href : '';
      if (!/^https?:\/\//i.test(href)) {
        return { ok: false, code: 'INVALID_URL' };
      }
      var text = typeof spec.text === 'string' ? spec.text : '';
      var paragraphs = Array.isArray(spec.summaryParagraphs) ? spec.summaryParagraphs : [];

      var markup = '<p><a href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' +
        escHtml(text) + '</a></p>';

      if (typeof paragraphs[0] === 'string' && paragraphs[0].length > 0) {
        markup += '<p><em>✨ KI-Zusammenfassung:</em> ' + escHtml(paragraphs[0]) + '</p>';
      }
      if (typeof paragraphs[1] === 'string' && paragraphs[1].length > 0) {
        markup += '<p>' + escHtml(paragraphs[1]) + '</p>';
      }

      insertHtmlAtSelection(markup);
      postState();
      return { ok: true, length: currentLength() };
    },

    insertImage: function (spec) {
      spec = spec && typeof spec === 'object' ? spec : {};
      var dataUrl = typeof spec.dataUrl === 'string' ? spec.dataUrl : '';
      if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(dataUrl)) {
        return { ok: false, code: 'INVALID_IMAGE' };
      }
      var alt = typeof spec.alt === 'string' ? spec.alt : '';
      var markup = '<img src="' + dataUrl.replace(/"/g, '&quot;') + '" alt="' + escHtml(alt) + '">';

      insertHtmlAtSelection(markup);
      markBlockedImages();
      postState();
      return { ok: true, length: currentLength() };
    },

    queryState: function () {
      return currentState();
    },

    setEditable: function (flag) {
      editor.contentEditable = flag ? 'true' : 'false';
      return { ok: true };
    },

    focus: function () {
      editor.focus();
      return { ok: true };
    },

    setPlaceholder: function (text) {
      editor.setAttribute('data-placeholder', typeof text === 'string' ? text : '');
      return { ok: true };
    },

    setAppearance: function (a) {
      a = a && typeof a === 'object' ? a : {};
      var scale = clampFontScale(a.fontScale);
      var rootRule = findRootRule();
      if (rootRule) {
        rootRule.style.setProperty('--ts-font-scale', String(scale));
      }
      document.documentElement.classList.toggle('ts-dark', !!a.dark);
      return { ok: true };
    }
  };

  // ---------------------------------------------------------------------
  // Event-Verdrahtung
  // ---------------------------------------------------------------------
  var changeTimer = null;

  editor.addEventListener('input', function () {
    markBlockedImages();
    reportContentHeight();
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(function () {
      changeTimer = null;
      postMessageSafe({ type: 'change', length: currentLength() });
    }, 300);
  });

  document.addEventListener('selectionchange', function () {
    if (isSelectionInEditor(window.getSelection())) {
      postState();
    }
  });

  editor.addEventListener('blur', saveSelectionIfInEditor);

  editor.addEventListener('paste', function (e) {
    e.preventDefault();
    var dt = e.clipboardData;
    var html = dt && dt.getData ? dt.getData('text/html') : '';
    if (html) {
      insertHtmlAtSelection(sanitizeFragment(html));
    } else {
      var text = dt && dt.getData ? dt.getData('text/plain') : '';
      if (!runCommand('insertText', text)) {
        insertHtmlAtSelection(escHtml(text).replace(/\n/g, '<br>'));
      }
    }
    markBlockedImages();
    reportContentHeight();
    postState();
  });

  // Minimale, in dieser Bridge selbst verankerte Auslöser für
  // requestLink/requestImage (Tastaturkürzel). Die eigentliche
  // Toolbar-UI lebt nativ in Paket 6; diese Kürzel stellen sicher, dass
  // die Bridge-Nachrichten bereits jetzt funktional sind und stellen kein
  // Konflikt zu einer künftigen nativen Toolbar dar (Paket 6 kann sie
  // ignorieren oder ergänzend nutzen).
  editor.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    var key = (e.key || '').toLowerCase();
    if (key === 'k') {
      e.preventDefault();
      postMessageSafe({ type: 'requestLink', selectedText: currentSelectedText() });
    } else if (key === 'i' && e.shiftKey) {
      e.preventDefault();
      postMessageSafe({ type: 'requestImage' });
    }
  });

  window.addEventListener('resize', reportContentHeight);

  // DOM ist beim Ausführen dieses (am body-Ende eingebundenen) Skripts
  // bereits geparst — keine DOMContentLoaded-Wartezeit nötig.
  markBlockedImages();
  postMessageSafe({ type: 'ready' });
  reportContentHeight();
})();
