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

## Faster transcription

The browser engine can be slow on long recordings. Two free routes run Whisper faster, and Akosile opens their results with **Import a transcript**.

### Buzz on your Mac

Buzz is a free desktop app that runs Whisper with Apple Silicon acceleration. Current versions need an M1 or later Mac.

1. Download the `.dmg` from https://sourceforge.net/projects/buzz-captions/files/ and drag Buzz into Applications.
2. macOS blocks the first launch because Buzz is unsigned. Open System Settings, then Privacy & Security, and click **Open Anyway** next to the Buzz message.
3. In Buzz, choose **File**, then **Import Media File**, and pick your recording.
4. Set the task to Transcribe, set the language yourself, choose **Whisper.cpp** as the model type and **Large v3 Turbo** as the size. If Turbo is not listed, choose Large v3.
5. Under **Advanced**, list names and terms in the initial prompt, for example `Oluwapelumi, Ikeja, naira`.
6. Choose **SRT** as the export format and click **Run**.
7. When the status shows Completed, open the transcript and export it as SRT. Import that file into Akosile.

### Google Colab notebook

`Akosile_Fast_Transcriber.ipynb` runs Whisper Large v3 Turbo on a free Google graphics card.

1. Go to https://colab.research.google.com, choose **File**, then **Upload notebook**, and pick the notebook.
2. Choose **Runtime**, then **Change runtime type**, select **T4 GPU** and save.
3. Fill in the settings cell, then choose **Runtime**, then **Run all**.
4. Upload your recording when asked. Your browser downloads an `.srt` file and a `.zip` file at the end.
5. Import the `.srt` file into Akosile.
