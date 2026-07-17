export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export class DomainError extends Error {
  public constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Result<never> => ({
  ok: false,
  error: new DomainError(code, message, details),
});
