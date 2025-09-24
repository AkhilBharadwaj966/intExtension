chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "save_file") {
    const makeDataUrl = (text, mimeType = "text/plain") => {
      const encoded = encodeURIComponent(text);
      return `data:${mimeType};charset=utf-8,${encoded}`;
    };

    const url = makeDataUrl(message.content || "", message.mimeType);

    chrome.downloads.download(
      {
        url,
        filename: message.filename,
        saveAs: true
      },
      (downloadId) => {
        if (chrome.runtime.lastError || typeof downloadId !== "number") {
          const errorMessage = chrome.runtime.lastError?.message || "Download failed";
          console.error("save_file", errorMessage);
          chrome.runtime.sendMessage({
            type: "download_error",
            requestId: message.requestId,
            filename: message.filename,
            error: errorMessage
          });
        } else {
          chrome.runtime.sendMessage({
            type: "download_ready",
            requestId: message.requestId,
            filename: message.filename,
            downloadId
          });
        }
      }
    );

    if (typeof sendResponse === "function") {
      sendResponse({ acknowledged: true });
    }
  }
});
