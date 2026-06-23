import Fuse from 'fuse.js';
import type { ISkill } from './state';

/** One run of text in a rendered match, flagged as matched (highlight) or not. */
export interface IFuzzySegment {
  text: string;
  matched: boolean;
}

/** A skill that matched the query, with pre-split highlight segments and score. */
export interface ISkillMatch {
  skill: ISkill;
  nameSegments: IFuzzySegment[];
  descSegments: IFuzzySegment[];
  score: number;
}

/** Whole string as a single unmatched segment (or [] for an empty string). */
function plainSegments(text: string): IFuzzySegment[] {
  return text.length > 0 ? [{ text, matched: false }] : [];
}

/** Rank skills against `query`, best match first, with highlight segments. */
export function fuzzyMatchSkills(skills: ISkill[], query: string): ISkillMatch[] {
  const q = query.trim();
  if (q === '') {
    return skills.map((skill) => ({
      skill,
      nameSegments: plainSegments(skill.name),
      descSegments: plainSegments(skill.description),
      score: 0,
    }));
  }
  // Fuse wiring added in the next task.
  return [];
}
