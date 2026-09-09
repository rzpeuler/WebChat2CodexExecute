import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('main-process application wiring', () => {
  it('recovers application state before creating the first window', async () => {
    const source = await readFile(new URL('../../src/main/app.ts', import.meta.url), 'utf8');
    const initialization = source.indexOf('applicationState = await initializeApplicationState');
    const windowCreation = source.indexOf('await createWindow(applicationState);');
    const readyHandler = source.indexOf('void app.whenReady().then(() => initializationGate.initialize());');

    expect(initialization).toBeGreaterThan(-1);
    expect(windowCreation).toBeGreaterThan(initialization);
    expect(readyHandler).toBeGreaterThan(-1);
    expect(source).toContain('createInitializationGate');
    expect(source).toContain('initializationGate.reset();');
    expect(source).toContain("console.error('[application] initialization failed'");
    expect(source).toContain('new AtomicJsonFileStore<TopLevelState>');
    expect(source).toContain('new JsonlFileEventLog<TopLevelStateTransitionEvent>');
  });
});
