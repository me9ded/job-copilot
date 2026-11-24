import { createContext, useContext, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { ViewId } from '../lib/messages';
import { Button } from './components';

/**
 * chrome.permissions.request must run inside the click's user gesture, so it
 * is the first awaited call in the handler.
 */
export function PermissionButton({
  origins = [],
  permissions = [],
  label,
  onGranted,
  variant = 'primary',
}: {
  origins?: string[];
  permissions?: string[];
  label: string;
  onGranted?: () => void;
  variant?: 'primary' | 'secondary';
}) {
  const [denied, setDenied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant={variant}
        onClick={async () => {
          const ok = await browser.permissions.request({ origins, permissions: permissions as never[] });
          setDenied(!ok);
          if (ok) onGranted?.();
        }}
      >
        {label}
      </Button>
      {denied && <span className="text-[12px] text-bad">Permission was not granted.</span>}
    </span>
  );
}

export function useHasPermission(req: { origins?: string[]; permissions?: string[] }): boolean | undefined {
  const [has, setHas] = useState<boolean>();
  const key = JSON.stringify(req);
  useEffect(() => {
    let alive = true;
    const check = () =>
      browser.permissions
        .contains({ origins: req.origins ?? [], permissions: (req.permissions ?? []) as never[] })
        .then((v) => alive && setHas(v))
        .catch(() => alive && setHas(false));
    void check();
    browser.permissions.onAdded.addListener(check);
    browser.permissions.onRemoved.addListener(check);
    return () => {
      alive = false;
      browser.permissions.onAdded.removeListener(check);
      browser.permissions.onRemoved.removeListener(check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return has;
}

/* ----------------------------------------------------------------------------
 * In-app navigation
 * ------------------------------------------------------------------------- */

export interface Nav {
  view: ViewId;
  jobId: string | null;
  go(view: ViewId, jobId?: string | null): void;
  layout: 'panel' | 'full';
}

export const NavCtx = createContext<Nav>({ view: 'current', jobId: null, go: () => undefined, layout: 'panel' });
export const useNav = () => useContext(NavCtx);
