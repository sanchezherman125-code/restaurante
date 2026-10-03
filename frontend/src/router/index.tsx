import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppLayout } from "../layouts/AppLayout";
import { useSession } from "../stores/session";
import type { Role } from "../types/api";
import { LoginPage } from "../pages/LoginPage";
import { TablesPage } from "../pages/waiter/TablesPage";
import { TableOrderPage } from "../pages/waiter/TableOrderPage";
import { ActiveOrdersPage } from "../pages/waiter/ActiveOrdersPage";
import { BillingPage } from "../pages/BillingPage";
import { BoardPage } from "../pages/BoardPage";
import { ExpensesPage } from "../pages/ExpensesPage";
import { PurchaseListPage } from "../pages/PurchaseListPage";
import { DashboardPage } from "../pages/admin/DashboardPage";
import { ShiftsPage } from "../pages/admin/ShiftsPage";
import { ReportsPage } from "../pages/admin/ReportsPage";
import { HistoryPage } from "../pages/admin/HistoryPage";
import { UsersPage } from "../pages/admin/UsersPage";
import { MenuAdminPage } from "../pages/admin/MenuAdminPage";
import { TablesAdminPage } from "../pages/admin/TablesAdminPage";
import { MorePage } from "../pages/admin/MorePage";

const HOME_BY_ROLE: Record<Role, string> = {
  WAITER: "/mesas",
  KITCHEN: "/comandas",
  GRILL: "/comandas",
  ADMIN: "/panel",
};

function RequireRole({ roles, children }: { roles: Role[]; children: React.ReactElement }) {
  const user = useSession((state) => state.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!roles.includes(user.role)) return <Navigate to={HOME_BY_ROLE[user.role]} replace />;
  return children;
}

export function AppRouter() {
  const user = useSession((state) => state.user);
  const initialized = useSession((state) => state.initialized);

  if (!initialized) {
    return (
      <div className="center" style={{ height: "100%" }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="/"
        element={
          user ? (
            <RequireRole roles={["WAITER", "KITCHEN", "GRILL", "ADMIN"]}>
              <AppLayout />
            </RequireRole>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      >
        <Route index element={<Navigate to={user ? HOME_BY_ROLE[user.role] : "/login"} replace />} />

        <Route path="mesas" element={<RequireRole roles={["WAITER", "ADMIN"]}><TablesPage /></RequireRole>} />
        <Route path="mesas/:tableId" element={<RequireRole roles={["WAITER", "ADMIN"]}><TableOrderPage /></RequireRole>} />
        <Route path="pedidos" element={<RequireRole roles={["WAITER", "ADMIN"]}><ActiveOrdersPage /></RequireRole>} />
        <Route path="cobro/:orderId" element={<RequireRole roles={["WAITER", "ADMIN"]}><BillingPage /></RequireRole>} />
        <Route path="comandas" element={<RequireRole roles={["KITCHEN", "GRILL", "ADMIN"]}><BoardPage /></RequireRole>} />
        <Route path="gastos" element={<ExpensesPage />} />
        <Route path="compras" element={<RequireRole roles={["KITCHEN", "GRILL", "ADMIN"]}><PurchaseListPage /></RequireRole>} />

        <Route path="panel" element={<RequireRole roles={["ADMIN"]}><DashboardPage /></RequireRole>} />
        <Route path="turnos" element={<RequireRole roles={["ADMIN"]}><ShiftsPage /></RequireRole>} />
        <Route path="reportes" element={<RequireRole roles={["ADMIN"]}><ReportsPage /></RequireRole>} />
        <Route path="historial" element={<RequireRole roles={["ADMIN"]}><HistoryPage /></RequireRole>} />
        <Route path="usuarios" element={<RequireRole roles={["ADMIN"]}><UsersPage /></RequireRole>} />
        <Route path="carta" element={<RequireRole roles={["ADMIN"]}><MenuAdminPage /></RequireRole>} />
        <Route path="admin/mesas" element={<RequireRole roles={["ADMIN"]}><TablesAdminPage /></RequireRole>} />
        <Route path="mas" element={<RequireRole roles={["ADMIN"]}><MorePage /></RequireRole>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
