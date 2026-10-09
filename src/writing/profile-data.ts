import type { ProfilePageState } from './profile-page.ts';
import type { Profile } from '../shared/types.ts';

// Reserve space for each section so a lengthy About cannot displace Experience.
export function profileData(state: ProfilePageState, slug: string): Profile {
  if (!state.sections) {
    return {
      slug,
      name: state.name,
      text: state.text.slice(0, 24_000),
      truncated: state.text.length > 24_000,
    };
  }
  const limits = { header: 4_000, about: 7_000, experience: 12_000 };
  const sections = { header: '', about: '', experience: '' };
  let truncated = false;
  for (const key of ['header', 'about', 'experience'] as const) {
    sections[key] = state.sections[key].slice(0, limits[key]);
    truncated ||= state.sections[key].length > limits[key];
  }
  return {
    slug,
    name: state.name,
    sections,
    truncated,
    text: Object.entries(sections)
      .filter(([, text]) => text)
      .map(([label, text]) => `${label.toUpperCase()}\n${text}`)
      .join('\n\n'),
  };
}
