// studio/frontend/src/plugins/assets/viewConfig.ts
// Presentation tokens per asset-board view mode. AssetCard is a thin renderer
// that looks up its layout/chrome here, so the modes live in one data-driven map.

export type AssetViewMode = 'small' | 'medium' | 'large' | 'list';

export interface IAssetViewConfig {
  /** Tailwind classes for the grid/list container that wraps all cards. */
  container: string;
  /** Tailwind classes applied to each card root (width, or row layout). */
  card: string;
  /** Tailwind classes for the selected-image box (height, and size in list). */
  image: string;
  /** Show the workflow tag in the card header. */
  showWorkflow: boolean;
  /** Render the candidate-seed strip inline. */
  showCandidates: boolean;
  /** 'always' = footer actions always rendered; 'hover' = only while hovered. */
  actions: 'always' | 'hover';
  /** Lay the card out as a horizontal row (List view). */
  row: boolean;
}

export const VIEW_MODES: AssetViewMode[] = ['small', 'medium', 'large', 'list'];

export const VIEW_CONFIG: Record<AssetViewMode, IAssetViewConfig> = {
  small: { container: 'flex flex-wrap gap-2', card: 'w-24', image: 'h-20', showWorkflow: false, showCandidates: false, actions: 'hover', row: false },
  medium: { container: 'flex flex-wrap gap-2.5', card: 'w-36', image: 'h-28', showWorkflow: false, showCandidates: false, actions: 'hover', row: false },
  large: { container: 'flex flex-wrap gap-2.5', card: 'w-56', image: 'h-32', showWorkflow: true, showCandidates: true, actions: 'always', row: false },
  list: { container: 'flex flex-col gap-1', card: 'w-full', image: 'h-10 w-10', showWorkflow: true, showCandidates: false, actions: 'always', row: true },
};
