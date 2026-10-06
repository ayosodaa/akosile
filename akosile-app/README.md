# Akosile

Akosile is a private transcription app. Whisper runs inside your browser, so recordings never leave your computer.

## Deploy on Vercel

1. Create a new empty repository on GitHub, for example `akosile`.
2. On the repository page, click **uploading an existing file** and drag in everything inside this folder. Commit the upload.
3. In Vercel, click **Add New Project**, import the repository and click **Deploy**. Vercel reads `vercel.json`, so you do not need to change any settings.
4. Open the address Vercel gives you in Chrome or Edge.

## Run it on your own computer

You need Node.js 20 or newer.

```
npm install --ignore-scripts
npm run dev
```

Then open http://localhost:5173.

## How it works

- `src/worker.js` loads Whisper with Transformers.js and transcribes the audio in sections of up to 30 seconds, cutting at pauses.
- `src/main.js` handles the interface, the corrections list, playback, exports and the Claude summary.
- The browser downloads the model the first time and keeps it for later visits.
- `vercel.json` sets two security headers that let the processor fallback use several CPU cores.
