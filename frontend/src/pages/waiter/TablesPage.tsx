import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ordersApi, shiftsApi, tablesApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import { EmptyState, PageHeader, SearchField, SkeletonList } from "../../components/Layout";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useTableDrafts } from "../../stores/tableDrafts";
import { useUi } from "../../stores/ui";
import { formatElapsed, money, useElapsed } from "../../hooks/useElapsed";
import type { Order, RestaurantTable } from "../../types/api";

type OperationalTableState = "FREE" | "OPEN" | "INACTIVE";

/** Resumen real del avance del pedido: lo que el mesero necesita saber sin abrir la mesa. */
function orderProgress(order?: Order): { ready: number; preparing: number; pending: number } {
  const items = (order?.items ?? []).filter((item) => item.status !== "CANCELLED" && item.status !== "DELIVERED");
  return {
    ready: items.filter((item) => item.status === "READY").length,
    preparing: items.filter((item) => item.status === "PREPARING").length,
    pending: items.filter((item) => item.status === "PENDING").length,
  };
}

function TableTile({ table, pending, draft, state, order, onOpen }: {
  table: RestaurantTable; pending: boolean; draft: boolean; state: OperationalTableState; order?: Order; onOpen: (tableId: string) => void;
}) {
  const elapsed = useElapsed(order?.opened_at);
  const progress = orderProgress(order);
  const stateLabel = state === "INACTIVE" ? "inactiva" : state === "OPEN" ? "ocupada" : "libre";
  const tone = pending ? "pending" : progress.ready > 0 ? "ready" : draft && state === "FREE" ? "draft" : state.toLowerCase();

  return (
    <button
      className={`table-tile ${tone}`}
      data-state={state.toLowerCase()}
      onClick={() => onOpen(table.id)}
      disabled={state === "INACTIVE" || pending}
      aria-label={`${table.name}, ${stateLabel}${progress.ready > 0 ? `, ${progress.ready} listo para entregar` : ""}${pending ? ", sincronización pendiente" : ""}`}
    >
      <span className="table-top">
        <span className="table-number num">{String(table.number).padStart(2, "0")}</span>
        {pending ? <span className="chip warning"><Icon name="cloud" />Sin enviar</span>
          : progress.ready > 0 ? <span className="chip success"><Icon name="check" />{progress.ready} listo{progress.ready > 1 ? "s" : ""}</span>
          : state === "OPEN" ? <span className="chip ember"><Icon name="user" />Ocupada</span>
          : draft ? <span className="chip warning"><Icon name="note" />Sin pedido</span>
          : state === "INACTIVE" ? <span className="chip"><Icon name="ban" />Inactiva</span>
          : <span className="chip free"><Icon name="chair" />Libre</span>}
      </span>
      <span className="table-name">{table.name}</span>
      <span className="table-meta">
        {pending ? "Guardada en este dispositivo, aún no llegó al servidor"
          : state === "OPEN" && order ? (
            <>
              <span><Icon name="clock" />{formatElapsed(elapsed)}</span>
              {order.persons_count ? <span><Icon name="users" />{order.persons_count}</span> : null}
              <strong className="num">{money(order.total)}</strong>
            </>
          ) : state === "OPEN" ? "Pedido abierto"
          : state === "INACTIVE" ? "No disponible"
          : draft ? "Abierta en este dispositivo, aún sin comanda" : "Toque para abrir"}
      </span>
      {state === "OPEN" && !pending && (progress.preparing > 0 || progress.pending > 0) ? (
        <span className="table-progress">
          {progress.preparing > 0 ? <span className="chip info"><Icon name="flame" />{progress.preparing} preparando</span> : null}
          {progress.pending > 0 ? <span className="chip warning"><Icon name="hourglass" />{progress.pending} pendiente{progress.pending > 1 ? "s" : ""}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

export function TablesPage() {
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const [pendingTable, setPendingTable] = useState<string | null>(null);
  const [persons, setPersons] = useState(2);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"ALL" | "FREE" | "OPEN" | "PENDING">("ALL");
  const pendingRecords = usePendingOrders((state) => state.records);
  const drafts = useTableDrafts((state) => state.drafts);
  const openDraft = useTableDrafts((state) => state.open);

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

  if (tables.isLoading) return <div className="page"><PageHeader title="Salón" /><SkeletonList rows={6} height={110} label="Cargando mesas" /></div>;

  if (tables.isError) {
    return (
      <EmptyState
        icon="wifiOff"
        title="No se pudo cargar el salón"
        hint="Verifique la conexión o intente de nuevo."
      />
    );
  }

  async function openTable(tableId: string) {
    const table = tables.data?.find((t) => t.id === tableId);
    if (!table) return;
    if (table.status === "OPEN" || table.order_id || drafts[tableId]) {
      navigate(`/mesas/${tableId}`);
      return;
    }
    if (!currentShift.data) {
      toast("error", "No hay un turno abierto", "Pida a un administrador que abra el turno para atender mesas.");
      return;
    }
    setPersons(2);
    setPendingTable(tableId);
  }

  function confirmCreate() {
    if (!pendingTable) return;
    const table = tables.data?.find((t) => t.id === pendingTable);
    if (!table) return;
    // Solo se abre localmente: el pedido nace en el servidor con la primera comanda enviada.
    openDraft({ table_id: table.id, table_name: table.name, persons_count: persons, created_at: Date.now() });
    setPendingTable(null);
    navigate(`/mesas/${table.id}`);
  }

  const openTables = (tables.data ?? []).length;
  return (
    <div className="page">
      <PageHeader
        title="Salón"
        subtitle={currentShift.data ? "Turno abierto · estado de las mesas en tiempo real" : "No hay un turno abierto: pida a un administrador que lo abra"}
        actions={<SearchField value={query} onChange={setQuery} label="Buscar mesa" placeholder="Buscar mesa" hotkey />}
      />

      <div className="table-filter-row" role="group" aria-label="Filtrar mesas">
        <div className="segmented">
          {(["ALL", "FREE", "OPEN"] as const).map((state) => (
            <button key={state} className={filter === state ? "active" : ""} aria-pressed={filter === state} onClick={() => setFilter(state)}>
              {{ ALL: "Todas", FREE: "Libres", OPEN: "Ocupadas" }[state]}
              <span className="count">{state === "ALL" ? openTables : state === "FREE" ? summary.free : summary.open}</span>
            </button>
          ))}
          {summary.pending > 0 ? (
            <button className={filter === "PENDING" ? "active" : ""} aria-pressed={filter === "PENDING"} onClick={() => setFilter("PENDING")}>
              Por enviar<span className="count">{summary.pending}</span>
            </button>
          ) : null}
        </div>
      </div>

      {tables.data && tables.data.length === 0 ? (
        <EmptyState icon="chair" title="No hay mesas registradas" hint="Un administrador debe cargarlas en Mesas." />
      ) : (
        <div className="table-grid">
          {tableRows.map(({ table, pending, state }) => (
            <TableTile
              key={table.id}
              table={table}
              pending={!!pending}
              draft={Boolean(drafts[table.id])}
              state={state}
              order={activeOrders.data?.find((activeOrder) => activeOrder.table_id === table.id)}
              onOpen={(tableId) => void openTable(tableId)}
            />
          ))}
        </div>
      )}

      {tableRows.length === 0 && tables.data && tables.data.length > 0 ? (
        <EmptyState icon="search" title="No encontramos mesas" hint="Pruebe con otro nombre, número o filtro." />
      ) : null}

      {pendingTable ? (
        <Modal
          title={`Abrir ${tables.data?.find((t) => t.id === pendingTable)?.name ?? "mesa"}`}
          onClose={() => setPendingTable(null)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setPendingTable(null)}>Cancelar</button>
              <button className="btn grow" onClick={confirmCreate}>Abrir mesa</button>
            </>
          }
        >
          <div className="stack" style={{ gap: "var(--s3)" }}>
            <div className="hint">¿Cuántas personas se sientan?</div>
            <div className="qty-stepper table-person-stepper" style={{ alignSelf: "center" }}>
              <button type="button" aria-label="Reducir personas" onClick={() => setPersons((n) => Math.max(1, n - 1))}>−</button>
              <span className="value" style={{ minWidth: "7rem" }}>{persons} {persons === 1 ? "persona" : "personas"}</span>
              <button type="button" aria-label="Aumentar personas" onClick={() => setPersons((n) => Math.min(100, n + 1))}>+</button>
            </div>
            <div className="quick-numbers" role="group" aria-label="Cantidad rápida">
              {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                <button key={n} type="button" className={persons === n ? "active" : ""} aria-pressed={persons === n} onClick={() => setPersons(n)}>{n}</button>
              ))}
            </div>
            <p className="hint">El pedido se crea al enviar la primera comanda; si sale sin pedir nada, la mesa sigue libre.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
