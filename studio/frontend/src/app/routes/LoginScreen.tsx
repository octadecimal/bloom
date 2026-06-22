import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSession } from '../../session/SessionContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function LoginScreen() {
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [name, setName] = useState('');
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = name.trim();
    if (!t) return;
    login(t);
    navigate(from, { replace: true });
  }

  return (
    <div data-testid="login-screen" className="grid h-screen place-items-center bg-bg font-sans text-foreground">
      <Card className="w-72">
        <CardContent className="pt-2.5">
          <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
            <h1 className="m-0 text-base font-semibold">Bloom Studio</h1>
            <label htmlFor="username" className="text-xs text-muted-foreground">
              Your name
            </label>
            <Input id="username" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. ada" />
            <Button type="submit">Continue</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
