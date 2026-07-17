import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export interface ResourceLoaderOptions {
  readonly baseDir?: string;
}
export class ResourceLoader {
  public constructor(private readonly options: ResourceLoaderOptions = {}) {}
  public async text(name: string): Promise<string | null> {
    try {
      return await readFile(
        resolve(this.options.baseDir ?? process.cwd(), name),
        'utf8',
      );
    } catch {
      return null;
    }
  }
}
