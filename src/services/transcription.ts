/**
 * Adapted from galvor-tech/workflows src/services/transcription.ts
 * Removed GCS dependency — downloads directly from the Meta-provided media URL.
 */

import { openai } from '../config/openai.js';
import { langfuse } from '../config/langfuse.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import https from 'https';
import http from 'http';

export interface TranscriptionResult {
  text: string;
  wordCount: number;
  processingTimeMs: number;
}

export async function transcribeFromUrl(
  mediaUrl: string,
  postId: string,
): Promise<TranscriptionResult> {
  const startTime = Date.now();

  const trace = langfuse.trace({
    name: 'compliance-transcribe-media',
    metadata: { postId, mediaUrl },
  });

  const span = trace.span({ name: 'whisper-transcription' });
  let tempFilePath: string | null = null;

  try {
    const tempDir = os.tmpdir();
    const urlPath = new URL(mediaUrl).pathname;
    const ext = path.extname(urlPath) || '.mp4';
    tempFilePath = path.join(tempDir, `compliance_${postId}_${Date.now()}${ext}`);

    span.event({ name: 'downloading-media', metadata: { mediaUrl } });
    await downloadToFile(mediaUrl, tempFilePath);

    const stats = fs.statSync(tempFilePath);
    span.event({ name: 'media-downloaded', metadata: { bytes: stats.size } });

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'whisper-1',
      language: 'en',
      response_format: 'text',
    });

    const text =
      typeof transcription === 'string' ? transcription : (transcription as any).text ?? '';
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    span.update({ output: { wordCount, textLength: text.length } });
    span.end();
    trace.update({ output: { success: true, wordCount } });
    await langfuse.flushAsync();

    return { text, wordCount, processingTimeMs: Date.now() - startTime };
  } catch (error: any) {
    span.update({ level: 'ERROR', statusMessage: error.message });
    span.end();
    trace.update({ output: { success: false, error: error.message } });
    await langfuse.flushAsync();
    throw error;
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}

function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    protocol
      .get(url, (res) => {
        // Follow redirects (Meta CDN often redirects)
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close(() => {
            fs.unlinkSync(dest);
            downloadToFile(res.headers.location!, dest).then(resolve).catch(reject);
          });
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          file.close(() => fs.unlink(dest, () => {}));
          reject(new Error(`HTTP ${res.statusCode} downloading media`));
          return;
        }

        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}
