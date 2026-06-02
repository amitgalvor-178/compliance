/**
 * Adapted from galvor-tech/workflows src/services/transcription.ts
 * Downloads from Meta CDN using fetch (handles redirects + headers),
 * then transcribes with Azure Whisper.
 */

import { openai } from '../config/openai.js';
import { langfuse } from '../config/langfuse.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Azure deployment name for Whisper (set AZURE_WHISPER_DEPLOYMENT in Render env)
function getWhisperDeployment(): string {
  return process.env.AZURE_WHISPER_DEPLOYMENT || 'whisper';
}

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
    metadata: { postId },
  });

  const span = trace.span({ name: 'whisper-transcription' });
  let tempFilePath: string | null = null;

  try {
    const tempDir = os.tmpdir();
    // Derive extension from URL path (ignore query string)
    const urlPathname = new URL(mediaUrl).pathname;
    const ext = path.extname(urlPathname) || '.mp4';
    tempFilePath = path.join(tempDir, `compliance_${postId}_${Date.now()}${ext}`);

    span.event({ name: 'downloading-media' });
    await downloadToFile(mediaUrl, tempFilePath);

    const stats = fs.statSync(tempFilePath);
    if (stats.size === 0) throw new Error('Downloaded file is empty');
    span.event({ name: 'media-downloaded', metadata: { bytes: stats.size } });

    const deployment = getWhisperDeployment();
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: deployment,
      language: 'hi', // most Indian creators post in Hindi/Hinglish
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

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    // Mimic a browser UA — Meta CDN can return 403 to bare Node requests
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'video/mp4,video/*,*/*;q=0.9',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading media from CDN`);
  }

  const buffer = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buffer));
}
