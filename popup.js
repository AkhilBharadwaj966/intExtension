const statusEl = document.getElementById("status");
const generateBtn = document.getElementById("generateQA");
const bulkBtn = document.getElementById("askBulk");
const bulkForm = document.getElementById("bulkForm");
const bulkTextarea = document.getElementById("bulkQuestions");
const bulkSubmitBtn = document.getElementById("bulkSubmit");
const bulkCancelBtn = document.getElementById("bulkCancel");

const allowedHosts = new Set(["chat.openai.com", "chatgpt.com", "www.chatgpt.com"]);
const pendingDownloads = new Map();
let bulkFormVisible = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function renderPendingDownload(filename) {
  setStatus(`Saving ${filename}...`);
}

function openDownload(downloadId) {
  if (typeof downloadId === "number") {
    chrome.downloads.open(downloadId, () => {
      if (chrome.runtime.lastError) {
        console.warn("open download", chrome.runtime.lastError);
        chrome.downloads.show(downloadId);
      }
    });
  } else {
    chrome.downloads.showDefaultFolder();
  }
}

function renderDownloadStatus(prefixText, filename, downloadId) {
  statusEl.textContent = "";
  if (prefixText) {
    statusEl.append(`${prefixText} `);
  }

  const link = document.createElement("a");
  link.href = "#";
  link.textContent = filename;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openDownload(downloadId);
  });

  statusEl.append(link);
}

function isSupportedTab(tab) {
  try {
    const url = new URL(tab.url);
    return allowedHosts.has(url.hostname);
  } catch (error) {
    console.error("Failed to parse tab URL", error);
    return false;
  }
}

function toggleBulkForm(forceValue) {
  bulkFormVisible = typeof forceValue === "boolean" ? forceValue : !bulkFormVisible;
  bulkForm.classList.toggle("hidden", !bulkFormVisible);
  if (bulkFormVisible) {
    bulkTextarea.focus();
  }
}

function parseBulkQuestions(rawText) {
  return rawText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function withActiveChatGPTTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) {
      setStatus("No active tab found.");
      return;
    }

    const tab = tabs[0];
    if (!isSupportedTab(tab)) {
      setStatus("Open ChatGPT in the active tab first.");
      return;
    }

    callback(tab);
  });
}

function sendMessageWithInjection(tab, message, onSuccess, actionLabel) {
  chrome.tabs.sendMessage(tab.id, message, (response) => {
    if (chrome.runtime.lastError) {
      const errMsg = chrome.runtime.lastError.message || "";

      if (errMsg.includes("Could not establish connection")) {
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ["content.js"] },
          () => {
            if (chrome.runtime.lastError) {
              console.error(`${actionLabel} (inject)`, chrome.runtime.lastError);
              setStatus(chrome.runtime.lastError.message || `Failed to ${actionLabel}.`);
              return;
            }

            chrome.tabs.sendMessage(tab.id, message, (retryResponse) => {
              if (chrome.runtime.lastError) {
                console.error(`${actionLabel} (retry)`, chrome.runtime.lastError);
                setStatus(chrome.runtime.lastError.message || `Failed to ${actionLabel}.`);
                return;
              }
              onSuccess(retryResponse);
            });
          }
        );
        return;
      }

      console.error(actionLabel, chrome.runtime.lastError);
      setStatus(errMsg || `Failed to ${actionLabel}.`);
      return;
    }

    onSuccess(response);
  });
}

document.getElementById("collectNotes").addEventListener("click", () => {
  withActiveChatGPTTab((tab) => {
    sendMessageWithInjection(
      tab,
      { action: "collect_notes" },
      (response) => {
        if (response?.success) {
          const filename = response.filename || "chapter_notes.html";
          if (response.requestId) {
            pendingDownloads.set(response.requestId, { filename });
            renderPendingDownload(filename);
          } else {
            renderDownloadStatus("Saved", filename);
          }
          generateBtn.disabled = false;
        } else {
          setStatus(response?.error || "Failed to collect notes.");
        }
      },
      "collect notes"
    );
  });
});

generateBtn.addEventListener("click", () => {
  withActiveChatGPTTab((tab) => {
    sendMessageWithInjection(
      tab,
      { action: "generate_qa" },
      (response) => {
        if (response?.success) {
          const filename = response.filename || "chapter_qna.txt";
          if (response.requestId) {
            pendingDownloads.set(response.requestId, { filename });
            renderPendingDownload(filename);
          } else {
            renderDownloadStatus("Saved", filename);
          }
        } else {
          setStatus(response?.error || "Failed to generate Q&A.");
        }
      },
      "generate Q&A"
    );
  });
});

bulkBtn.addEventListener("click", () => {
  toggleBulkForm();
});

bulkCancelBtn.addEventListener("click", () => {
  toggleBulkForm(false);
  bulkTextarea.value = "";
  setStatus("Bulk entry cancelled.");
});

bulkSubmitBtn.addEventListener("click", () => {
  const questions = parseBulkQuestions(bulkTextarea.value);
  if (!questions.length) {
    setStatus("Paste at least one question.");
    return;
  }

  withActiveChatGPTTab((tab) => {
    sendMessageWithInjection(
      tab,
      { action: "bulk_questions", questions },
      (response) => {
        if (response?.success) {
          setStatus(`Queued ${response.enqueued || questions.length} question(s).`);
          bulkTextarea.value = "";
          toggleBulkForm(false);
        } else {
          setStatus(response?.error || "Failed to queue questions.");
        }
      },
      "queue questions"
    );
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "download_ready") {
    const pending = pendingDownloads.get(message.requestId);
    if (!pending) {
      return;
    }
    renderDownloadStatus("Saved", pending.filename || message.filename, message.downloadId);
    pendingDownloads.delete(message.requestId);
  }

  if (message.type === "download_error") {
    const pending = pendingDownloads.get(message.requestId);
    const filename = pending?.filename || message.filename || "file";
    setStatus(`Failed to save ${filename}. ${message.error || ""}`.trim());
    pendingDownloads.delete(message.requestId);
  }

  if (message.type === "bulk_status") {
    handleBulkStatus(message);
  }
});

function handleBulkStatus(message) {
  const { status, index, total, pending, remainingMs, elapsedMs, timeoutMs, error, question } = message;
  switch (status) {
    case "queued":
      setStatus(`Bulk queue ready: ${message.total} question(s).`);
      break;
    case "queued_more":
      setStatus(`Added ${message.added} question(s). Pending: ${pending}.`);
      break;
    case "started":
      setStatus(`Bulk run started (${message.total} question(s)).`);
      break;
    case "asking":
      setStatus(`Asking ${index}/${total}: ${truncate(question, 60)}`);
      break;
    case "waiting_reply":
      setStatus(buildWaitingStatus(index, total, elapsedMs, timeoutMs, message.generating));
      break;
    case "answered":
      setStatus(`Received ${index}/${total}.`);
      break;
    case "delay":
      setStatus(buildDelayStatus(index, total, remainingMs));
      break;
    case "complete":
      setStatus(`Bulk Q&A finished (${message.processed || 0} question(s)).`);
      break;
    case "error":
      setStatus(`Bulk Q&A stopped: ${error || "Unknown error"}.`);
      break;
    default:
      break;
  }
}

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatCountdown(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) {
    return "";
  }
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function buildWaitingStatus(index, total, elapsedMs = 0, timeoutMs = 0, generating = false) {
  const safeIndex = index || 0;
  const safeTotal = total || safeIndex || 1;
  const parts = [`Waiting for reply ${safeIndex}/${safeTotal}`];

  const elapsedText = formatCountdown(elapsedMs);
  if (elapsedText) {
    parts.push(`elapsed ${elapsedText}`);
  }

  if (timeoutMs) {
    const remaining = Math.max(timeoutMs - (elapsedMs || 0), 0);
    const remainingText = formatCountdown(remaining);
    if (remainingText) {
      parts.push(`time left ${remainingText}`);
    }
  }

  if (generating) {
    parts.push("ChatGPT still generating…");
  }

  return parts.join(" — ");
}

function buildDelayStatus(index, total, remainingMs = 0) {
  const nextIndex = (index || 0) + 1;
  const safeTotal = total || nextIndex;
  const countdown = formatCountdown(remainingMs);
  if (countdown) {
    return `Next question in ${countdown} (${nextIndex}/${safeTotal}).`;
  }
  return `Next question starting (${nextIndex}/${safeTotal}).`;
}
