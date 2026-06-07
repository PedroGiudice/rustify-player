/// <reference types="vite/client" />

// O runtime Tauri injeta __TAURI__ no window. tauri.ts e store/tweaks.ts
// desestruturam window.__TAURI__.core/.event no load do modulo. Tipamos o
// minimo necessario (invoke/listen genericos) pra o typecheck enxergar os
// type-arguments; os wrappers de dominio vivem em tauri.ts.
interface Window {
  __TAURI__: {
    core: {
      invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
      convertFileSrc(filePath: string, protocol?: string): string;
    };
    event: {
      listen<T = unknown>(
        event: string,
        handler: (event: { payload: T }) => void,
      ): Promise<() => void>;
    };
    app?: any;
    window?: any;
  };
}
