import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SyncIndicator } from "./SyncIndicator";
import { useQueue } from "../stores/queue";
import type { QueuedOperation } from "../types/api";

function op(status: QueuedOperation["status"], id: string): QueuedOperation {
  return {
    client_operation_id: id,
    operation_type: "REGISTER_EXPENSE",
    path: "/api/v1/expenses",
    method: "POST",
    body: {},
    parent_operation_id: null,
    created_at: Date.now(),
    attempt_count: 0,
    last_attempt_at: null,
    status,
    last_error: null,
  };
}

describe("SyncIndicator", () => {
  beforeEach(() => {
    useQueue.setState({ operations: [], flushing: false });
  });

  it("no muestra nada sin operaciones", () => {
    render(<SyncIndicator />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("muestra operaciones pendientes de envío", () => {
    useQueue.setState({ operations: [op("LOCAL_PENDING", "a"), op("SENDING", "b")] });
    render(<SyncIndicator />);
    expect(screen.getByRole("button")).toHaveTextContent("2 por enviar");
  });

  it("muestra errores de sincronización", () => {
    useQueue.setState({ operations: [op("SYNC_ERROR", "a")] });
    render(<SyncIndicator />);
    expect(screen.getByRole("button")).toHaveTextContent("con error");
  });

  it("muestra confirmación cuando todo está sincronizado", () => {
    useQueue.setState({ operations: [op("SYNCED", "a")] });
    render(<SyncIndicator />);
    expect(screen.getByRole("button")).toHaveTextContent("sincronizado");
  });
});
