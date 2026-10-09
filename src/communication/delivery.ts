import type { Investor } from '../shared/types.ts';
import { terminalText } from './terminal.ts';

export async function displayMessage(
  recipient: Investor,
  message: string,
  output: (text: string) => Promise<void>,
): Promise<void> {
  await output(
    terminalText(
      `\nTo: ${recipient.name}\nProfile: https://www.linkedin.com/in/${recipient.slug}/\n\n${message}\n\n`,
    ),
  );
}
