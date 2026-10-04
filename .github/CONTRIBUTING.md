# Contributing

Thanks for helping make Meetingly better.

## Setup

```bash
cd app
npm install
npm run fetch:asr   # speech engine for your platform
npm run dev
```

## Before you open a pull request

- `npm run typecheck` and `npm test` pass in `app/`.
- Keep changes focused: one fix or feature per pull request.
- Match the style around your change. State lives in the main process; windows only call `window.api`.
- Never commit keys or tokens. The app talks to the relay (provider keys live only on the server) or, with
  *Use your own API key*, straight to the user's endpoint with a key kept encrypted on their computer.

## Project layout

- `app/electron/` main process: services (transcription, chat, suggestions, meetings), windows, IPC
- `app/src/` renderer: the toolbar and the panel (settings, instructions and meetings are on the web dashboard)
- `app/shared/` types and the typed IPC contract
- `relay/` the server that holds the API keys and picks the model per task
