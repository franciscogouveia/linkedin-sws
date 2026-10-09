import assert from 'node:assert/strict';
import test from 'node:test';
import { profileData } from '../src/writing/profile-data.ts';

test('a long About section cannot displace the headline or venture-capital Experience', () => {
  const result = profileData(
    {
      name: 'Example Person',
      text: '',
      sections: {
        header: 'Example Person\nTech PR | Angel Investor',
        about: 'Biography '.repeat(4_000),
        experience:
          'Principal at Example Ventures\nEarly-stage venture capital fund',
      },
    },
    'example-person',
  );
  assert.equal(result.truncated, true);
  assert.match(
    result.text,
    /HEADER\nExample Person\nTech PR \| Angel Investor/,
  );
  assert.match(result.text, /EXPERIENCE\nPrincipal at Example Ventures/);
  assert.equal(result.sections?.about.length, 7_000);
  assert.ok(result.text.length <= 24_000);
});

test('section budgets bound all source fields while retaining full short profiles', () => {
  const sections = {
    header: 'Angel Investor',
    about: '',
    experience: 'Startup investing',
  };
  const short = profileData({ name: 'Example', text: '', sections }, 'example');
  assert.deepEqual(short.sections, sections);
  assert.equal(short.truncated, false);
  const long = profileData(
    {
      name: 'Example',
      text: '',
      sections: {
        header: 'h'.repeat(8_000),
        about: 'a'.repeat(9_000),
        experience: 'e'.repeat(30_000),
      },
    },
    'example',
  );
  assert.equal(long.sections?.header.length, 4_000);
  assert.equal(long.sections?.experience.length, 12_000);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 24_000);
});
