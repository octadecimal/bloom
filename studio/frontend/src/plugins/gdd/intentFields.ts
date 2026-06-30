// Mirrors the intent fields in studio/backend/app/gdd/schemas.py (theme.art_direction,
// ui-ux.layout + the three Scene-Blueprint enums). The enums are stable; if the backend
// schema changes, update this descriptor.
export interface IIntentField {
  key: string;
  label: string;
  control: 'textarea' | 'select';
  options?: string[];
}

export const INTENT_FIELDS: Record<string, IIntentField[]> = {
  theme: [{ key: 'art_direction', label: 'Art direction', control: 'textarea' }],
  'ui-ux': [
    { key: 'layout', label: 'Layout', control: 'textarea' },
    {
      key: 'orientation',
      label: 'Orientation',
      control: 'select',
      options: ['portrait', 'landscape'],
    },
    {
      key: 'focal_emphasis',
      label: 'Focal emphasis',
      control: 'select',
      options: ['reels', 'logo', 'balanced'],
    },
    {
      key: 'framing_density',
      label: 'Framing density',
      control: 'select',
      options: ['clean', 'moderate', 'ornate'],
    },
  ],
};
