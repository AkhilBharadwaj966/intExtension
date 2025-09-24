# UPSC Notes & Anki Generator 

A Chromium extension that makes it easy to harvest  conversations for UPSC prep:

- Save the current conversation as a polished HTML notes file with a one-click **Copy All** toolbar.
- Generate Anki-friendly Q&A text from every user ↔ assistant exchange (`Question | Answer` per line, using the chat title for the filename).
- Queue a batch of prompts with **Ask In Bulk** – questions are posted one at a time, each reply is awaited, and the extension pauses 5‑20 s between sends while showing real-time progress in the popup.

## Install / Load

1. Clone or download this folder to your machine.
2. Open `chrome://extensions` (or the equivalent in Brave/Edge).
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the project directory.

Reload the extension from this page whenever you pull updates or edit the files.

## Popup Controls

| Button | What It Does |
| --- | --- |
| **Collect Notes (.html)** | Extracts all assistant responses into a single, styled `chapter_notes.html` download (links stripped, citations removed). |
| **Generate Anki Q&A (.txt)** | Produces `chat-title.txt` containing every prompt/response pair as `Question | Answer`. |
| **Ask In Bulk** | Opens a textarea: paste one question per line, click **Done**, and the extension will feed them to chat sequentially. The popup status area streams queue progress, delays, and waiting times. |

## Bulk Asking Tips

- Keep the chat tab visible so the automation can locate the composer and watch replies.
- Long replies are supported (wait timeout is 5 minutes). If chat is throttled or throws a captcha, the popup reports the error and stops the queue.
- You can reopen the popup at any time to see the latest status.

## Project Structure

```
background.js   # Downloads files and relays download/bulk status
content.js      # Injected into website – scraping, file generation, bulk queue logic
popup.html/js   # Popup UI and messaging glue
manifest.json   # Chromium extension manifest (MV3)
```

## Developing / Tweaking

- Edit files in this folder and reload the extension from `chrome://extensions`.
- The project is plain JavaScript/HTML/CSS; no build step.
- When experimenting with the content script, remember it runs inside the chat page – use the page DevTools console for quick debugging (`console.log` output appears there).

## License

This repo is provided as-is for personal use. Verify compliance with OpenAI’s terms before running automated conversations at scale.
