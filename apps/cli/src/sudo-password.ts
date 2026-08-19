import type { SudoPasswordProvider } from '@opsense/ssh';

interface HiddenInputStream {
  isPaused(): boolean;
  isRaw?: boolean;
  isTTY?: boolean;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  setRawMode?(mode: boolean): unknown;
}

interface PromptOutputStream {
  write(value: string): unknown;
}

export function createInteractiveSudoPasswordProvider(
  input: HiddenInputStream = process.stdin,
  output: PromptOutputStream = process.stderr,
): SudoPasswordProvider | undefined {
  if (input.isTTY !== true || input.setRawMode === undefined) return undefined;
  let cached: string | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    pending ??= readHiddenPassword(input, output).then((value) => {
      cached = value;
      return value;
    });
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

function readHiddenPassword(input: HiddenInputStream, output: PromptOutputStream): Promise<string> {
  const wasPaused = input.isPaused();
  const wasRaw = input.isRaw === true;
  output.write('Sudo password: ');
  input.setRawMode?.(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    let completed = false;
    const finish = (error?: Error): void => {
      if (completed) return;
      completed = true;
      input.off('data', onData);
      if (!wasRaw) input.setRawMode?.(false);
      if (wasPaused) input.pause();
      output.write('\n');
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          finish(value.length === 0 ? new Error('Sudo password cannot be empty.') : undefined);
          return;
        }
        if (character === '\u0003') {
          finish(new Error('Sudo password input was cancelled.'));
          return;
        }
        if (character === '\b' || character === '\u007f') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if ((character.codePointAt(0) ?? 0) >= 32) value += character;
      }
    };
    input.on('data', onData);
  });
}
