import Bottleneck from 'bottleneck';
import dotenv from 'dotenv';

dotenv.config();

const MAX_CONCURRENT = Number.parseInt(process.env.ANALYSIS_MAX_CONCURRENT || '5', 10);
const MIN_TIME_MS = Number.parseInt(process.env.ANALYSIS_MIN_TIME_MS || '10', 10);
const MAX_RETRIES = Number.parseInt(process.env.ANALYSIS_MAX_RETRIES || '3', 10);

export const analysisLimiter = new Bottleneck({
  maxConcurrent: MAX_CONCURRENT,
  minTime: MIN_TIME_MS,
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 1000,
});

analysisLimiter.on('failed', async (error, jobInfo) => {
  const id = jobInfo.options.id;
  console.warn(`Job ${id} failed: ${error.message}`);
  if (error.message.includes('429') || error.message.includes('rate limit')) {
    if (jobInfo.retryCount < MAX_RETRIES) {
      return 2000;
    }
  }
  return undefined;
});

analysisLimiter.on('retry', (error: unknown, jobInfo) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.log(`Job ${jobInfo.options.id} retrying: ${msg}`);
});

export default analysisLimiter;
