import { createApp } from './app';
import { runtimeConfig } from './config/env';
import { initDatabase } from './config/database';
import { backfillBookCovers } from './services/book.service';
import { batchTranslationService } from './services/batch-translation.service';
import { readingGuideService } from './services/reading-guide.service';
import { initializeCacheService } from './services/cache.service';
import { ollamaBootstrapService } from './services/ollama-bootstrap.service';

initDatabase();
initializeCacheService();
ollamaBootstrapService.initialize();
backfillBookCovers();
batchTranslationService.resumeInterruptedJobs();
readingGuideService.resumeInterruptedGuides();

const app = createApp();
const server = app.listen(runtimeConfig.port, runtimeConfig.host, () => {
  const address = `http://${runtimeConfig.host}:${runtimeConfig.port}`;
  console.log(`FolioPaw server listening on ${address}`);
  if (runtimeConfig.host === '0.0.0.0' || runtimeConfig.host === '::') {
    console.warn('The server has no account or access-control layer and is listening on all interfaces. Restrict access with a firewall or trusted reverse proxy.');
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${runtimeConfig.port} is already in use.`);
  } else {
    console.error('Server failed to start:', error.message);
  }
  process.exitCode = 1;
});
