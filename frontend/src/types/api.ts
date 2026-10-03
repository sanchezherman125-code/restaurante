export type Role = "WAITER" | "KITCHEN" | "GRILL" | "ADMIN";
export type PreparationArea = "KITCHEN" | "GRILL" | "WAITER";
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";
export type OrderStatus =
  | "OPEN"
  | "IN_PREPARATION"
  | "READY"
  | "DELIVERED"
  | "PAID"
  | "CLOSED";
export type ItemStatus = "PENDING" | "PREPARING" | "READY" | "DELIVERED" | "CANCELLED";
export type PaymentMethod = "CASH" | "YAPE" | "PLIN" | "CARD" | "OTHER";
export type SplitType = "BY_ITEMS" | "BY_AMOUNT";
export type AvailabilityStatus = "AVAILABLE" | "SOLD_OUT";
export type ShiftStatus = "OPEN" | "CLOSED";

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface RestaurantTable {
  id: string;
  name: string;
  number: number;
  is_active: boolean;
  status: "FREE" | "OPEN";
  order_id: string | null;
}

export interface MenuCategory {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price: string;
  requires_preparation: boolean;
  preparation_area: PreparationArea | null;
  expected_prep_minutes: number | null;
  is_available: boolean;
  is_active: boolean;
  availability_status: AvailabilityStatus;
}

export interface Menu {
  categories: MenuCategory[];
  items: MenuItem[];
}

export interface OrderItem {
  id: string;
  command_id: string;
  order_id: string;
  menu_item_id: string;
  menu_item_name_snapshot: string;
  unit_price_snapshot: string;
  quantity: number;
  requires_preparation: boolean;
  preparation_area: PreparationArea | null;
  status: ItemStatus;
  notes: string | null;
  replacement_description: string | null;
  expected_prep_minutes_snapshot: number | null;
  preparation_started_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancelled_after_preparation_started: boolean;
  cancellation_reason: string | null;
  created_at: string;
  line_total?: string;
}

export interface Command {
  id: string;
  order_id: string;
  sequence_number: number;
  notes: string | null;
  created_at: string;
  items: OrderItem[];
}

export interface OrderSummary {
  id: string;
  shift_id: string;
  table_id: string | null;
  table_name: string | null;
  table_number: number | null;
  order_type: OrderType;
  persons_count: number | null;
  created_by_waiter_id: string;
  created_by_waiter_name: string | null;
  status: OrderStatus;
  notes: string | null;
  subtotal: string;
  total: string;
  paid_amount: string;
  opened_at: string;
  paid_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Order extends OrderSummary {
  items: OrderItem[];
  commands: Command[];
}

export interface ItemGroup {
  order_id: string;
  command_id: string;
  sequence_number: number;
  table_name: string | null;
  table_number: number | null;
  order_type: OrderType;
  persons_count: number | null;
  notes: string | null;
  command_notes: string | null;
  created_at: string;
  waiter_name: string | null;
  items: OrderItem[];
  other_areas: Record<string, string>;
  order_general_status: string;
  elapsed_seconds: number;
}

export interface Split {
  id: string;
  order_id: string;
  split_type: SplitType;
  label: string | null;
  amount: string;
  created_at: string;
}

export interface Payment {
  id: string;
  order_id: string;
  split_id: string | null;
  method: PaymentMethod;
  amount: string;
  paid_at: string;
}

export interface BillingItem {
  order_item_id: string;
  name: string;
  quantity: number;
  unit_price: string;
  total: string;
  status: ItemStatus;
  split_quantity: number;
}

export interface Billing {
  order_id: string;
  table_name: string | null;
  table_number: number | null;
  status: OrderStatus | string;
  items: BillingItem[];
  subtotal: string;
  total: string;
  paid_amount: string;
  pending_amount: string;
  splits: Split[];
  payments: Payment[];
}

export interface Expense {
  id: string;
  shift_id: string;
  created_by_user_id: string;
  created_by_name: string | null;
  amount: string;
  description: string;
  receipt_url: string | null;
  created_at: string;
}

export interface PurchaseItem {
  id: string;
  shift_id: string;
  area: PreparationArea;
  description: string;
  quantity_text: string | null;
  created_by_user_id: string;
  created_at: string;
}

export interface Shift {
  id: string;
  opened_at: string;
  opened_by: string;
  closed_at: string | null;
  closed_by: string | null;
  status: ShiftStatus;
  snapshot: Record<string, unknown> | null;
}

export interface SalesReport {
  total_sales: string;
  total_expenses: string;
  net_result: string;
  orders_count: number;
  tables_served: number;
  persons_served: number;
  sales_by_waiter: Record<string, string>;
  sales_by_payment_method: Record<string, string>;
}

export interface ProductLine {
  menu_item_id: string | null;
  name: string;
  quantity: number;
  revenue: string;
}

export interface ProductsReport {
  lines: ProductLine[];
  total_items_sold: number;
}

export interface PreparationLine {
  area: string;
  average_seconds: number | null;
  items_measured: number;
  within_expected_percent: number | null;
}

export interface PreparationReport {
  lines: PreparationLine[];
  average_seconds: number | null;
}

export interface ShiftReport {
  shift_id: string;
  opened_at: string | null;
  closed_at: string | null;
  status: string;
  sales: SalesReport;
  products: ProductsReport;
  preparation: PreparationReport;
  expenses: { id: string; amount: string; description: string; receipt_url: string | null }[];
  purchase_list: { id: string; area: string; description: string; quantity_text: string | null }[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

export type SyncStatus = "LOCAL_PENDING" | "SENDING" | "SYNCED" | "SYNC_ERROR";

export interface QueuedOperation {
  client_operation_id: string;
  operation_type:
    | "CREATE_ORDER"
    | "CREATE_COMMAND"
    | "ADD_ORDER_ITEM"
    | "CANCEL_ORDER_ITEM"
    | "UPDATE_ORDER_ITEM_STATUS"
    | "REGISTER_EXPENSE";
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body: unknown;
  parent_operation_id: string | null;
  created_at: number;
  attempt_count: number;
  last_attempt_at: number | null;
  status: SyncStatus;
  last_error: string | null;
  server_resource_id?: string | null;
}
