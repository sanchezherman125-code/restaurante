import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ordersApi, tablesApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { errorMessage, sendOrQueue } from "../../lib/send";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useUi } from "../../stores/ui";

export function TablesPage() {
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const [pendingTable, setPendingTable] = useState<string | null>(null);
  const [persons, setPersons] = useState(2);
  const [creating, setCreating] = useState(false);
  const pendingRecords = usePendingOrders((state) => state.records);
  const addPending = usePendingOrders((state) => state.add);

  const tables = useQuery({ queryKey: ["tables"], queryFn: tablesApi.list });

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
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Salón</h2>
        <span className="hint">{tables.data?.length ?? 0} mesas</span>
      </div>

      {tables.data && tables.data.length === 0 ? (
        <EmptyState icon="🪑" title="No hay mesas registradas" hint="Un administrador debe cargarlas." />
      ) : (
        <div className="grid-3">
          {tables.data?.map((table) => {
            const pending = pendingRecords.find((record) => record.table_id === table.id && !record.server_order_id && !record.error);
            const isOpen = table.status === "OPEN" || !!pending;
            return (
              <button
                key={table.id}
                className={`table-tile ${isOpen ? "open" : ""}`}
                onClick={() => void openTable(table.id)}
                disabled={!table.is_active}
              >
                <span className="name">{table.name}</span>
                <span className="hint">N° {table.number}</span>
                <span className={`chip ${pending ? "warning" : isOpen ? "open" : "free"}`}>
                  {pending ? "⏳ pendiente" : isOpen ? "ocupada" : "libre"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {pendingTable ? (
        <Modal
          title={`Abrir mesa ${tables.data?.find((t) => t.id === pendingTable)?.name ?? ""}`}
          onClose={() => setPendingTable(null)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setPendingTable(null)}>
                Cancelar
              </button>
              <button className="btn grow" onClick={() => void confirmCreate()} disabled={creating}>
                {creating ? "Abriendo…" : "Abrir mesa"}
              </button>
            </>
          }
        >
          <div className="field">
            <label className="label">Cantidad de personas</label>
            <div className="qty-stepper">
              <button type="button" onClick={() => setPersons((n) => Math.max(1, n - 1))}>
                −
              </button>
              <span className="value">{persons}</span>
              <button type="button" onClick={() => setPersons((n) => Math.min(100, n + 1))}>
                +
              </button>
            </div>
          </div>
          <p className="hint">
            El pedido se abrirá con estado <strong>OPEN</strong> y quedará asociado a la mesa.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
