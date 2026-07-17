import RE2 from 're2';

export const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
export function antiInvite(content: string): { code: string } | null {
  const re = new RE2(
    /(?:d\s*i\s*s\s*c\s*o\s*r\s*d\s*(?:\.\s*g\s*g|\.\s*c\s*o\s*m\s*\/\s*i\s*n\s*v\s*i\s*t\s*e|a\s*p\s*p\s*\.\s*c\s*o\s*m\s*\/\s*i\s*n\s*v\s*i\s*t\s*e)|discord\s*(?:dot|\(\.\))\s*gg)\s*[\s/]*([A-Za-z0-9_-]{2,32})/iu,
  );
  const match = re.exec(content);
  return match?.[1] ? { code: match[1] } : null;
}
export function antiInvites(content: string): readonly { code: string }[] {
  const re = new RE2(
    /(?:d\s*i\s*s\s*c\s*o\s*r\s*d\s*(?:\.\s*g\s*g|\.\s*c\s*o\s*m\s*\/\s*i\s*n\s*v\s*i\s*t\s*e|a\s*p\s*p\s*\.\s*c\s*o\s*m\s*\/\s*i\s*n\s*v\s*i\s*t\s*e)|discord\s*(?:dot|\(\.\))\s*gg)\s*[\s/]*([A-Za-z0-9_-]{2,32})/giu,
  );
  return [...content.matchAll(re)].flatMap((match) =>
    match[1] ? [{ code: match[1] }] : [],
  );
}
export function antiReferral(
  content: string,
  domains: readonly string[] = [],
): boolean {
  const urlRe = new RE2(/https?:\/\/[^\s<>]+/giu);
  for (const raw of content.match(urlRe) ?? []) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLocaleLowerCase().replace(/\.$/u, '');
      if (
        url.pathname.toLocaleLowerCase().includes('/ref/') ||
        /(?:^|[?&#])(ref|referrer|referral)=/iu.test(url.search + url.hash) ||
        domains.some((domain) => {
          const registered = domain
            .trim()
            .toLocaleLowerCase()
            .replace(/^\.+|\.+$/gu, '');
          return (
            registered.length > 0 &&
            (host === registered || host.endsWith(`.${registered}`))
          );
        })
      )
        return true;
    } catch {
      /* malformed URLs are not referral URLs */
    }
  }
  return false;
}
export const lineCount = (content: string) =>
  content.split(/\r\n|\r|\n/u).length;
export const mentionCount = (
  ids: readonly string[],
  self: string,
  bots = new Set<string>(),
) => new Set(ids.filter((id) => id !== self && !bots.has(id))).size;
export const safeUserPattern = (pattern: string): RE2 => {
  if (
    !pattern ||
    Array.from(pattern).length > 500 ||
    /\\[1-9]|\(\?<([=!])/u.test(pattern)
  )
    throw new Error('unsafe regular expression');
  return new RE2(pattern);
};
export function duplicateKey(
  message: Pick<AutomodMessageLike, 'content' | 'attachments' | 'embeds'>,
): string {
  return normalize(
    [
      message.content,
      ...(message.attachments ?? []).map((item) =>
        typeof item === 'string' ? item : JSON.stringify(item),
      ),
      ...(message.embeds ?? []).flatMap((e) => [
        e.title ?? '',
        e.description ?? '',
      ]),
    ].join(' '),
  );
}
interface AutomodMessageLike {
  content: string;
  attachments?: readonly (string | Record<string, unknown>)[];
  embeds?: readonly { title?: string | null; description?: string | null }[];
}
export interface DuplicateEntry {
  content: string;
  at: number;
  ordinal: number;
  messages: readonly { channelId: string; messageId: string; at: number }[];
}
export class DuplicateLru {
  private readonly values = new Map<string, DuplicateEntry>();
  public constructor(
    private readonly max = 3000,
    private readonly ttl = 30_000,
  ) {}
  public observe(
    key: string,
    content: string,
    channelId: string,
    messageId: string,
    now: number,
  ): DuplicateEntry {
    const old = this.values.get(key);
    const same =
      old &&
      old.content === content &&
      now >= old.at &&
      now - old.at <= this.ttl;
    const entry: DuplicateEntry = {
      content,
      at: now,
      ordinal: same ? old.ordinal + 1 : 1,
      messages: [
        ...(same ? old.messages : []),
        { channelId, messageId, at: now },
      ]
        .filter((m) => now - m.at <= 120_000)
        .slice(-20),
    };
    this.values.delete(key);
    this.values.set(key, entry);
    while (this.values.size > this.max) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return entry;
  }
  public clear(): void {
    this.values.clear();
  }
  public get(key: string): DuplicateEntry | undefined {
    return this.values.get(key);
  }
}
export interface CopypastaDefinition {
  readonly name: string;
  readonly requiredPhrases: readonly string[];
  readonly optionalPhrases?: readonly string[];
  readonly minimumOptionalMatches?: number;
}
export function parseCopypastaResource(text: string): CopypastaDefinition[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => {
      const [name, required = '', optional = '', minimum = '0'] =
        line.split('|');
      if (!name || !required) return [];
      return [
        {
          name,
          requiredPhrases: required
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          optionalPhrases: optional
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          minimumOptionalMatches: Number.parseInt(minimum, 10) || 0,
        },
      ];
    });
}
export function copypastaMatch(
  content: string,
  definitions: readonly CopypastaDefinition[],
): CopypastaDefinition | null {
  const value = normalize(content);
  return (
    definitions.find(
      (definition) =>
        definition.requiredPhrases.every((phrase) =>
          value.includes(normalize(phrase)),
        ) &&
        (definition.optionalPhrases ?? []).filter((phrase) =>
          value.includes(normalize(phrase)),
        ).length >= (definition.minimumOptionalMatches ?? 0),
    ) ?? null
  );
}
