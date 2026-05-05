# Genki Dictionary

Static Telegram Mini App for a personal Genki Japanese dictionary.

## What it does

- Lists Genki lessons.
- Creates lessons with lesson and page numbers.
- Adds Japanese words with optional furigana and translation.
- Keeps furigana hidden by default and reveals it per word.
- Uses `Telegram.WebApp.CloudStorage` inside Telegram.
- Uses `localStorage` in a normal browser during development.

## Local development

Open `index.html` directly in a browser, or run a local static server:

```sh
npm run dev
```

Then open:

```text
http://localhost:4173
```

## Telegram setup

The bot token is not used by this frontend and must not be placed in the app.

For Telegram:

1. Deploy these static files to an HTTPS URL.
2. Open BotFather.
3. Configure `@genkidicbot` Mini App.
4. Use short name `genki`.
5. Point it to the deployed HTTPS URL.

After that the Mini App link should be:

```text
https://t.me/genkidicbot/genki
```
