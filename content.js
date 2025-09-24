(() => {
  if (window.__upscNotesListenerAttached) {
    // Prevent duplicate listeners if the script is injected more than once.
    console.debug("UPSC Notes content script already attached");
    return;
  }
  window.__upscNotesListenerAttached = true;

  function getResponseElements() {
    return Array.from(document.querySelectorAll(".markdown"));
  }

  function normaliseLinks(root) {
    root.querySelectorAll("a").forEach((anchor) => {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    });
  }

  function removeCitations(root) {
    root.querySelectorAll("button").forEach((button) => button.remove());

    root.querySelectorAll("a").forEach((anchor) => {
      const parent = anchor.closest("li, p");
      if (parent && parent.textContent.trim() === anchor.textContent.trim()) {
        parent.remove();
      } else {
        anchor.remove();
      }
    });

    root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6").forEach((node) => {
      const text = node.textContent.trim();
      if (!text) {
        return;
      }
      if (/^sources?:?/i.test(text)) {
        node.remove();
        return;
      }
      if (/\bhttps?:\/\//i.test(text)) {
        node.remove();
        return;
      }
      if (/\b[\w.-]+\/[\w./-]+\.[a-z]{1,5}(?::\d+)?/i.test(text)) {
        node.remove();
      }
    });

    root.querySelectorAll("sup").forEach((sup) => {
      if (/^\d+$/.test(sup.textContent.trim())) {
        sup.remove();
      }
    });
  }

  function getMessageContentElement(wrapper) {
    if (!wrapper) {
      return null;
    }
    const selectors = [
      '.markdown',
      '[data-message-content="true"]',
      '[data-testid="markdown"]',
      '.prose',
      '.whitespace-pre-wrap',
      'article'
    ];
    for (const selector of selectors) {
      const found = wrapper.querySelector(selector);
      if (found) {
        return found;
      }
    }
    return wrapper;
  }

  function extractCleanText(element, { scrubCitations = true } = {}) {
    if (!element) {
      return "";
    }
    const clone = element.cloneNode(true);
    normaliseLinks(clone);
    if (scrubCitations) {
      removeCitations(clone);
    }
    return clone.innerText.trim();
  }

  function collapseToSingleLine(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (prototypeSetter && valueSetter !== prototypeSetter) {
      prototypeSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  const bulkState = window.__bulkAskState || {
    queue: [],
    running: false,
    processed: 0,
    total: 0,
    currentQuestion: null
  };
  window.__bulkAskState = bulkState;

  function sendBulkStatus(payload) {
    try {
      chrome.runtime.sendMessage({ type: "bulk_status", ...payload });
    } catch (error) {
      console.debug("bulk_status send failed", error);
    }
  }

  async function waitWithCountdown(totalMs, onTick, stepMs = 1000) {
    const end = Date.now() + totalMs;
    while (true) {
      const remaining = Math.max(0, end - Date.now());
      if (typeof onTick === "function") {
        onTick(remaining);
      }
      if (remaining <= 0) {
        break;
      }
      await wait(Math.min(stepMs, remaining));
    }
  }

  function buildConversationPairs() {
    const messageWrappers = Array.from(document.querySelectorAll("[data-message-author-role]"));
    const pairs = [];
    let pendingQuestion = null;

    messageWrappers.forEach((wrapper) => {
      const role = wrapper.getAttribute("data-message-author-role");
      const contentEl = getMessageContentElement(wrapper);
      if (!contentEl) {
        return;
      }

      if (role === "user") {
        const question = extractCleanText(contentEl, { scrubCitations: false });
        if (question) {
          pendingQuestion = question;
        }
        return;
      }

      if (role === "assistant" && pendingQuestion) {
        let answer = extractCleanText(contentEl, { scrubCitations: true });
        if (!answer) {
          answer = extractCleanText(contentEl, { scrubCitations: false });
        }
        if (answer) {
          pairs.push({ question: pendingQuestion, answer });
          pendingQuestion = null;
        }
      }
    });

    return pairs;
  }

  function sanitizeFilename(name, fallback = "chat") {
    const cleaned = (name || "")
      .replace(/[\r\n]+/g, " ")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    return cleaned || fallback;
  }

  function getChatTitle() {
    const rawTitle = document.title || "";
    const stripped = rawTitle.replace(/\s*-\s*ChatGPT\s*$/i, "");
    if (stripped.trim()) {
      return stripped.trim();
    }
    const h1 = document.querySelector("h1");
    if (h1?.textContent) {
      return h1.textContent.trim();
    }
    return "ChatGPT Conversation";
  }

  function buildQAText(pairs) {
    return pairs
      .map((pair) => {
        const q = collapseToSingleLine(pair.question);
        const a = collapseToSingleLine(pair.answer);
        return `${q} | ${a}`;
      })
      .join("\n");
  }

  function buildNotesDocument(responseElements) {
    const styles = `:root { color-scheme: light; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f5f6fb;
  color: #0f172a;
  margin: 0;
  padding: 48px 24px;
}

main {
  max-width: 960px;
  margin: 0 auto;
}

header.page-title {
  text-align: center;
  margin-bottom: 40px;
}

h1 {
  margin: 0;
  font-size: 1.75rem;
  letter-spacing: 0.02em;
}

.meta {
  margin-top: 8px;
  font-size: 0.9rem;
  color: #6b7280;
}

.copy-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 960px;
  margin: 0 auto 24px;
}

.copy-toolbar button {
  padding: 10px 18px;
  border-radius: 999px;
  border: none;
  background: #2563eb;
  color: #ffffff;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background 0.2s ease, transform 0.2s ease;
}

.copy-toolbar button:hover {
  background: #1d4ed8;
  transform: translateY(-1px);
}

.copy-toolbar button:active {
  transform: translateY(0);
}

.copy-status {
  font-size: 0.9rem;
  color: #2563eb;
}

.copy-status.error {
  color: #dc2626;
}

.chat-response {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 32px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
}

.chat-response > *:first-child {
  margin-top: 0;
}

.chat-response > *:last-child {
  margin-bottom: 0;
}

.chat-response pre {
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 12px;
  padding: 16px;
  overflow: auto;
}

.chat-response code {
  font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.chat-response blockquote {
  border-left: 4px solid #cbd5f5;
  padding-left: 16px;
  color: #475569;
}

@media (prefers-color-scheme: dark) {
  body {
    background: #0b1120;
    color: #e2e8f0;
  }
  .copy-toolbar button {
    background: #3b82f6;
  }
  .copy-toolbar button:hover {
    background: #2563eb;
  }
  .copy-status {
    color: #93c5fd;
  }
  .copy-status.error {
    color: #fca5a5;
  }
  .chat-response {
    background: #111827;
    border-color: #1f2937;
    box-shadow: 0 10px 30px rgba(10, 16, 28, 0.5);
  }
  .chat-response blockquote {
    border-color: #334155;
    color: #cbd5f5;
  }
}
`;

    const generatedAt = new Date().toLocaleString();
    const textSections = [];

    const combinedMarkup = responseElements
      .map((el) => {
        const clone = el.cloneNode(true);
        normaliseLinks(clone);
        removeCitations(clone);
        const textContent = clone.innerText.trim();
        if (textContent) {
          textSections.push(textContent);
        }
        return clone.innerHTML.trim();
      })
      .filter(Boolean)
      .join("\n\n");

    const htmlDocument = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ChatGPT Notes</title>
    <style id="exportStyles">
${styles}
    </style>
  </head>
  <body>
    <header class="page-title">
      <h1>ChatGPT Notes Export</h1>
      <p class="meta">Saved on ${generatedAt}</p>
    </header>
    <div class="copy-toolbar">
      <button id="copyAllButton" type="button">Copy All</button>
      <span id="copyStatus" class="copy-status" aria-live="polite"></span>
    </div>
    <main class="chat-transcript">
      <section class="chat-response">
${combinedMarkup}
      </section>
    </main>
    <script>
      (function () {
        const copyBtn = document.getElementById("copyAllButton");
        const statusEl = document.getElementById("copyStatus");
        const copyTarget = document.querySelector(".chat-response");
        const stylesEl = document.getElementById("exportStyles");

        if (!copyBtn || !statusEl || !copyTarget) {
          return;
        }

        const resetStatus = () => {
          statusEl.textContent = "";
          statusEl.classList.remove("error");
        };

        const setStatus = (message, isError) => {
          statusEl.textContent = message;
          statusEl.classList.toggle("error", Boolean(isError));
          if (message) {
            setTimeout(resetStatus, 2000);
          }
        };

        const copyRichHTML = async (target) => {
          const html = target.innerHTML;
          const text = target.innerText;
          const styleText = stylesEl ? stylesEl.textContent : "";
          const documentHTML = '<!DOCTYPE html><html><head><meta charset="utf-8"/><style>' +
            styleText +
            '</style></head><body><section class="chat-response">' +
            html +
            '</section></body></html>';

          if (navigator.clipboard && navigator.clipboard.write) {
            try {
              const blobHTML = new Blob([documentHTML], { type: "text/html" });
              const blobText = new Blob([text], { type: "text/plain" });
              const clipboardItem = new ClipboardItem({
                "text/html": blobHTML,
                "text/plain": blobText
              });
              await navigator.clipboard.write([clipboardItem]);
              return true;
            } catch (clipboardError) {
              console.warn("navigator.clipboard.write failed", clipboardError);
            }
          }

          try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(target);
            selection.removeAllRanges();
            selection.addRange(range);
            const success = document.execCommand("copy");
            selection.removeAllRanges();
            return success;
          } catch (execError) {
            console.error("execCommand copy failed", execError);
            return false;
          }
        };

        copyBtn.addEventListener("click", async () => {
          if (!copyTarget.innerText.trim()) {
            setStatus("Nothing to copy", true);
            return;
          }

          setStatus("", false);

          try {
            const success = await copyRichHTML(copyTarget);
            if (success) {
              setStatus("Copied!", false);
            } else {
              setStatus("Copy failed", true);
            }
          } catch (error) {
            console.error("Copy failed", error);
            setStatus("Copy failed", true);
          }
        });
      })();
    </script>
  </body>
</html>`;

    const plainText = textSections.join("\n\n");

    return { htmlDocument, plainText };
  }

  function sendSaveFileMessage({ text, mimeType, filename, requestId }) {
    chrome.runtime.sendMessage(
      { type: "save_file", content: text, mimeType, filename, requestId },
      () => {
        if (chrome.runtime.lastError) {
          console.error("save_file", chrome.runtime.lastError.message);
        }
      }
    );
  }

  function countAssistantMessages() {
    return document.querySelectorAll('[data-message-author-role="assistant"]').length;
  }

  function captureAssistantResponse(previousCount) {
    const wrappers = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    if (wrappers.length <= previousCount) {
      return null;
    }
    const last = wrappers[wrappers.length - 1];
    const contentEl = getMessageContentElement(last);
    const text = extractCleanText(contentEl, { scrubCitations: false });
    if (!text) {
      return null;
    }
    return { text, count: wrappers.length };
  }

  function waitForAssistantReply(previousCount, timeoutMs = 300000, onProgress) {
    const immediate = captureAssistantResponse(previousCount);
    if (immediate) {
      if (typeof onProgress === "function") {
        onProgress(0, timeoutMs);
      }
      return Promise.resolve(immediate);
    }

    return new Promise((resolve, reject) => {
      const start = Date.now();

      const notifyProgress = () => {
        if (typeof onProgress === "function") {
          const elapsed = Date.now() - start;
          onProgress(elapsed, timeoutMs);
        }
      };

      notifyProgress();

      const observer = new MutationObserver(() => {
        const response = captureAssistantResponse(previousCount);
        if (response) {
          cleanup();
          notifyProgress();
          resolve(response);
        }
      });

      const progressInterval = typeof onProgress === "function" ? setInterval(notifyProgress, 1000) : null;

      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timer);
        if (progressInterval) {
          clearInterval(progressInterval);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        notifyProgress();
        reject(new Error("Timed out waiting for ChatGPT reply."));
      }, timeoutMs);

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  function findComposerElement() {
    const selectors = [
      '#prompt-textarea',
      '[data-testid="conversation-turn-composer-textarea"]',
      '.ProseMirror',
      '[contenteditable="true"][data-virtualkeyboard="true"]',
      'textarea'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        return el;
      }
    }

    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      '#composer-submit-button',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ];

    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button) {
        return button;
      }
    }

    const composer = findComposerElement();
    if (composer) {
      const formButton = composer.closest('form')?.querySelector('button[type="submit"], button[data-testid="send-button"]');
      if (formButton) {
        return formButton;
      }

      let parent = composer.parentElement;
      while (parent) {
        const candidate = parent.querySelector('button[data-testid="send-button"], button[type="submit"], button[aria-label="Send"], button[aria-label="Send message"]');
        if (candidate) {
          return candidate;
        }
        parent = parent.parentElement;
      }
    }

    return null;
  }

  function setComposerContent(composer, text) {
    if (!composer) {
      return;
    }

    if (composer.tagName === 'TEXTAREA') {
      setNativeValue(composer, text);
    } else {
      composer.focus();

      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('selectAll', false, null);
      } catch (error) {
        console.debug('selectAll failed', error);
      }

      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch (error) {
        console.debug('insertText failed', error);
      }

      if (!inserted) {
        composer.innerHTML = '';
        composer.textContent = text;
      }
    }

    try {
      composer.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: 'insertText'
        })
      );
    } catch (error) {
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }

    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitForElement(factory, timeoutMs = 5000, intervalMs = 100) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;

      const attempt = () => {
        try {
          const value = typeof factory === 'function' ? factory() : null;
          if (value) {
            resolve(value);
            return;
          }
        } catch (error) {
          // ignore factory errors, retry until timeout
        }

        if (Date.now() >= deadline) {
          reject(new Error('Element lookup timed out.'));
        } else {
          setTimeout(attempt, intervalMs);
        }
      };

      attempt();
    });
  }

  async function fillAndSendQuestion(question) {
    const composer = await waitForElement(() => findComposerElement());
    if (!composer) {
      throw new Error("Could not find ChatGPT input box.");
    }

    const previousCount = countAssistantMessages();
    composer.focus();
    setComposerContent(composer, question);

    const sendButton = await waitForElement(() => findSendButton());
    if (!sendButton) {
      throw new Error("Could not find ChatGPT send button.");
    }

    if (sendButton.disabled) {
      sendButton.disabled = false;
    }

    sendButton.click();
    return previousCount;
  }

  async function processBulkQueue() {
    const state = bulkState;
    sendBulkStatus({
      status: "started",
      total: state.processed + state.queue.length,
      pending: state.queue.length,
      processed: state.processed
    });

    while (state.queue.length) {
      const question = state.queue.shift();
      state.currentQuestion = question;
      const currentIndex = state.processed + 1;
      const total = state.processed + 1 + state.queue.length;

      sendBulkStatus({
        status: "asking",
        index: currentIndex,
        total,
        pending: state.queue.length,
        question
      });

      try {
        const previousCount = await fillAndSendQuestion(question);

        await waitForAssistantReply(
          previousCount,
          300000,
          (elapsedMs, timeoutMs) => {
            sendBulkStatus({
              status: "waiting_reply",
              index: currentIndex,
              total: state.processed + state.queue.length + 1,
              pending: state.queue.length,
              elapsedMs,
              timeoutMs
            });
          }
        );
        state.processed += 1;

        sendBulkStatus({
          status: "answered",
          index: state.processed,
          total: state.processed + state.queue.length,
          pending: state.queue.length
        });
      } catch (error) {
        console.error("Bulk questioning failed", error);
        sendBulkStatus({ status: "error", error: error?.message || "Failed to send question." });
        state.queue.length = 0;
        state.running = false;
        state.currentQuestion = null;
        return;
      }

      if (state.queue.length) {
        const delayMs = Math.floor(Math.random() * 15000) + 5000;
        await waitWithCountdown(delayMs, (remainingMs) => {
          sendBulkStatus({
            status: "delay",
            remainingMs,
            total: state.processed + state.queue.length,
            index: state.processed,
            pending: state.queue.length
          });
        });
      }
    }

    sendBulkStatus({ status: "complete", processed: state.processed });
    state.running = false;
    state.currentQuestion = null;
    state.queue.length = 0;
    state.total = 0;
    state.processed = 0;
  }

  function startBulkQuestioning(questions) {
    const cleaned = Array.isArray(questions) ? questions.map((q) => (typeof q === "string" ? q.trim() : "")).filter(Boolean) : [];
    if (!cleaned.length) {
      return 0;
    }

    const state = bulkState;
    state.queue.push(...cleaned);
    const added = cleaned.length;

    const total = state.processed + state.queue.length;
    sendBulkStatus({
      status: state.running ? "queued_more" : "queued",
      total,
      pending: state.queue.length,
      processed: state.processed,
      added
    });

    if (!state.running) {
      state.running = true;
      processBulkQueue().catch((error) => {
        console.error("Bulk queue crashed", error);
        state.running = false;
        sendBulkStatus({ status: "error", error: error?.message || "Bulk processing failed." });
      });
    }

    return added;
  }

  function createRequestId(prefix) {
    if (typeof crypto?.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "collect_notes") {
      const responseElements = getResponseElements();
      if (!responseElements.length) {
        sendResponse({ success: false, error: "No ChatGPT responses were found on this page." });
        return;
      }

      const { htmlDocument, plainText } = buildNotesDocument(responseElements);
      const requestId = createRequestId("notes");

      localStorage.setItem("notes_md", plainText);
      localStorage.setItem("notes_text", plainText);
      localStorage.setItem("notes_html", htmlDocument);
      sendSaveFileMessage({
        text: htmlDocument,
        mimeType: "text/html",
        filename: "chapter_notes.html",
        requestId
      });

      sendResponse({ success: true, filename: "chapter_notes.html", requestId });
      return;
    }

    if (request.action === "generate_qa") {
      const pairs = buildConversationPairs();
      if (!pairs.length) {
        sendResponse({ success: false, error: "No question/answer pairs were detected in this chat." });
        return;
      }

      const requestId = createRequestId("qa");
      const filename = `${sanitizeFilename(getChatTitle(), "chat")}.txt`;
      const qaText = buildQAText(pairs);

      sendSaveFileMessage({
        text: qaText,
        mimeType: "text/plain",
        filename,
        requestId
      });

      localStorage.setItem("notes_qna", qaText);

      sendResponse({ success: true, filename, requestId });
      return;
    }

    if (request.action === "bulk_questions") {
      const added = startBulkQuestioning(request.questions);
      if (added) {
        sendResponse({ success: true, enqueued: added });
      } else {
        sendResponse({ success: false, error: "No questions provided." });
      }
      return;
    }
  });
})();
