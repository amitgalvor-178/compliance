import { AzureOpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.AZURE_OPEN_AI_ENDPOINT) {
  throw new Error('AZURE_OPEN_AI_ENDPOINT is not set in environment variables');
}

if (!process.env.AZURE_OPEN_AI_KEY) {
  throw new Error('AZURE_OPEN_AI_KEY is not set in environment variables');
}

export const openai = new AzureOpenAI({
  endpoint: process.env.AZURE_OPEN_AI_ENDPOINT,
  apiKey: process.env.AZURE_OPEN_AI_KEY,
  apiVersion: '2024-08-01-preview',
});

export default openai;
