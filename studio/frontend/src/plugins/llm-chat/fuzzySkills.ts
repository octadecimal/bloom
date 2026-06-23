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

/** Build segments from a string and inclusive [start,end] match ranges (Fuse format). */
function segmentsFromIndices(text: string, ranges: ReadonlyArray<readonly [number, number]>): IFuzzySegment[] {
  if (ranges.length === 0) return plainSegments(text);
  const matched = new Array<boolean>(text.length).fill(false);
  for (const [start, end] of ranges) {
    for (let i = start; i <= end && i < text.length; i++) matched[i] = true;
  }
  const segments: IFuzzySegment[] = [];
  let i = 0;
  while (i < text.length) {
    const flag = matched[i];
    let j = i + 1;
    while (j < text.length && matched[j] === flag) j++;
    segments.push({ text: text.slice(i, j), matched: flag });
    i = j;
  }
  return segments;
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

  const fuse = new Fuse(skills, {
    keys: [
      { name: 'name', weight: 0.7 },
      { name: 'description', weight: 0.3 },
    ],
    includeMatches: true,
    includeScore: true,
    ignoreLocation: true, // short command names: don't penalize match position
    threshold: 0.4, // fuzziness ceiling
    minMatchCharLength: 1,
  });

  return fuse.search(q).map((r) => {
    const nameRanges = r.matches?.find((m) => m.key === 'name')?.indices ?? [];
    const descRanges = r.matches?.find((m) => m.key === 'description')?.indices ?? [];
    return {
      skill: r.item,
      nameSegments: segmentsFromIndices(r.item.name, nameRanges),
      descSegments: segmentsFromIndices(r.item.description, descRanges),
      score: r.score ?? 0,
    };
  });
}
