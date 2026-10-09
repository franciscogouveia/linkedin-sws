import { stripVTControlCharacters } from 'node:util';

export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    '',
  );
}
