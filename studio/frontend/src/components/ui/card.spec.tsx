import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Card, CardHeader, CardContent, CardFooter } from './card';

describe('Card', () => {
  it('renders children and merges className', () => {
    const { getByText, container } = render(
      <Card className="extra">
        <CardHeader>H</CardHeader>
        <CardContent>C</CardContent>
        <CardFooter>F</CardFooter>
      </Card>,
    );
    expect(getByText('H')).toBeTruthy();
    expect(getByText('C')).toBeTruthy();
    expect(getByText('F')).toBeTruthy();
    expect(container.querySelector('.extra')).toBeTruthy();
  });
});
