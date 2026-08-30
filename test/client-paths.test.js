import { describe, it, expect } from 'vitest';
import { isAbsolutePath, joinBrowsePath } from '../public/modules/paths.js';

// The directory browser talks to a server that answers in its own platform's
// path shape. A leading-slash test called every Windows path relative, which
// silently threw away a typed `C:\repos\thing` and sent the picker home.
describe('isAbsolutePath', () => {
  it('accepts POSIX absolute paths', () => {
    expect(isAbsolutePath('/')).toBe(true);
    expect(isAbsolutePath('/home/me/repo')).toBe(true);
  });

  it('accepts Windows drive-letter paths in either separator', () => {
    expect(isAbsolutePath('C:\\Users\\lawso')).toBe(true);
    expect(isAbsolutePath('C:/Users/lawso')).toBe(true);
    expect(isAbsolutePath('d:\\repos')).toBe(true);
  });

  it('accepts a UNC share', () => {
    expect(isAbsolutePath('\\\\server\\share\\repo')).toBe(true);
  });

  it('rejects relative paths and empty input', () => {
    expect(isAbsolutePath('Projects/thing')).toBe(false);
    expect(isAbsolutePath('..\\thing')).toBe(false);
    expect(isAbsolutePath('C:')).toBe(false);     // drive with no separator
    expect(isAbsolutePath('')).toBe(false);
    expect(isAbsolutePath(null)).toBe(false);
    expect(isAbsolutePath(undefined)).toBe(false);
  });
});

describe('joinBrowsePath', () => {
  it('keeps the separator the directory already uses', () => {
    expect(joinBrowsePath('/home/me', 'repo')).toBe('/home/me/repo');
    expect(joinBrowsePath('C:\\Users\\lawso', 'repo')).toBe('C:\\Users\\lawso\\repo');
  });

  it('does not double the separator at a root', () => {
    expect(joinBrowsePath('/', 'home')).toBe('/home');
    expect(joinBrowsePath('C:\\', 'Users')).toBe('C:\\Users');
  });

  it('treats a forward-slash Windows path as forward-slash', () => {
    expect(joinBrowsePath('C:/Users', 'lawso')).toBe('C:/Users/lawso');
  });

  it('leaves a UNC share intact', () => {
    expect(joinBrowsePath('\\\\server\\share', 'repo')).toBe('\\\\server\\share\\repo');
  });
});
