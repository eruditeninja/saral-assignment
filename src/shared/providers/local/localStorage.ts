import fs from 'fs';
import path from 'path';
import { IStorageProvider } from '../types';
import { logger } from '../../logger';

/**
 * Local filesystem-backed storage provider.
 * Writes media files to a local directory and returns localhost URLs.
 */
export class LocalStorageProvider implements IStorageProvider {
  private readonly mediaDir: string;
  private readonly baseUrl: string;

  /**
   * @param mediaDir - Absolute or relative path to the media directory
   * @param port - Server port for constructing localhost URLs
   */
  constructor(mediaDir: string, port: number) {
    this.mediaDir = path.resolve(process.cwd(), mediaDir);
    this.baseUrl = `http://localhost:${port}`;

    // Ensure media directory exists
    if (!fs.existsSync(this.mediaDir)) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
    }
  }

  async upload(key: string, data: Buffer, _contentType?: string): Promise<string> {
    const filePath = path.resolve(this.mediaDir, key);

    // Ensure subdirectories exist (for keys like "matcha/abc.jpg")
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(filePath, data);

    const url = this.getUrl(key);
    logger.debug({ key, filePath, url }, 'Uploaded file to local storage');
    return url;
  }

  getUrl(key: string): string {
    return `${this.baseUrl}/media/${key}`;
  }

  async close(): Promise<void> {
    // No resources to clean up for local filesystem
  }
}
