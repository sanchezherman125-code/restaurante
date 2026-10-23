import { create } from "zustand";
import { useSession } from "./session";

/**
 * Mesa abierta en este dispositivo que aún no tiene pedido en el servidor.
 * El pedido se crea recién al enviar la primera comanda: abrir una mesa y salir no deja pedidos vacíos.
 */
export interface TableDraft {
  table_id: string;
  table_name: string;
  persons_count: number;
  created_at: number;
}

const STORAGE_KEY = "restaurante.tableDrafts";
const storageKey = () => `${STORAGE_KEY}.${useSession.getState().user?.id ?? "anonymous"}`;

function load(): Record<string, TableDraft> {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey()) ?? "{}") as Record<string, TableDraft>;
  } catch {
    return {};
  }
}

function save(drafts: Record<string, TableDraft>): void {
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(drafts));
  } catch { /* almacenamiento opcional */ }
}

interface TableDraftsState {
  drafts: Record<string, TableDraft>;
  open: (draft: TableDraft) => void;
  discard: (tableId: string) => void;
}

export const useTableDrafts = create<TableDraftsState>((set, get) => ({
  drafts: load(),
  open: (draft) => {
    const drafts = { ...get().drafts, [draft.table_id]: draft };
    save(drafts);
    set({ drafts });
  },
  discard: (tableId) => {
    const drafts = { ...get().drafts };
    delete drafts[tableId];
    save(drafts);
    set({ drafts });
  },
}));

useSession.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) useTableDrafts.setState({ drafts: load() });
});
