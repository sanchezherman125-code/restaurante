import { api, apiRequest } from "./client";
import type {
  Billing,
  Command,
  Expense,
  ItemGroup,
  Menu,
  Order,
  Payment,
  PurchaseItem,
  RestaurantTable,
  SalesReport,
  Shift,
  ShiftReport,
  Split,
  Tokens,
  User,
} from "../types/api";

const V1 = "/api/v1";

export const authApi = {
  login: (username: string, pin: string, deviceId: string) =>
    api.post<Tokens>(`${V1}/auth/login`, { username, pin, device_id: deviceId }, { auth: false }),
  logout: () => api.post<void>(`${V1}/auth/logout`),
  me: () => api.get<User>(`${V1}/auth/me`),
};

export const tablesApi = {
  list: () => api.get<RestaurantTable[]>(`${V1}/tables`),
  create: (body: { name: string; number: number }) => api.post<RestaurantTable>(`${V1}/tables`, body),
  update: (id: string, body: Partial<{ name: string; number: number; is_active: boolean }>) =>
    api.patch<RestaurantTable>(`${V1}/tables/${id}`, body),
};

export const menuApi = {
  get: () => api.get<Menu>(`${V1}/menu`),
  createCategory: (body: { name: string; sort_order?: number }) =>
    api.post(`${V1}/menu/categories`, body),
  updateCategory: (id: string, body: Record<string, unknown>) =>
    api.patch(`${V1}/menu/categories/${id}`, body),
  createItem: (body: Record<string, unknown>) => api.post(`${V1}/menu/items`, body),
  updateItem: (id: string, body: Record<string, unknown>) => api.patch(`${V1}/menu/items/${id}`, body),
  setAvailability: (id: string, status: "AVAILABLE" | "SOLD_OUT") =>
    api.patch(`${V1}/menu/items/${id}/availability`, { status }),
};

export interface CreateOrderPayload {
  order_type: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
  table_id?: string | null;
  persons_count?: number | null;
  notes?: string | null;
  client_operation_id?: string;
}

export interface CommandPayload {
  items: { menu_item_id: string; quantity: number; notes?: string | null; replacement_description?: string | null }[];
  notes?: string | null;
  client_operation_id?: string;
}

export const ordersApi = {
  active: (area?: string) => api.get<Order[]>(`${V1}/orders/active${area ? `?area=${area}` : ""}`),
  get: (id: string) => api.get<Order>(`${V1}/orders/${id}`),
  create: (payload: CreateOrderPayload, idempotencyKey?: string) =>
    api.post<Order>(`${V1}/orders`, payload, { idempotencyKey }),
  createCommand: (orderId: string, payload: CommandPayload, clientOperationId?: string) =>
    api.post<Command & { order: Order }>(
      `${V1}/orders/${orderId}/commands`,
      { ...payload, ...(clientOperationId ? { client_operation_id: clientOperationId } : {}) },
      { idempotencyKey: clientOperationId },
    ),
  addItems: (orderId: string, payload: CommandPayload) =>
    api.post<Command & { order: Order }>(`${V1}/orders/${orderId}/items`, payload),
  updateItem: (orderId: string, itemId: string, body: Record<string, unknown>) =>
    api.patch<Order>(`${V1}/orders/${orderId}/items/${itemId}`, body),
  cancelItem: (orderId: string, itemId: string, reason?: string) =>
    api.post<Order>(`${V1}/orders/${orderId}/items/${itemId}/cancel`, { reason }),
  setItemStatus: (orderId: string, itemId: string, status: string, clientOperationId?: string) =>
    api.post<Order>(
      `${V1}/orders/${orderId}/items/${itemId}/status`,
      { status, ...(clientOperationId ? { client_operation_id: clientOperationId } : {}) },
      { idempotencyKey: clientOperationId },
    ),
};

export const preparationApi = {
  kitchen: () => api.get<ItemGroup[]>(`${V1}/preparation/kitchen`),
  grill: () => api.get<ItemGroup[]>(`${V1}/preparation/grill`),
};

export const billingApi = {
  get: (orderId: string) => api.get<Billing>(`${V1}/orders/${orderId}/billing`),
  createSplit: (orderId: string, body: Record<string, unknown>) =>
    api.post<Split>(`${V1}/orders/${orderId}/splits`, body),
  createPayment: (orderId: string, body: Record<string, unknown>) =>
    api.post<Payment & { order_status: string; became_paid: boolean }>(
      `${V1}/orders/${orderId}/payments`,
      body,
    ),
  payments: (orderId: string) => api.get<Payment[]>(`${V1}/orders/${orderId}/payments`),
};

export const expensesApi = {
  currentShift: () => api.get<Expense[]>(`${V1}/expenses/current-shift`),
  history: (shiftId?: string) =>
    api.get<Expense[]>(`${V1}/expenses${shiftId ? `?shift_id=${shiftId}` : ""}`),
  create: (body: { amount: string; description: string; receipt_url?: string | null }) =>
    api.post<Expense>(`${V1}/expenses`, body),
};

export const purchaseApi = {
  current: () => api.get<PurchaseItem[]>(`${V1}/purchase-list/current`),
  create: (body: { area: string; description: string; quantity_text?: string | null }) =>
    api.post<PurchaseItem>(`${V1}/purchase-list`, body),
  remove: (id: string) => api.delete<void>(`${V1}/purchase-list/${id}`),
};

export const shiftsApi = {
  current: () => api.get<Shift | null>(`${V1}/shifts/current`),
  open: () => api.post<Shift>(`${V1}/shifts/open`),
  close: (id: string) => api.post<Shift>(`${V1}/shifts/${id}/close`),
  history: (params?: { date_from?: string; date_to?: string; waiter_id?: string }) => {
    const query = new URLSearchParams();
    if (params?.date_from) query.set("date_from", params.date_from);
    if (params?.date_to) query.set("date_to", params.date_to);
    if (params?.waiter_id) query.set("waiter_id", params.waiter_id);
    const qs = query.toString();
    return api.get<Shift[]>(`${V1}/shifts/history${qs ? `?${qs}` : ""}`);
  },
  report: (id: string) => api.get<ShiftReport>(`${V1}/shifts/${id}/report`),
};

export const reportsApi = {
  currentShift: () => api.get<SalesReport>(`${V1}/reports/current-shift`),
  sales: (params?: Record<string, string>) => {
    const qs = params ? new URLSearchParams(params).toString() : "";
    return api.get<SalesReport>(`${V1}/reports/sales${qs ? `?${qs}` : ""}`);
  },
  products: (params?: Record<string, string>) => {
    const qs = params ? new URLSearchParams(params).toString() : "";
    return api.get<{ lines: { name: string; quantity: number; revenue: string }[]; total_items_sold: number }>(
      `${V1}/reports/products${qs ? `?${qs}` : ""}`,
    );
  },
  preparation: (params?: Record<string, string>) => {
    const qs = params ? new URLSearchParams(params).toString() : "";
    return api.get<{ lines: { area: string; average_seconds: number | null; items_measured: number }[]; average_seconds: number | null }>(
      `${V1}/reports/preparation${qs ? `?${qs}` : ""}`,
    );
  },
  shift: (id: string) => api.get<ShiftReport>(`${V1}/reports/shifts/${id}`),
};

export const usersApi = {
  list: () => api.get<User[]>(`${V1}/users`),
  create: (body: { username: string; pin: string; display_name: string; role: string }) =>
    api.post<User>(`${V1}/users`, body),
  update: (id: string, body: Record<string, unknown>) => api.patch<User>(`${V1}/users/${id}`, body),
  disable: (id: string) => api.post<User>(`${V1}/users/${id}/disable`),
};

export async function uploadReceipt(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiRequest<{ url: string }>(`${V1}/receipts`, { method: "POST", formData });
}
