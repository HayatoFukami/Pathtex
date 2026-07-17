import { z } from 'zod';
import { err, ok } from './result.js';
import type { Result } from './result.js';
export const embedFieldSchema = z.object({
  name: z.string(),
  value: z.string(),
  inline: z.boolean().optional(),
});
export type EmbedField = z.infer<typeof embedFieldSchema>;
const embedMetadataSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  footer: z.object({ text: z.string().max(2048) }).optional(),
  author: z.object({ name: z.string().max(256) }).optional(),
  timestamp: z.string().optional(),
});
const unicodeLength = (value: string): number => Array.from(value).length;
export function splitEmbedFields(
  input: unknown,
  metadata: unknown = {},
): Result<EmbedField[][]> {
  const parsed = z.array(embedFieldSchema).safeParse(input);
  const parsedMetadata = embedMetadataSchema.safeParse(metadata);
  if (!parsed.success || !parsedMetadata.success)
    return err('INVALID_INPUT', 'Invalid embed fields');
  for (const field of parsed.data) {
    if (unicodeLength(field.name) > 256 || unicodeLength(field.value) > 1024)
      return err('INVALID_INPUT', 'Embed field exceeds Discord limits');
  }
  const metadataSize = Object.values(parsedMetadata.data).reduce(
    (size, value) => {
      if (typeof value === 'string') return size + unicodeLength(value);
      if (value && 'text' in value) return size + unicodeLength(value.text);
      if (value && 'name' in value) return size + unicodeLength(value.name);
      return size;
    },
    0,
  );
  if (metadataSize > 6000)
    return err('INVALID_INPUT', 'Embed exceeds Discord character limit');
  const chunks: EmbedField[][] = [];
  let current: EmbedField[] = [];
  let size = metadataSize;
  for (const field of parsed.data) {
    const fieldSize = unicodeLength(field.name) + unicodeLength(field.value);
    if (metadataSize + fieldSize > 6000)
      return err('INVALID_INPUT', 'Embed field cannot fit in embed');
    if (current.length >= 25 || size + fieldSize > 6000) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(field);
    size += fieldSize;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return ok(chunks);
}
