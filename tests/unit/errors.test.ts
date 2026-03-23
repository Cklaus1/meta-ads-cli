import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleErrors } from '../../src/errors.js';

describe('handleErrors', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the wrapped function with arguments', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = handleErrors(fn);
    await wrapped('a', 'b');
    expect(fn).toHaveBeenCalledWith('a', 'b');
  });

  it('does nothing on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = handleErrors(fn);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await wrapped();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints Error message and exits on Error throw', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('something broke'));
    const wrapped = handleErrors(fn);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await wrapped();
    expect(errorSpy).toHaveBeenCalledWith('Error: something broke');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('stringifies non-Error thrown values', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    const wrapped = handleErrors(fn);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await wrapped();
    expect(errorSpy).toHaveBeenCalledWith('Error: string error');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('handles object thrown values', async () => {
    const fn = vi.fn().mockRejectedValue({ code: 42 });
    const wrapped = handleErrors(fn);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await wrapped();
    expect(errorSpy).toHaveBeenCalledWith('Error: [object Object]');
  });
});
