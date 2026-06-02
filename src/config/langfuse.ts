import { Langfuse } from 'langfuse';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
  throw new Error('Langfuse keys are not set in environment variables');
}

const sampleRate = process.env.LANGFUSE_SAMPLE_RATE
  ? Number.parseFloat(process.env.LANGFUSE_SAMPLE_RATE)
  : 1.0;

if (sampleRate < 0 || sampleRate > 1 || Number.isNaN(sampleRate)) {
  throw new Error(
    `Invalid LANGFUSE_SAMPLE_RATE: ${process.env.LANGFUSE_SAMPLE_RATE}. Must be between 0 and 1.`,
  );
}

export const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
  sampleRate,
  flushAt: 10,
  flushInterval: 10000,
});

process.on('SIGINT', async () => {
  await langfuse.shutdownAsync();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await langfuse.shutdownAsync();
  process.exit(0);
});

export default langfuse;
