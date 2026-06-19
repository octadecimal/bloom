// Temporary Button probe removed in Task 9 when layout components replace it
import { Button } from '@/components/ui/button';

export function Workbench() {
  return (
    <div data-testid="workbench" style={{ height: '100vh' }}>
      <h1>Bloom Studio</h1>
      <Button data-testid="probe-button">Click</Button>
    </div>
  );
}
