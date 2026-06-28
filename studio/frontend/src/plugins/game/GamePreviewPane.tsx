import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { gameHooks } from './state';
import { sceneStore } from '../../scene/sceneStore';
import type { ISceneDocument } from '../../scene/types';
import { engineOrigin, backendOrigin } from './config';
import { ProtocolBridge, setBridge, clearBridge } from './protocolBridge';
import { emitSceneCaptureResult, emitSceneAddModule, emitSceneSpin } from './socketClient';

export function GamePreviewPane(_props: IDockviewPanelProps) {
  const s = gameHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!activeGameId) return;
    const frame = frameRef.current;
    if (!frame) return;
    const origin = engineOrigin();
    const bridge = new ProtocolBridge({
      engineOrigin: origin,
      post: (m, targetOrigin) => frame.contentWindow?.postMessage(m, targetOrigin),
      onCaptured: ({ id, png }) => emitSceneCaptureResult(activeGameId, id, png),
    });
    setBridge(bridge);

    const onMessage = (event: MessageEvent) => {
      bridge.handleEngineMessage(event.data, event.origin);
      // On the engine's first ready, init it from the current canonical document.
      if (event.origin === origin && event.data?.kind === 'ready') {
        const doc = sceneStore().document.get({ noproxy: true }) as ISceneDocument;
        bridge.init(doc);
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clearBridge(bridge);
    };
  }, [activeGameId]);

  if (!activeGameId) {
    return (
      <div data-testid="game-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to see its live scene.
      </div>
    );
  }

  const src = `${engineOrigin()}/?parentOrigin=${encodeURIComponent(window.location.origin)}&mediaBase=${encodeURIComponent(backendOrigin())}`;
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <button
          type="button"
          data-testid="game-add-reels"
          onClick={() => emitSceneAddModule(activeGameId)}
          className="rounded bg-raised px-2 py-1 text-text-1 hover:bg-raised-hover"
        >
          Add Reels
        </button>
        <button
          type="button"
          data-testid="game-spin"
          onClick={() => emitSceneSpin(activeGameId)}
          className="rounded bg-raised px-2 py-1 text-text-1 hover:bg-raised-hover"
        >
          Spin
        </button>
      </div>
      <iframe ref={frameRef} data-testid="game-engine-frame" title="Game scene preview" src={src} className="h-full w-full flex-1 border-0" />
    </div>
  );
}
