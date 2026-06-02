import dotenv from 'dotenv';
dotenv.config();

import { app } from './app.js';

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`[compliance] Server running at http://localhost:${PORT}`);
});
