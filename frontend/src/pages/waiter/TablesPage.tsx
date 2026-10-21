import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ordersApi, shiftsApi, tablesApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { errorMessage, sendOrQueue } from "../../lib/send";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useUi } from "../../stores/ui";
import { formatElapsed, money, useElapsed } from "../../hooks/useElapsed";
import type { Order, RestaurantTable } from "../../types/api";

type OperationalTableState = "FREE" | "OPEN" | "INACTIVE";

function TableTile({
  table,
  pending,
  state,
  order,
  onOpen,
}: {
  table: RestaurantTable;
  pending: boolean;
  state: OperationalTableState;
  order?: Order;
  onOpen: (tableId: string) => void;
}) {
  const elapsed = useElapsed(order?.opened_at);
  const contextualDetails = order
    ? [order.opened_at ? formatElapsed(elapsed) : null, order.persons_count ? `${order.persons_count} pers.` : null, order.total ? money(order.total) : null]
        .filter(Boolean)
        .join(" · ")
    : "Pedido abierto";

  return (
    <button
      className={`table-tile ${state.toLowerCase()} ${pending ? "pending" : ""}`}
      onClick={() => onOpen(table.id)}
      disabled={state === "INACTIVE" || pending}
      aria-label={`${table.name}, ${state === "INACTIVE" ? "inactiva" : state === "OPEN" ? "ocupada" : "libre"}${pending ? ", sincronización pendiente" : ""}`}
    >
      <div className="table-card-topline">
        <span className="table-card-kicker">MESA</span>
        <div className="table-card-badges">
          <span className={`table-card-state ${state.toLowerCase()}`}>
            {state === "INACTIVE" ? "INACTIVA" : state === "OPEN" ? "OCUPADA" : "LIBRE"}
          </span>
          {pending ? <span className="table-sync-badge" aria-label="Sincronización pendiente" title="Sincronización pendiente">↻</span> : null}
        </div>
      </div>
      <span className="table-card-number">{String(table.number).padStart(2, "0")}</span>
      <span className="table-card-divider" />
      <span className="table-card-footer">
        <span className="table-card-copy">
          <strong>{table.name}</strong>
          <span>
            {pending
              ? "Guardado localmente · pendiente de sincronización"
              : state === "INACTIVE"
                ? "No disponible"
                : state === "OPEN"
                  ? contextualDetails
                  : "Toca para abrir"}
          </span>
        </span>
        <span className={`table-card-action ${state.toLowerCase()}`} aria-hidden="true">
          {state === "OPEN" ? "◷" : state === "INACTIVE" || pending ? "·" : "→"}
        </span>
      </span>
    </button>
  );
}

export function TablesPage() {
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const [pendingTable, setPendingTable] = useState<string | null>(null);
  const [persons, setPersons] = useState(2);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"ALL" | "FREE" | "OPEN" | "PENDING">("ALL");
  const pendingRecords = usePendingOrders((state) => state.records);
  const addPending = usePendingOrders((state) => state.add);

  const tables = useQuery({ queryKey: ["tables"], queryFn: tablesApi.list });
  const activeOrders = useQuery({ queryKey: ["orders", "active"], queryFn: () => ordersApi.active(), refetchInterval: 15000, retry: false });
  const currentShift = useQuery({ queryKey: ["shifts", "current"], queryFn: shiftsApi.current, retry: false });

  const tableRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("es-PE");
    return (tables.data ?? [])
      .map((table) => {
        const pending = pendingRecords.find((record) => record.table_id === table.id && !record.server_order_id && !record.error);
        const state: OperationalTableState = !table.is_active ? "INACTIVE" : table.status === "OPEN" || table.order_id ? "OPEN" : "FREE";
        return { table, pending, state };
      })
      .filter(({ table, pending, state }) => {
        const matchesFilter = filter === "ALL" || (filter === "FREE" && state === "FREE" && !pending) || (filter === "OPEN" && state === "OPEN") || (filter === "PENDING" && pending);
        const matchesQuery = !normalizedQuery || `${table.name} ${table.number}`.toLocaleLowerCase("es-PE").includes(normalizedQuery);
        return matchesFilter && matchesQuery;
      })
      .sort((a, b) => a.table.number - b.table.number);
  }, [filter, pendingRecords, query, tables.data]);

  const summary = useMemo(() => {
    const rows = (tables.data ?? []).map((table) => {
      const pending = pendingRecords.some((record) => record.table_id === table.id && !record.server_order_id && !record.error);
      return !table.is_active ? "INACTIVE" : table.status === "OPEN" || table.order_id ? "OPEN" : pending ? "PENDING" : "FREE";
    });
    return {
      free: rows.filter((state) => state === "FREE").length,
      open: rows.filter((state) => state === "OPEN").length,
      pending: rows.filter((state) => state === "PENDING").length,
    };
  }, [pendingRecords, tables.data]);

  if (tables.isLoading) return <Spinner label="Cargando mesas…" />;

  if (tables.isError) {
    return (
      <EmptyState
        icon="📡"
        title="No se pudo cargar el salón"
        hint="Verifique la conexión o intente de nuevo."
      />
    );
  }

  async function openTable(tableId: string) {
    const table = tables.data?.find((t) => t.id === tableId);
    if (!table) return;
    if (table.status === "OPEN" || table.order_id) {
      navigate(`/mesas/${tableId}`);
      return;
    }
    setPersons(2);
    setPendingTable(tableId);
  }

  async function confirmCreate() {
    if (!pendingTable) return;
    const table = tables.data?.find((t) => t.id === pendingTable);
    if (!table) return;
    setCreating(true);
    try {
      const outcome = await sendOrQueue(
        {
          operation_type: "CREATE_ORDER",
          path: "/api/v1/orders",
          method: "POST",
          body: {
            order_type: "DINE_IN",
            table_id: table.id,
            persons_count: persons,
            notes: null,
          },
        },
        (clientOperationId) =>
          ordersApi.create({
            order_type: "DINE_IN",
            table_id: table.id,
            persons_count: persons,
            notes: null,
            client_operation_id: clientOperationId,
          }, clientOperationId),
      );
      if (outcome.queued && outcome.operationId) {
        addPending({
          operation_id: outcome.operationId,
          table_id: table.id,
          table_name: table.name,
          persons_count: persons,
          created_at: Date.now(),
          server_order_id: null,
          error: null,
        });
      } else {
        toast("success", `Mesa ${table.name} abierta`);
      }
      setPendingTable(null);
      navigate(`/mesas/${table.id}`);
    } catch (error) {
      toast("error", "No se pudo abrir la mesa", errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="waiter-page tables-page stack">
      <div className="waiter-page-heading">
        <div>
          <span className={`shift-indicator ${currentShift.data ? "open" : ""}`}><span /> {currentShift.data ? "TURNO ABIERTO" : "OPERACIÓN / MESERO"}</span>
          <h1>Salón</h1>
          <p>Control de mesas en tiempo real</p>
        </div>
      </div>

      <div className="table-summary" aria-label="Resumen de mesas">
        <button className="table-summary-stat free" onClick={() => setFilter("FREE")} aria-pressed={filter === "FREE"}>
          <strong>{String(summary.free).padStart(2, "0")}</strong>
          <span>Libres</span>
        </button>
        <button className="table-summary-stat open" onClick={() => setFilter("OPEN")} aria-pressed={filter === "OPEN"}>
          <strong>{String(summary.open).padStart(2, "0")}</strong>
          <span>Ocupadas</span>
        </button>
        <button className="table-summary-stat pending" onClick={() => setFilter("PENDING")} aria-pressed={filter === "PENDING"}>
          <strong>{String(summary.pending).padStart(2, "0")}</strong>
          <span>Por enviar</span>
        </button>
      </div>

      <div className="table-controls">
        <div className="table-search-row">
          <label className="visually-hidden" htmlFor="table-search">Buscar mesa</label>
          <input
            id="table-search"
            className="input table-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar mesa…"
            type="search"
          />
          <span className="table-search-icon" aria-hidden="true">⌕</span>
          <button className="table-filter-button" aria-label="Filtrar mesas" onClick={() => document.querySelector<HTMLButtonElement>(".table-filter-row button")?.focus()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M7 12h10m-7 5h4" /></svg>
          </button>
        </div>
        <div className="table-section-heading">
          <span>MESAS DEL SALÓN</span>
          <span>{tables.data?.length ?? 0} en total</span>
        </div>
        <div className="table-filter-row" aria-label="Filtrar mesas">
          {(["ALL", "FREE", "OPEN"] as const).map((state) => (
            <button key={state} className={filter === state ? "active" : ""} onClick={() => setFilter(state)}>
              <span>{{ ALL: "Todas", FREE: "Libres", OPEN: "Ocupadas" }[state]}</span>
              <strong>{String(state === "ALL" ? (tables.data?.length ?? 0) : state === "FREE" ? summary.free : summary.open).padStart(2, "0")}</strong>
            </button>
          ))}
        </div>
      </div>

      {tables.data && tables.data.length === 0 ? (
        <EmptyState icon="🪑" title="No hay mesas registradas" hint="Un administrador debe cargarlas." />
      ) : (
        <div className="table-grid">
          {tableRows.map(({ table, pending, state }) => (
            <TableTile
              key={table.id}
              table={table}
              pending={!!pending}
              state={state}
              order={activeOrders.data?.find((activeOrder) => activeOrder.table_id === table.id)}
              onOpen={(tableId) => void openTable(tableId)}
            />
          ))}
        </div>
      )}

      {tableRows.length === 0 && tables.data && tables.data.length > 0 ? (
        <EmptyState icon="⌕" title="No encontramos mesas" hint="Prueba con otro nombre, número o filtro." />
      ) : null}

      {pendingTable ? (
        <Modal
          title={`Abrir ${tables.data?.find((t) => t.id === pendingTable)?.name ?? "mesa"}`}
          eyebrow="NUEVA ATENCIÓN"
          className="open-table-modal"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
              <circle cx="12" cy="7" r="3" />
              <path d="M4 20v-2a4 4 0 0 1 2-3.46M20 20v-2a4 4 0 0 0-2-3.46" />
            </svg>
          }
          onClose={() => setPendingTable(null)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setPendingTable(null)}>
                Cancelar
              </button>
              <button className="btn grow open-table-confirm" onClick={() => void confirmCreate()} disabled={creating}>
                {creating ? "Abriendo…" : <><span aria-hidden="true">→</span> Abrir mesa</>}
              </button>
            </>
          }
        >
          <div className="open-table-panel">
            <span className="eyebrow">CANTIDAD DE PERSONAS</span>
            <p className="open-table-helper">Selecciona cuántos comensales atenderás.</p>
            <div className="qty-stepper table-person-stepper">
              <button type="button" aria-label="Reducir personas" onClick={() => setPersons((n) => Math.max(1, n - 1))}>
                −
              </button>
              <span className="value">{String(persons).padStart(2, "0")} personas</span>
              <button type="button" aria-label="Aumentar personas" onClick={() => setPersons((n) => Math.min(100, n + 1))}>
                +
              </button>
            </div>
            <p className="open-table-note">El pedido quedará vinculado a {tables.data?.find((table) => table.id === pendingTable)?.name ?? "la mesa"}.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
