import { describe, it, expect } from 'vitest';
import { fuzzyMatchSkills, type ISkillMatch } from './fuzzySkills';
import type { ISkill } from './state';

const skill = (name: string, description: string): ISkill => ({ name, description, args: [] });

const SKILLS: ISkill[] = [
  skill('generate-background', 'Generate a wide, opaque background/scene and add it to the Asset Board.'),
  skill('generate-sprite', 'Generate a game sprite from a description and add it to the Asset Board.'),
  skill('manage-assets', 'Review the Asset Board and remove assets you no longer want (deletion is confirmed).'),
];

// Concatenating a match's segments must reproduce the original string.
const joinName = (m: ISkillMatch) => m.nameSegments.map((s) => s.text).join('');
const joinDesc = (m: ISkillMatch) => m.descSegments.map((s) => s.text).join('');

describe('fuzzyMatchSkills — boundary cases', () => {
  it('returns all skills in input order for an empty query, with no highlights', () => {
    const out = fuzzyMatchSkills(SKILLS, '');
    expect(out.map((m) => m.skill.name)).toEqual(['generate-background', 'generate-sprite', 'manage-assets']);
    expect(out.every((m) => m.nameSegments.every((s) => !s.matched))).toBe(true);
    expect(out.every((m) => m.descSegments.every((s) => !s.matched))).toBe(true);
  });

  it('treats a whitespace-only query as empty', () => {
    expect(fuzzyMatchSkills(SKILLS, '   ').map((m) => m.skill.name)).toEqual(['generate-background', 'generate-sprite', 'manage-assets']);
  });

  it('returns [] when nothing matches', () => {
    expect(fuzzyMatchSkills(SKILLS, 'zzzzzzz')).toEqual([]);
  });

  it('round-trips segment text back to the original strings', () => {
    const out = fuzzyMatchSkills(SKILLS, '');
    expect(joinName(out[0])).toBe('generate-background');
    expect(joinDesc(out[0])).toBe('Generate a wide, opaque background/scene and add it to the Asset Board.');
  });
});
