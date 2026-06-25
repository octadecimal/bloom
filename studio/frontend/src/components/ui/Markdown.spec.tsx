import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown seam', () => {
  it('renders a heading as <h1>', () => {
    const { container } = render(<Markdown source="# Title" />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
  });

  it('renders an unordered list as <li> items', () => {
    const { container } = render(<Markdown source={'- one\n- two'} />);
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('one');
  });

  it('renders a fenced code block as <pre><code>', () => {
    const { container } = render(<Markdown source={'```js\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  it('renders inline code as <code> outside any <pre>', () => {
    const { container } = render(<Markdown source="use `npm test` now" />);
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('npm test');
    expect(code?.closest('pre')).toBeNull();
  });

  it('renders a link that opens safely in a new tab', () => {
    const { container } = render(<Markdown source="[docs](https://example.com)" />);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
  });

  it('renders a GFM table', () => {
    const { container } = render(<Markdown source={'| a | b |\n| - | - |\n| 1 | 2 |'} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('does not execute embedded raw HTML (no injection hole)', () => {
    const { container } = render(<Markdown source={'<script>alert(1)</script><img src=x onerror="alert(2)">'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders partial/streaming markdown without throwing', () => {
    expect(() => render(<Markdown source={'# Head\n\n```js\nconst x = '} />)).not.toThrow();
    expect(() => render(<Markdown source={'**bold and '} />)).not.toThrow();
  });

  it('wraps output in the .bloom-md styling hook', () => {
    const { container } = render(<Markdown source="hi" />);
    expect(container.querySelector('.bloom-md')).not.toBeNull();
  });
});
