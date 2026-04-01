import { describe, it, expect } from 'vitest';
import { checkDep } from '../_deps.js';
import { TranscribeError } from '../_errors.js';

describe('checkDep', () => {
  it('does not throw for an existing executable (node)', async () => {
    await expect(checkDep('node', 'Install node')).resolves.toBeUndefined();
  });

  it('error path: throws TranscribeError for non-existent tool', async () => {
    await expect(checkDep('__nonexistent_tool_xyz__', 'Install: example.com')).rejects.toThrow(TranscribeError);
  });

  it('error path: error message includes the install hint', async () => {
    try {
      await checkDep('__nonexistent_tool_xyz__', 'Install: pip install something');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscribeError);
      expect((err as Error).message).toContain('Install: pip install something');
    }
  });

  it('error path: error message includes the tool name', async () => {
    try {
      await checkDep('__nonexistent_tool_xyz__', 'some hint');
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('__nonexistent_tool_xyz__');
    }
  });
});
