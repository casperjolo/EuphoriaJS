import { installGlobals, startAssetServer, run } from './harness.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

installGlobals();
const server = await startAssetServer();

console.log('EuphoriaJS — headless animation tests');
console.log(`  assets served from ${server.base}\n`);

// Importing the test files registers them with the runner.
await import('./unit.test.mjs');
await import('./integration.test.mjs');
const { registerPipeline } = await import('./pipeline.test.mjs');
registerPipeline(() => new GLTFLoader());

const failures = await run();
await server.close();
process.exit(failures ? 1 : 0);
