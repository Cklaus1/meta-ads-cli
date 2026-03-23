import { describe, it, expect } from 'vitest';
import { detectMimeType } from '../../src/mime.js';

describe('detectMimeType', () => {
  describe('images', () => {
    it('detects JPEG', () => {
      expect(detectMimeType('photo.jpg')).toBe('image/jpeg');
      expect(detectMimeType('photo.jpeg')).toBe('image/jpeg');
    });

    it('detects PNG', () => {
      expect(detectMimeType('image.png')).toBe('image/png');
    });

    it('detects GIF', () => {
      expect(detectMimeType('anim.gif')).toBe('image/gif');
    });

    it('detects WebP', () => {
      expect(detectMimeType('photo.webp')).toBe('image/webp');
    });

    it('detects SVG', () => {
      expect(detectMimeType('icon.svg')).toBe('image/svg+xml');
    });
  });

  describe('video', () => {
    it('detects MP4', () => {
      expect(detectMimeType('video.mp4')).toBe('video/mp4');
    });

    it('detects MOV', () => {
      expect(detectMimeType('clip.mov')).toBe('video/quicktime');
    });

    it('detects WebM', () => {
      expect(detectMimeType('video.webm')).toBe('video/webm');
    });
  });

  describe('documents', () => {
    it('detects PDF', () => {
      expect(detectMimeType('doc.pdf')).toBe('application/pdf');
    });

    it('detects CSV', () => {
      expect(detectMimeType('data.csv')).toBe('text/csv');
    });

    it('detects JSON', () => {
      expect(detectMimeType('config.json')).toBe('application/json');
    });
  });

  describe('edge cases', () => {
    it('is case-insensitive', () => {
      expect(detectMimeType('PHOTO.JPG')).toBe('image/jpeg');
      expect(detectMimeType('Image.PNG')).toBe('image/png');
    });

    it('handles paths with directories', () => {
      expect(detectMimeType('/path/to/file.mp4')).toBe('video/mp4');
    });

    it('uses last extension for multi-dot filenames', () => {
      expect(detectMimeType('archive.tar.gz')).toBe('application/gzip');
    });

    it('returns octet-stream for unknown extension', () => {
      expect(detectMimeType('file.xyz')).toBe('application/octet-stream');
    });

    it('returns octet-stream for no extension', () => {
      expect(detectMimeType('Makefile')).toBe('application/octet-stream');
    });
  });
});
